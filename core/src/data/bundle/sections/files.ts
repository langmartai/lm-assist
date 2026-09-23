/**
 * Section 3 — opt-in `files` sections (spec §3):
 *
 *   knowledge      <dataDir>/knowledge/: *.md, index.json, settings.json, comments/** (never remote/).
 *                  On a node that already has an index, index.json is MERGED (imported K-docs are
 *                  indexed, nextId advanced past them) instead of being skipped or overwritten.
 *   claude-memory  ~/.claude/projects/<slug>/memory/**\/*.md — written only when the project dir
 *                  <slug> already exists on this host, otherwise `unknown-project`. Dot-dirs (the
 *                  autosync's .sync-base/ merge ancestors) are never exported or imported, and the
 *                  per-node managed files (MEMORY.md, _hosts.md, _cross-project.md) are never imported.
 *   claude-rules   ~/.claude/rules/*.md, excluding synced.* (mirrors of another node's rules), and
 *                  never an import of a rule this node already mirrors as synced.<host>.<name>.
 *
 * claude-memory and claude-rules drop credential-shaped FILENAMES (utils/credential-names — the
 * same list memory and rule sync apply) on collect and refuse them on import.
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
import { isCredentialName } from '../../../utils/credential-names';
import type { BundleFile, FilesSectionId } from '../format';
import {
  asApplied, bump, newSectionPlan,
  type ApplyResult, type FilesCollectResult, type FilesProvider, type ImportPolicy, type PlanBucket, type PlanResult,
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

/**
 * Recursively list regular files under `dir` (never following symlinks — the start dir
 * included: a symlinked `comments/` or `<slug>/memory` is skipped with a warning, not read
 * through), as POSIX paths relative to `dir`. `skipDot` leaves out dot-files and dot-dirs.
 */
function walk(dir: string, prefix = '', warnings?: string[], skipDot = false): string[] {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) {
      warnings?.push(`symlinked-dir: ${prefix || dir} skipped (a bundle never reads through a symlink)`);
      return [];
    }
  } catch { return []; }
  let ents: fs.Dirent[];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (skipDot && e.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel, warnings, skipDot));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

function collectPaths(root: string, rels: string[], pre: string[] = []): FilesCollectResult {
  const files: BundleFile[] = [];
  const warnings: string[] = [...pre];
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
  /** Per-file refusal with its own warning line (managed / credential-named / already-mirrored). */
  refuse?: (root: string, rel: string, content: string) => { bucket: PlanBucket; warning: string } | null;
  /** Sees every planned write (phase 'plan') and every successful one (phase 'written'). */
  observe?: (rel: string, bucket: 'add' | 'update', phase: 'plan' | 'written') => void;
  /** Copy the existing file to `<file>.bak-import-<ts>` before a replace. */
  backupOnReplace: boolean;
  /** Called once after an apply that wrote at least one file. */
  afterWrite?: () => string | void;
}

function tsTag(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); // 20260923T101500Z
}

/**
 * Create `parent` (under `root`) without ever creating a directory through a symlink: the
 * deepest EXISTING ancestor is realpath-checked first, then each missing segment is made
 * non-recursively and lstat-confirmed to be a real directory. A recursive mkdir first would
 * already have created directories outside the root before any check could refuse.
 */
function mkdirInside(root: string, parent: string): void {
  const rel = path.relative(root, parent);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new UnsafePathError(rel, 'outside the root');
  fs.mkdirSync(root, { recursive: true });
  let cur = root;
  for (const seg of rel ? rel.split(path.sep) : []) {
    const next = path.join(cur, seg);
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(next); } catch { /* missing */ }
    if (st?.isSymbolicLink()) {
      if (!realInside(root, next)) throw new UnsafePathError(path.relative(root, next), 'resolves outside the root through a symlink');
    } else if (!st) {
      if (!realInside(root, cur)) throw new UnsafePathError(path.relative(root, cur) || '.', 'resolves outside the root through a symlink');
      fs.mkdirSync(next);
    } else if (!st.isDirectory()) {
      throw new UnsafePathError(path.relative(root, next), 'not a directory');
    }
    cur = next;
  }
}

