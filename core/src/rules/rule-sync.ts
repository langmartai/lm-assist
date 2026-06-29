/**
 * Rule sync core — the write side of cross-node USER-rule sync (sibling of memory/ingest.ts).
 *
 *  - readOwnRules(): this node's own USER rules (excludes synced.* + credential-shaped names).
 *  - applyIngest(): place a peer's rules via the OS router — matching/empty-OS rules land ACTIVE at
 *    ~/.claude/rules/synced.<host>.<name>.md (native CC injects them); wrong-OS rules land INERT at
 *    ~/.lm-assist/rules-mirror/<host>/<name>.md (map-indexed only). Set-diff removal: files in the
 *    <host> namespace not in the incoming set are deleted (tombstone-free). Byte-identical writes.
 *
 * See docs/superpowers/specs/2026-06-30-rule-auto-sync-and-os-scoping-design.md
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { getClaudeConfigDir, getDataDir } from '../utils/path-utils';
import { parseOs, normalizeOsList } from './rule-extract';

export interface OwnRule { file: string; content: string; contentHash: string; os: string[]; osDependent: boolean; }
export interface IngestRule { file: string; content: string; contentHash: string; os?: string[]; }
export interface IngestResult { applied: number; active: number; inert: number; removed: number; }

const MAX_RULE_BYTES = 64 * 1024;
/** Credential-shaped filenames are never read/exported (mirrors memory's export guard). */
const CREDENTIAL_PATTERNS: RegExp[] = [/token/i, /(?<![a-zA-Z])key(?![a-zA-Z])/i, /cookie/i, /password/i, /secret/i, /credential/i];

function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }

export function rulesRoot(rulesDir?: string): string { return rulesDir || path.join(getClaudeConfigDir(), 'rules'); }
export function mirrorRootDir(mirrorRoot?: string): string { return mirrorRoot || path.join(getDataDir(), 'rules-mirror'); }

/** LM_HOST_ID > hub gatewayId > hostname. Used to attribute this node's exported rules. */
export function selfHostId(): string {
  if (process.env.LM_HOST_ID) return process.env.LM_HOST_ID;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const id = require('../hub-client').getHubClient().getStatus().gatewayId;
    if (id) return String(id);
  } catch { /* hub not up */ }
  return os.hostname();
}

/** Dot-free host segment so `synced.<host>.<name>` parses unambiguously. null if it sanitizes to empty. */
export function sanitizeHost(host: string): string | null {
  const s = String(host || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s.length ? s : null;
}

/** A safe, flat *.md basename. Rejects absolute / traversal; flattens separators to '-'. null if unsafe. */
export function sanitizeBasename(file: string): string | null {
  const f = String(file || '');
  if (!f || f.includes('\0') || f.includes('..') || path.isAbsolute(f)) return null;
  const flat = f.replace(/[\\/]+/g, '-').replace(/^\.+/, '');
  if (!flat.endsWith('.md') || !/^[A-Za-z0-9._-]+$/.test(flat)) return null;
  return flat;
}

/** Recursively read this node's own USER rules. Excludes synced.* + credential-shaped names. */
export function readOwnRules(rulesDir?: string): OwnRule[] {
  const root = rulesRoot(rulesDir);
  const out: OwnRule[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp); continue; }
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      if (e.name.startsWith('synced.')) continue;            // never re-export a synced copy → no echo loop
      if (CREDENTIAL_PATTERNS.some((re) => re.test(e.name))) continue;
      let content: string;
      try { content = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
      if (Buffer.byteLength(content, 'utf-8') > MAX_RULE_BYTES) continue;
      const relpath = path.relative(root, fp).split(path.sep).join('/');
      const osList = normalizeOsList(parseOs(content));
      out.push({ file: relpath, content, contentHash: sha256(content), os: osList, osDependent: osList.length > 0 });
    }
  };
  walk(root);
  return out;
}

