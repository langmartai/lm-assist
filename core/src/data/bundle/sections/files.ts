/**
 * Section 3 — opt-in `files` sections (spec §3):
 *
 *   knowledge      <dataDir>/knowledge/: *.md, index.json, settings.json, comments/** (never remote/)
 *   claude-memory  ~/.claude/projects/<slug>/memory/**\/*.md — written only when the project dir
 *                  <slug> already exists on this host, otherwise `unknown-project`
 *   claude-rules   ~/.claude/rules/*.md, excluding synced.* (mirrors of another node's rules)
 *
 * Files travel as UTF-8 text with their sha256. Collect skips (and reports) files over 5 MiB,
 * binary files (a NUL in the first 8 KB) and anything that is not valid UTF-8, and never follows
 * a symlink. Import is `add-missing` by relative path unless the policy is `replace` (`merge`
 * behaves as add-missing: a file has no version to compare). `replace` on claude-memory/rules
 * copies the old file to `<file>.bak-import-<ts>` first.
 *
 * Every incoming path is untrusted: it must be a relative POSIX path with no `..`, `.`, empty
 * segment, NUL, backslash, drive letter or absolute form, must match the section's allow-list,
 * and is joined with the house safeJoin. The parent directory is realpath-checked to stay inside
 * the root, so a symlinked subdirectory cannot redirect a write. Writes are tmp + rename.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getDataDir, getClaudeConfigDir, getProjectsDir } from '../../../utils/path-utils';
import { safeJoin, UnsafePathError } from '../../../file-transfer/safe-path';
import type { BundleFile, FilesSectionId } from '../format';
import {
  asApplied, bump, newSectionPlan,
  type ApplyResult, type FilesCollectResult, type FilesProvider, type ImportPolicy, type PlanResult,
} from './types';

/** Files over this are skipped (spec: 5 MiB). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** A NUL byte within this many leading bytes marks a file binary. */
export const BINARY_SNIFF_BYTES = 8 * 1024;

const sha256 = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex');

// ─── path safety ────────────────────────────────────────────────────────────

/**
 * Validate an incoming relative path and resolve it under `root`. Throws UnsafePathError.
 * Stricter than safeJoin alone (which permits a `..` that stays inside): any `..`/`.`/empty
 * segment, NUL, backslash or drive letter is refused outright.
 */
export function resolveBundlePath(root: string, rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0) throw new UnsafePathError(String(rel), 'empty');
  if (rel.includes('\0')) throw new UnsafePathError(rel, 'NUL byte');
  if (rel.includes('\\')) throw new UnsafePathError(rel, 'backslash');
  if (/^[a-zA-Z]:/.test(rel)) throw new UnsafePathError(rel, 'drive-letter');
  if (rel.startsWith('/')) throw new UnsafePathError(rel, 'absolute');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new UnsafePathError(rel, `bad segment "${seg}"`);
  }
  return safeJoin(root, rel);
}

/** True when `p` (after resolving symlinks in its existing prefix) is inside `root`. */
function realInside(root: string, p: string): boolean {
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { return false; }
  const r = fs.realpathSync(p);
  return r === realRoot || r.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);
}

// ─── collect ────────────────────────────────────────────────────────────────

/** Read one file for the bundle, or return why it was skipped. */
function readForBundle(abs: string, rel: string): BundleFile | string {
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch (e) { return `unreadable: ${rel} (${(e as Error).message})`; }
  if (!st.isFile()) return `not a regular file: ${rel}`;
  if (st.size > MAX_FILE_BYTES) return `too-large: ${rel} (${st.size} bytes > ${MAX_FILE_BYTES})`;
  let buf: Buffer;
  try { buf = fs.readFileSync(abs); } catch (e) { return `unreadable: ${rel} (${(e as Error).message})`; }
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return `binary: ${rel}`;
  const content = buf.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(buf)) return `not-utf8: ${rel}`;
  return { path: rel, mtime: st.mtime.toISOString(), size: buf.length, sha256: sha256(buf), content };
}

/** Recursively list regular files under `dir` (never following symlinks), as POSIX paths relative to `dir`. */
function walk(dir: string, prefix = ''): string[] {
  let ents: fs.Dirent[];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

function collectPaths(root: string, rels: string[]): FilesCollectResult {
  const files: BundleFile[] = [];
  const warnings: string[] = [];
  for (const rel of rels) {
    const r = readForBundle(path.join(root, ...rel.split('/')), rel);
    if (typeof r === 'string') warnings.push(r); else files.push(r);
  }
  return { files, warnings };
}

// ─── plan / apply ───────────────────────────────────────────────────────────

interface SectionRules {
  id: FilesSectionId;
  title: string;
  root: () => string;
  /** Allow-list for an incoming relative path. */
  allowed: (rel: string) => boolean;
  /** Extra per-path gate (claude-memory: the project dir must exist). Returns a skip reason or null. */
  gate?: (root: string, rel: string) => string | null;
  /** Copy the existing file to `<file>.bak-import-<ts>` before a replace. */
  backupOnReplace: boolean;
  /** Called once after an apply that wrote at least one file. */
  afterWrite?: () => string | void;
}

function tsTag(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); // 20260923T101500Z
}