function writeFileAtomic(root: string, dest: string, content: string, mtime?: string): void {
  const parent = path.dirname(dest);
  mkdirInside(root, parent);
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
    const refused = rules.refuse?.(root, rel, f.content);
    if (refused) {
      bump(plan, refused.bucket, rel);
      plan.warnings.push(refused.warning);
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
    rules.observe?.(rel, bucket, 'plan');
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
      rules.observe?.(w.rel, w.bucket, 'written');
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

const K_DOC = /^(K\d+)\.md$/;

interface KnowledgeIndexFile { knowledges: Record<string, unknown>; nextId: number; [k: string]: unknown }

function readIndex(file: string): KnowledgeIndexFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.knowledges || typeof raw.knowledges !== 'object') return null;
    return { ...raw, nextId: typeof raw.nextId === 'number' && raw.nextId >= 1 ? raw.nextId : 1 };
  } catch { return null; }
}

/** An index entry for a K-doc the bundle's index does not describe — derived from the md. */
function entryFromMd(content: string): Record<string, unknown> | null {
  try {
    const { parseKnowledgeMd } = require('../../../knowledge/parser') as typeof import('../../../knowledge/parser');
    const k = parseKnowledgeMd(content);
    if (!k) return null;
    return { title: k.title, type: k.type, project: k.project, status: k.status, partCount: k.parts.length, unaddressedComments: 0, updatedAt: k.updatedAt };
  } catch { return null; }
}

/**
 * The local index with every written K-doc indexed and nextId advanced past them. The
 * knowledge store lists ONLY what index.json names, and allocateId() hands out K<nextId> —
 * so a K-doc written without an entry is invisible AND the next generated doc overwrites it.
 */
function mergeKnowledgeIndex(local: KnowledgeIndexFile, bundle: KnowledgeIndexFile | null, written: Map<string, string>): { index: KnowledgeIndexFile; indexed: string[] } {
  const knowledges = { ...local.knowledges };
  const indexed: string[] = [];
  let maxN = 0;
  for (const [id, content] of written) {
    maxN = Math.max(maxN, Number(id.slice(1)));
    const entry = (bundle?.knowledges?.[id] as Record<string, unknown> | undefined) ?? entryFromMd(content) ?? (knowledges[id] as Record<string, unknown> | undefined);
    if (entry && !knowledges[id]) indexed.push(id);
    if (entry) knowledges[id] = entry;
  }
  const nextId = Math.max(local.nextId, bundle?.nextId ?? 0, maxN + 1);
  return { index: { ...local, knowledges, nextId, lastUpdated: Date.now() }, indexed };
}