/** Active (native-injected) vs mirror (inert) placement for one rule on this platform. */
export function routePlacement(ruleOs: string[], localPlatform: string): 'active' | 'mirror' {
  return ruleOs.length === 0 || ruleOs.includes(localPlatform) ? 'active' : 'mirror';
}

function ensureMirrorReadme(root: string): void {
  try {
    fs.mkdirSync(root, { recursive: true });
    const readme = path.join(root, 'README.md');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme,
        '# rules-mirror\n\nInert (wrong-OS) copies of fleet rules, indexed by the rule-map only — ' +
        'NOT injected into sessions. Do not hand-edit; edit a rule on its source host. ' +
        'Active copies live in ~/.claude/rules/synced.<host>.*.\n');
    }
  } catch { /* best-effort */ }
}

/**
 * Place a peer's CURRENT rule set via the OS router + tombstone-free set-diff removal.
 * Writes are confined to ~/.claude/rules/synced.<host>.* and ~/.lm-assist/rules-mirror/<host>/.
 * sourcePlatform is accepted for symmetry/logging but routing uses each rule's own os vs localPlatform.
 */
export function applyIngest(
  sourceHost: string,
  _sourcePlatform: string,
  rules: IngestRule[],
  localPlatform: string,
  opts: { rulesDir?: string; mirrorRoot?: string } = {},
): IngestResult {
  const res: IngestResult = { applied: 0, active: 0, inert: 0, removed: 0 };
  const host = sanitizeHost(sourceHost);
  if (!host) return res;

  const activeDir = rulesRoot(opts.rulesDir);
  const mirrorBase = mirrorRootDir(opts.mirrorRoot);
  const mirrorDir = path.join(mirrorBase, host);

  const wantActive = new Set<string>();   // synced.<host>.<name> basenames we keep this cycle
  const wantMirror = new Set<string>();   // <name> basenames in the host's mirror dir we keep

  for (const r of rules) {
    const name = sanitizeBasename(r.file);
    if (!name) continue;
    if (Buffer.byteLength(r.content || '', 'utf-8') > MAX_RULE_BYTES) continue;
    const ruleOs = Array.isArray(r.os) ? r.os : [];
    const place = routePlacement(ruleOs, localPlatform);

    if (place === 'active') {
      const fname = `synced.${host}.${name}`;
      const dest = path.join(activeDir, fname);
      if (path.dirname(path.resolve(dest)) !== path.resolve(activeDir)) continue; // defense-in-depth
      writeIfChanged(dest, r.content);
      wantActive.add(fname);
      res.applied++; res.active++;
    } else {
      ensureMirrorReadme(mirrorBase);
      const dest = path.join(mirrorDir, name);
      try { fs.mkdirSync(mirrorDir, { recursive: true }); } catch { /* */ }
      if (path.dirname(path.resolve(dest)) !== path.resolve(mirrorDir)) continue; // defense-in-depth
      writeIfChanged(dest, r.content);
      wantMirror.add(name);
      res.applied++; res.inert++;
    }
  }

  // ── tombstone-free removal: drop this host's synced/mirror files NOT in the current set ──
  res.removed += sweep(activeDir, (n) => n.startsWith(`synced.${host}.`) && !wantActive.has(n));
  res.removed += sweep(mirrorDir, (n) => n.endsWith('.md') && n !== 'README.md' && !wantMirror.has(n));
  return res;
}

/** Write only if absent or byte-different (preserves mtime → no churn, keeps contentHash dedup honest). */
function writeIfChanged(dest: string, content: string): void {
  try {
    if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf-8') === content) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  } catch { /* unwritable — skip */ }
}

/** Delete files in dir whose basename matches pred. Returns count removed. */
function sweep(dir: string, pred: (name: string) => boolean): number {
  let removed = 0;
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const n of names) {
    if (!pred(n)) continue;
    try { fs.unlinkSync(path.join(dir, n)); removed++; } catch { /* */ }
  }
  return removed;
}