function writeFileAtomic(root: string, dest: string, content: string, mtime?: string): void {
  const parent = path.dirname(dest);
  fs.mkdirSync(parent, { recursive: true });
  if (!realInside(root, parent)) throw new UnsafePathError(path.relative(root, dest), 'resolves outside the root through a symlink');
  try {
    if (fs.lstatSync(dest).isSymbolicLink()) throw new UnsafePathError(path.relative(root, dest), 'destination is a symlink');
  } catch (e) {
    if (e instanceof UnsafePathError) throw e; // ENOENT → a new file, fine
  }
  const tmp = `${dest}.tmp-import-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, dest);
  if (mtime) {
    const t = new Date(mtime);
    if (!Number.isNaN(t.getTime())) { try { fs.utimesSync(dest, t, t); } catch { /* best effort */ } }
  }
}

async function planOrApply(rules: SectionRules, files: BundleFile[], policy: ImportPolicy, apply: boolean): Promise<PlanResult> {
  const plan = newSectionPlan('files', rules.id, rules.title);
  if (!Array.isArray(files)) {
    plan.refused = { code: 'BAD_SECTION_DATA', reason: 'files section data is not an array' };
    return apply ? asApplied(plan) : plan;
  }
  const root = rules.root();
  const writes: Array<{ bucket: 'add' | 'update'; rel: string; run: () => void }> = [];
  const unknownProjects = new Set<string>();
  const stamp = tsTag();

  for (const f of files) {
    const rel = f && typeof f.path === 'string' ? f.path : '';
    let dest: string;
    try {
      dest = resolveBundlePath(root, rel);
    } catch (e) {
      bump(plan, 'skipped', rel || undefined);
      plan.warnings.push(`unsafe-path: ${JSON.stringify(rel)} (${(e as Error).message}) — refused`);
      continue;
    }
    if (!rules.allowed(rel)) {
      bump(plan, 'skipped', rel);
      plan.warnings.push(`path-not-allowed: ${rel} is outside what the ${rules.id} section may write`);
      continue;
    }
    if (typeof f.content !== 'string') { bump(plan, 'skipped', rel); plan.warnings.push(`bad-entry: ${rel} has no content`); continue; }
    const bytes = Buffer.from(f.content, 'utf8');
    if (bytes.length > MAX_FILE_BYTES) { bump(plan, 'tooLarge', rel); continue; }
    if (typeof f.sha256 === 'string' && f.sha256 !== sha256(bytes)) {
      bump(plan, 'skipped', rel);
      plan.warnings.push(`sha-mismatch: ${rel} content does not match its sha256 — refused`);
      continue;
    }
    const gated = rules.gate?.(root, rel);
    if (gated) {
      bump(plan, 'skipped', rel);
      unknownProjects.add(gated);
      continue;
    }
    let existing: Buffer | null = null;
    try {
      const st = fs.lstatSync(dest);
      if (!st.isFile()) {
        bump(plan, 'skipped', rel);
        plan.warnings.push(`not-a-file: ${rel} exists here and is not a regular file — skipped`);
        continue;
      }
      existing = fs.readFileSync(dest);
    } catch { /* absent */ }
    if (existing && existing.equals(bytes)) { bump(plan, 'skipIdentical', rel); continue; }
    if (existing && policy !== 'replace') { bump(plan, 'skipExists', rel); continue; }
    const bucket = existing ? 'update' : 'add';
    bump(plan, bucket, rel);
    writes.push({
      bucket, rel,
      run: () => {
        if (existing && rules.backupOnReplace) writeFileAtomic(root, `${dest}.bak-import-${stamp}`, existing.toString('utf8'));
        writeFileAtomic(root, dest, f.content, f.mtime);
      },
    });
  }
  for (const u of unknownProjects) plan.warnings.push(u);
  if (!apply) return plan;

  const res = asApplied(plan);
  for (const w of writes) {
    try {
      w.run();
      res.applied[w.bucket] += 1;
    } catch (e) {
      res.errors!.push(`${w.rel}: ${(e as Error)?.message || e}`);
    }
  }
  if (res.applied.add + res.applied.update > 0 && rules.afterWrite) {
    try {
      const note = rules.afterWrite();
      if (note) res.warnings.push(note);
    } catch (e) {
      res.warnings.push(`post-import reload failed: ${(e as Error)?.message || e}`);
    }
  }
  return res;
}

function makeProvider(rules: SectionRules, collect: (root: string) => FilesCollectResult): FilesProvider {
  return {
    id: rules.id,
    title: rules.title,
    root: rules.root,
    async collect() { return collect(rules.root()); },
    plan: (files, policy) => planOrApply(rules, files, policy, false),
    apply: (files, policy) => planOrApply(rules, files, policy, true) as Promise<ApplyResult>,
  };
}

// ─── knowledge ──────────────────────────────────────────────────────────────

const KNOWLEDGE_TOP = /^[^/]+\.md$/;
const isKnowledgePath = (rel: string): boolean =>
  KNOWLEDGE_TOP.test(rel) || rel === 'index.json' || rel === 'settings.json' || rel.startsWith('comments/');

/** A hook that makes the knowledge store drop its cached index after an import. */
export type KnowledgeReloadHook = () => void;
let knowledgeReloadHook: KnowledgeReloadHook | null = null;

/** Register the knowledge-store reload (e.g. at boot). `null` clears it. */
export function setKnowledgeReloadHook(fn: KnowledgeReloadHook | null): void {
  knowledgeReloadHook = fn;
}

/**
 * Default reload: the registered hook, else a duck-typed `reloadIndex()` on the knowledge store
 * singleton if the build has one. KnowledgeStore caches index.json in memory with no reload
 * today, so without either the import tells the operator a restart is needed.
 */
function defaultKnowledgeReload(): string | void {
  if (knowledgeReloadHook) { knowledgeReloadHook(); return; }
  try {
    const mod = require('../../../knowledge/store');
    const store = typeof mod.getKnowledgeStore === 'function' ? mod.getKnowledgeStore() : null;
    if (store && typeof store.reloadIndex === 'function') { store.reloadIndex(); return; }
  } catch { /* fall through to the note */ }
  return 'knowledge files were imported; restart Core so the knowledge store re-reads its index';
}

export function createKnowledgeProvider(opts: { dir?: string; reload?: () => string | void } = {}): FilesProvider {
  const root = () => opts.dir ?? path.join(getDataDir(), 'knowledge');
  return makeProvider(
    {
      id: 'knowledge', title: 'Knowledge base', root, backupOnReplace: false,
      allowed: isKnowledgePath,
      afterWrite: opts.reload ?? defaultKnowledgeReload,
    },
    (r) => {
      const rels: string[] = [];
      let names: fs.Dirent[] = [];
      try { names = fs.readdirSync(r, { withFileTypes: true }); } catch { /* no knowledge dir */ }
      for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.isFile() && (KNOWLEDGE_TOP.test(e.name) || e.name === 'index.json' || e.name === 'settings.json')) rels.push(e.name);
      }
      rels.push(...walk(path.join(r, 'comments'), 'comments'));
      return collectPaths(r, rels);
    },
  );
}

// ─── claude-memory ──────────────────────────────────────────────────────────

const MEMORY_PATH = /^([^/]+)\/memory\/.+\.md$/;

export function createClaudeMemoryProvider(opts: { projectsDir?: string } = {}): FilesProvider {
  const root = () => opts.projectsDir ?? getProjectsDir();
  return makeProvider(
    {
      id: 'claude-memory', title: 'Claude project memory', root, backupOnReplace: true,
      allowed: (rel) => MEMORY_PATH.test(rel),
      gate: (r, rel) => {
        const slug = MEMORY_PATH.exec(rel)![1];
        let isDir = false;
        try { isDir = fs.statSync(path.join(r, slug)).isDirectory(); } catch { /* absent */ }
        return isDir ? null : `unknown-project: ${slug} has no ~/.claude/projects directory on this node — its memory was not imported`;
      },
    },
    (r) => {
      const rels: string[] = [];
      let slugs: fs.Dirent[] = [];
      try { slugs = fs.readdirSync(r, { withFileTypes: true }); } catch { /* no projects dir */ }
      for (const s of slugs.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!s.isDirectory()) continue;
        const memDir = path.join(r, s.name, 'memory');
        for (const f of walk(memDir, `${s.name}/memory`)) if (f.endsWith('.md')) rels.push(f);
      }
      return collectPaths(r, rels);
    },
  );
}

// ─── claude-rules ───────────────────────────────────────────────────────────

const RULE_PATH = /^[^/]+\.md$/;
const isOwnRule = (name: string): boolean => RULE_PATH.test(name) && !name.startsWith('synced.');

export function createClaudeRulesProvider(opts: { rulesDir?: string } = {}): FilesProvider {
  const root = () => opts.rulesDir ?? path.join(getClaudeConfigDir(), 'rules');
  return makeProvider(
    { id: 'claude-rules', title: 'Claude rules', root, backupOnReplace: true, allowed: isOwnRule },
    (r) => {
      let names: fs.Dirent[] = [];
      try { names = fs.readdirSync(r, { withFileTypes: true }); } catch { /* no rules dir */ }
      const rels = names.filter((e) => e.isFile() && isOwnRule(e.name)).map((e) => e.name).sort();
      return collectPaths(r, rels);
    },
  );
}

// ─── all three ──────────────────────────────────────────────────────────────

export interface FilesProvidersOptions {
  knowledgeDir?: string;
  knowledgeReload?: () => string | void;
  projectsDir?: string;
  rulesDir?: string;
}

export function createFilesProviders(o: FilesProvidersOptions = {}): FilesProvider[] {
  return [
    createKnowledgeProvider({ dir: o.knowledgeDir, reload: o.knowledgeReload }),
    createClaudeMemoryProvider({ projectsDir: o.projectsDir }),
    createClaudeRulesProvider({ rulesDir: o.rulesDir }),
  ];
}