export function createKnowledgeProvider(opts: { dir?: string; reload?: () => string | void } = {}): FilesProvider {
  const root = () => opts.dir ?? path.join(getDataDir(), 'knowledge');
  const reload = opts.reload ?? defaultKnowledgeReload;
  const base: SectionRules = {
    id: 'knowledge', title: 'Knowledge base', root, backupOnReplace: false,
    allowed: isKnowledgePath,
    afterWrite: reload,
  };
  const collect = (r: string): FilesCollectResult => {
    const rels: string[] = [];
    const pre: string[] = [];
    let names: fs.Dirent[] = [];
    try { names = fs.readdirSync(r, { withFileTypes: true }); } catch { /* no knowledge dir */ }
    for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isFile() && (KNOWLEDGE_TOP.test(e.name) || e.name === 'index.json' || e.name === 'settings.json')) rels.push(e.name);
    }
    rels.push(...walk(path.join(r, 'comments'), 'comments', pre));
    return collectPaths(r, rels, pre);
  };

  /** A node WITHOUT an index takes the bundle's verbatim; one WITH an index gets it merged. */
  async function run(files: BundleFile[], policy: ImportPolicy, apply: boolean): Promise<PlanResult> {
    const r = root();
    const indexPath = path.join(r, 'index.json');
    const local = Array.isArray(files) ? readIndex(indexPath) : null;
    if (!local) return planOrApply(base, files, policy, apply);
    const bundleIndexFile = files.find((f) => f && f.path === 'index.json');
    let bundleIndex: KnowledgeIndexFile | null = null;
    if (bundleIndexFile && typeof bundleIndexFile.content === 'string') {
      try {
        const raw = JSON.parse(bundleIndexFile.content);
        if (raw && typeof raw === 'object' && raw.knowledges && typeof raw.knowledges === 'object') {
          bundleIndex = { ...raw, nextId: typeof raw.nextId === 'number' ? raw.nextId : 0 };
        }
      } catch { /* a bad bundle index: entries are derived from the docs instead */ }
    }
    const contentOf = new Map(files.filter((f) => f && typeof f.path === 'string').map((f) => [f.path, f.content]));
    const planned = new Map<string, string>();
    const written = new Map<string, string>();
    const track = (rel: string, phase: 'plan' | 'written') => {
      const m = K_DOC.exec(rel);
      if (m) (phase === 'plan' ? planned : written).set(m[1], contentOf.get(rel) ?? '');
    };
    let indexNote: string | null = null;
    const rules: SectionRules = {
      ...base,
      observe: (rel, _b, phase) => track(rel, phase),
      afterWrite: () => {
        if (written.size) {
          const { index, indexed } = mergeKnowledgeIndex(local, bundleIndex, written);
          writeFileAtomic(r, indexPath, JSON.stringify(index, null, 2));
          indexNote = indexed.length ? `index-merged: ${indexed.length} imported document(s) added to this node's index (${indexed.slice(0, 10).join(', ')}${indexed.length > 10 ? ', …' : ''})` : null;
        }
        return reload();
      },
    };
    const res = await planOrApply(rules, files.filter((f) => !(f && f.path === 'index.json')), policy, apply);
    if (!res.refused) {
      if (!apply) {
        const { indexed } = mergeKnowledgeIndex(local, bundleIndex, planned);
        if (planned.size) bump(res, 'update', 'index.json'); else if (bundleIndexFile) bump(res, 'skipIdentical', 'index.json');
        if (indexed.length) res.warnings.push(`index-merged: ${indexed.length} imported document(s) would be added to this node's index (${indexed.slice(0, 10).join(', ')}${indexed.length > 10 ? ', …' : ''})`);
      } else {
        if (planned.size) bump(res, 'update', 'index.json'); else if (bundleIndexFile) bump(res, 'skipIdentical', 'index.json');
        if (written.size) (res as ApplyResult).applied.update += 1;
        if (indexNote) res.warnings.push(indexNote);
      }
    }
    return res;
  }

  return {
    id: 'knowledge',
    title: 'Knowledge base',
    root,
    async collect() { return collect(root()); },
    plan: (files, policy) => run(files, policy, false),
    apply: (files, policy) => run(files, policy, true) as Promise<ApplyResult>,
  };
}

// ─── claude-memory ──────────────────────────────────────────────────────────

const MEMORY_PATH = /^([^/]+)\/memory\/.+\.md$/;
/** Per-node managed memory files (regenerated here; memory sync never ships them either). */
export const MEMORY_MANAGED_FILES: ReadonlySet<string> = new Set(['MEMORY.md', '_hosts.md', '_cross-project.md']);

/** A memory path this section may write: no dot-segment below `<slug>/memory/` (the
 *  autosync's `.sync-base/` holds its 3-way merge ancestors — restoring one would make the
 *  next sync silently undo the restore). */
const isMemoryPath = (rel: string): boolean =>
  MEMORY_PATH.test(rel) && !rel.split('/').slice(2).some((seg) => seg.startsWith('.'));

export function createClaudeMemoryProvider(opts: { projectsDir?: string } = {}): FilesProvider {
  const root = () => opts.projectsDir ?? getProjectsDir();
  return makeProvider(
    {
      id: 'claude-memory', title: 'Claude project memory', root, backupOnReplace: true,
      allowed: isMemoryPath,
      refuse: (_r, rel) => {
        const name = path.posix.basename(rel);
        if (isCredentialName(name)) return { bucket: 'skipped', warning: `credential-named: ${rel} is never imported (memory sync keeps such files on their host)` };
        if (MEMORY_MANAGED_FILES.has(name) && rel.split('/').length === 3) return { bucket: 'skipped', warning: `managed-file: ${rel} is regenerated per node — never imported` };
        return null;
      },
      gate: (r, rel) => {
        const slug = MEMORY_PATH.exec(rel)![1];
        let isDir = false;
        try { isDir = fs.statSync(path.join(r, slug)).isDirectory(); } catch { /* absent */ }
        return isDir ? null : `unknown-project: ${slug} has no ~/.claude/projects directory on this node — its memory was not imported`;
      },
    },
    (r) => {
      const rels: string[] = [];
      const pre: string[] = [];
      let slugs: fs.Dirent[] = [];
      try { slugs = fs.readdirSync(r, { withFileTypes: true }); } catch { /* no projects dir */ }
      for (const s of slugs.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!s.isDirectory()) continue;
        const memDir = path.join(r, s.name, 'memory');
        for (const f of walk(memDir, `${s.name}/memory`, pre, true)) {
          if (!f.endsWith('.md')) continue;
          if (isCredentialName(path.posix.basename(f))) { pre.push(`credential-named: ${f} not exported`); continue; }
          rels.push(f);
        }
      }
      return collectPaths(r, rels, pre);
    },
  );
}

// ─── claude-rules ───────────────────────────────────────────────────────────

const RULE_PATH = /^[^/]+\.md$/;
const isOwnRule = (name: string): boolean => RULE_PATH.test(name) && !name.startsWith('synced.') && !name.startsWith('.');
/** Same cap rule sync applies to a rule it exports. */
export const MAX_RULE_BYTES = 64 * 1024;

/** The host of a `synced.<host>.<name>` mirror of `name` in `root`, or null. Rule sync writes
 *  those; importing `name` as this node's OWN rule would re-export it fleet-wide and every
 *  session would load it twice. */
function mirroredBy(root: string, name: string): { host: string; content: string | null } | null {
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { return null; }
  for (const n of names) {
    if (!n.startsWith('synced.')) continue;
    const dot = n.indexOf('.', 'synced.'.length);
    if (dot < 0 || n.slice(dot + 1) !== name) continue;
    let content: string | null = null;
    try { content = fs.readFileSync(path.join(root, n), 'utf8'); } catch { /* unreadable */ }
    return { host: n.slice('synced.'.length, dot), content };
  }
  return null;
}

export function createClaudeRulesProvider(opts: { rulesDir?: string } = {}): FilesProvider {
  const root = () => opts.rulesDir ?? path.join(getClaudeConfigDir(), 'rules');
  return makeProvider(
    {
      id: 'claude-rules', title: 'Claude rules', root, backupOnReplace: true, allowed: isOwnRule,
      refuse: (r, rel, content) => {
        if (isCredentialName(rel)) return { bucket: 'skipped', warning: `credential-named: ${rel} is never imported (rule sync keeps such files on their host)` };
        const m = mirroredBy(r, rel);
        if (m) {
          return {
            bucket: m.content === content ? 'skipIdentical' : 'skipped',
            warning: `already-mirrored: ${rel} exists here as a synced copy from ${m.host} — importing would make it this node's own rule and re-sync it fleet-wide`,
          };
        }
        return null;
      },
    },
    (r) => {
      let names: fs.Dirent[] = [];
      try { names = fs.readdirSync(r, { withFileTypes: true }); } catch { /* no rules dir */ }
      const pre: string[] = [];
      const rels: string[] = [];
      for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!e.isFile() || !isOwnRule(e.name)) continue;
        if (isCredentialName(e.name)) { pre.push(`credential-named: ${e.name} not exported`); continue; }
        let size = 0;
        try { size = fs.statSync(path.join(r, e.name)).size; } catch { /* unreadable → collectPaths reports it */ }
        if (size > MAX_RULE_BYTES) { pre.push(`too-large: ${e.name} (${size} bytes > the ${MAX_RULE_BYTES}-byte rule cap)`); continue; }
        rels.push(e.name);
      }
      // Only top-level rules are in this section — say so instead of silently leaving
      // nested ones out of what the operator believes is a backup.
      for (const e of names) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        for (const f of walk(path.join(r, e.name), e.name, pre, true)) {
          if (f.endsWith('.md') && !path.posix.basename(f).startsWith('synced.')) pre.push(`nested-rule-not-exported: ${f} (only top-level rules are in this section)`);
        }
      }
      return collectPaths(r, rels, pre);
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
