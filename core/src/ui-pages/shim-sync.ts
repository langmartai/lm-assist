/**
 * Pane shim drift — detect it at boot, and re-copy it on demand.
 *
 * ── THE FOOT-GUN THIS EXISTS TO DISARM ───────────────────────────────────────────────────
 * A pane's browser shim (`assets/lmui.js`) is COPIED, never imported or bundled. The copies
 * in `ui-apps/` are what the repo builds and tests against; the copies that actually RUN live
 * under the node's apps root (`~/.lmui/apps/<uiId>/assets/lmui.js`). **A Core build does not
 * touch the apps root** — `./core.sh build` compiles TypeScript into `core/dist` and stops.
 *
 * So a change that alters the shim/server CONTRACT (a new request field, a renamed endpoint,
 * a different header) ships in two halves that deploy through two entirely different channels:
 * the server half rides the build, the shim half rides a human's `cp -r`. Build the server and
 * forget the copy and you get the worst possible failure shape — nothing breaks at deploy time,
 * and every pane on the node dies later, when its 15-minute view token first expires and the
 * remint it fires uses the OLD contract. Delayed, silent, and disconnected from the change that
 * caused it. MEASURED on this node (2026-08-13): 7 deployed shims across TWO stale generations,
 * neither matching the repo's canonical copy.
 *
 * ── WHAT THIS MODULE DOES ────────────────────────────────────────────────────────────────
 *   • checkShims()   — inventory every installed pane and compare its shim to the canonical
 *                      bytes THIS BUILD ships, by content hash.
 *   • logShimDrift() — the boot-time alarm: names each stale pane and the command that fixes it.
 *   • syncShims()    — re-copy the canonical shim over every stale one.
 *
 * Content hash, not a version marker: a marker has to be remembered and bumped by the same
 * person who already forgot to run `cp`, and it cannot detect a hand-edit. The hash is derived
 * from the bytes, so it cannot be forgotten, and it needs no edit to the 18 shim copies.
 *
 * ── 🔴 WHAT A SHIM SYNC CANNOT FIX ───────────────────────────────────────────────────────
 * Some deployed panes have NO `assets/lmui.js` — they were built by a bundler that INLINED the
 * shim logic into a minified `app.js` (measured: assist-home, assist-machine, assist-api-keys,
 * assist-whatsapp all call `/viewtoken/remint` from `app.js` and ship no `lmui.js`). Copying a
 * shim file cannot update them; only rebuilding them from their own source can. `checkShims`
 * reports them in a separate `bundled` bucket and `syncShims` NEVER touches them, so the report
 * never claims a fix it did not make.
 *
 * 🔴 The load-bearing consequence: because those panes exist and cannot be repaired by any copy,
 * a serving-tier change must never HARD-REQUIRE a new request field. Make the new field optional
 * and keep the old body working, or those four panes 401 with no remedy short of a rebuild.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

/** The pane whose shim every other copy is synced FROM. Kept in step with
 *  `core/scripts/copy-ui-shim.js`; `ui-shim-sync.test.ts` asserts the two agree. */
export const CANONICAL_PANE = 'assist-backlog';

/** Bound on the bundled-shim scan, so a boot-time check can never read an unbounded tree. */
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_FILES = 8;
/** The call every pane makes with a token that expires — the marker for an inlined shim. */
const CONTRACT_MARKER = '/viewtoken/remint';

export type ShimState = 'match' | 'stale' | 'bundled' | 'no-shim';

export interface InstalledShim {
  uiId: string;
  dir: string;
  /** Path to the pane's own lmui.js, or '' when it has none. */
  file: string;
  state: ShimState;
  /** sha256 of the pane's shim, or null when there is no shim file. */
  hash: string | null;
}

export interface ShimReport {
  /** sha256 of the shim THIS build ships, or null when it could not be resolved. */
  canonicalHash: string | null;
  canonicalPath: string | null;
  appsRoot: string;
  panes: InstalledShim[];
  stale: InstalledShim[];
  bundled: InstalledShim[];
}

export interface ShimOptions {
  /** Override the apps root (default: $LMUI_APPS_DIR or ~/.lmui/apps). Test seam. */
  appsRoot?: string;
  /** Override the lmui run dir holding dev-*.json state files (default: ~/.lmui). Test seam. */
  stateDir?: string;
  /** Override the canonical bytes instead of resolving them from disk. Test seam. */
  canonical?: Buffer;
}

// ── canonical shim ───────────────────────────────────────────────────────────────────────

function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/**
 * The shim bytes THIS build ships.
 *
 * Two sources, in order, because Core runs from two very different trees:
 *   1. `<dist>/ui-pages/shim/lmui.js` — baked in by `scripts/copy-ui-shim.js` at build time.
 *      This is the ONLY one that exists in a prod npm install (`ui-apps/` is not packaged).
 *   2. `ui-apps/<CANONICAL_PANE>/assets/lmui.js` — the repo copy, for a source checkout whose
 *      dist predates this build step (and for `dist-test`, which has no shim artifact).
 * Returns null when neither is readable; every caller degrades to "canonical unknown" and says
 * so rather than guessing.
 */
export function canonicalShim(): { path: string; bytes: Buffer } | null {
  const baked = path.join(__dirname, 'shim', 'lmui.js');
  const read = (p: string): { path: string; bytes: Buffer } | null => {
    let bytes: Buffer;
    try { bytes = fs.readFileSync(p); } catch { return null; }
    // 🔴 A ZERO-BYTE canonical is treated as unresolvable, not as "the canonical is empty".
    // An interrupted copy or a full disk leaves a 0-byte artifact that reads back fine; without
    // this guard every pane would be flagged stale and then OVERWRITTEN WITH NOTHING, taking
    // out the whole node's UI to repair a problem that did not exist. Caught by
    // `ui-shim-sync.test.ts` ("sync refuses to guess when the canonical shim is unresolvable"),
    // which failed on exactly this before the guard: an empty Buffer is truthy in JS.
    return bytes.length > 0 ? { path: p, bytes } : null;
  };
  const fromDist = read(baked);
  if (fromDist) return fromDist;
  const root = repoRoot();
  if (root) {
    const fromRepo = read(path.join(root, 'ui-apps', CANONICAL_PANE, 'assets', 'lmui.js'));
    if (fromRepo) return fromRepo;
  }
  return null;
}

/** The canonical bytes a caller should act on: an explicit override wins, but only if usable. */
function resolveCanonical(opts: ShimOptions): { path: string; bytes: Buffer } | null {
  if (opts.canonical) return opts.canonical.length > 0 ? { path: '(provided)', bytes: opts.canonical } : null;
  return canonicalShim();
}

/** Nearest ancestor holding both `ui-apps/` and `package.json` — a source checkout, or null. */
function repoRoot(): string | null {
  let d = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'ui-apps')) && fs.existsSync(path.join(d, 'package.json'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

// ── installed pane inventory ─────────────────────────────────────────────────────────────

/** Same resolution reporter.ts uses for its managed-UI boot sync — one apps root, one answer. */
export function resolveAppsRoot(opts: ShimOptions = {}): string {
  return opts.appsRoot || process.env.LMUI_APPS_DIR || path.join(os.homedir(), '.lmui', 'apps');
}

function resolveStateDir(opts: ShimOptions = {}): string {
  return opts.stateDir || path.join(os.homedir(), '.lmui');
}

/**
 * Every pane directory installed on this node.
 *
 * The apps root is only where panes SHOULD live — `~/.lmui/dev-<uiId>.json` carries the `dir`
 * that lmui actually serves, and it can point anywhere. So both are read. A state `dir` is
 * treated as a pane when it holds an `lmui.config.json`, and as a ROOT otherwise — which is
 * what host mode looks like in practice (`dev-_host.json` points at the apps root itself and
 * serves every sibling beneath it, so reading it as a pane would find nothing).
 * De-duplicated by resolved path.
 */
export function listInstalledPanes(opts: ShimOptions = {}): Array<{ uiId: string; dir: string }> {
  const seen = new Map<string, { uiId: string; dir: string }>();

  const addPane = (dir: string, uiId?: string): void => {
    let real: string;
    try { real = fs.realpathSync(dir); } catch { return; }
    try { if (!fs.statSync(real).isDirectory()) return; } catch { return; }
    if (!seen.has(real)) seen.set(real, { uiId: uiId || path.basename(real), dir: real });
  };

  const addRoot = (root: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      // isDirectory() is false for a symlinked pane dir (hostdemo -> ~/uidemo on 117), so a
      // symlink is followed rather than skipped; addPane stats the target to confirm.
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const child = path.join(root, e.name);
      // A pane declares itself with lmui.config.json. Requiring it keeps stray directories
      // under the apps root (and a pane's own `assets/`) out of the inventory.
      if (fs.existsSync(path.join(child, 'lmui.config.json'))) addPane(child, e.name);
    }
  };

  addRoot(resolveAppsRoot(opts));

  const stateDir = resolveStateDir(opts);
  let stateFiles: string[] = [];
  try { stateFiles = fs.readdirSync(stateDir).filter((n) => /^dev-.+\.json$/.test(n)); } catch { stateFiles = []; }
  for (const n of stateFiles) {
    let dir: unknown;
    try { dir = (JSON.parse(fs.readFileSync(path.join(stateDir, n), 'utf8')) as { dir?: unknown }).dir; }
    catch { continue; }
    if (typeof dir !== 'string' || !dir) continue;
    // 🔴 An apps ROOT carries an lmui.config.json too — the host-mode one, `uiId: "_host"`
    // (measured on 117: ~/.lmui/apps/lmui.config.json). Treating "has a config" as "is a pane"
    // therefore added the root itself to the inventory as a phantom pane called `apps`. The
    // declared uiId is the real discriminator, so read it: `_host` means "serves every sibling
    // beneath me", anything else means "I am that pane".
    if (isHostRoot(dir)) addRoot(dir);
    else if (fs.existsSync(path.join(dir, 'lmui.config.json'))) addPane(dir);
    else addRoot(dir);
  }

  return [...seen.values()].sort((a, b) => a.uiId.localeCompare(b.uiId));
}

/** A directory serving every app beneath it (lmui host mode), not a pane in its own right. */
function isHostRoot(dir: string): boolean {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'lmui.config.json'), 'utf8')) as { uiId?: unknown };
    return cfg.uiId === '_host';
  } catch { return false; }
}

/** True when a pane with no lmui.js nonetheless speaks the serving-tier contract from a bundle. */
function hasInlinedShim(dir: string): boolean {
  const assets = path.join(dir, 'assets');
  let entries: string[];
  try { entries = fs.readdirSync(assets).filter((n) => n.endsWith('.js')); } catch { return false; }
  let budget = MAX_BUNDLE_BYTES;
  for (const n of entries.slice(0, MAX_BUNDLE_FILES)) {
    const f = path.join(assets, n);
    let size = 0;
    try { size = fs.statSync(f).size; } catch { continue; }
    if (size > budget) continue;
    budget -= size;
    try { if (fs.readFileSync(f, 'utf8').includes(CONTRACT_MARKER)) return true; } catch { /* unreadable */ }
  }
  return false;
}

// ── the check ────────────────────────────────────────────────────────────────────────────

/**
 * Compare every installed pane's shim against the canonical bytes.
 *
 * With no canonical resolvable, every shim-bearing pane is reported `match` and
 * `canonicalHash` is null — the caller must not turn "I could not check" into "all clear",
 * and `logShimDrift` says exactly that instead of staying quiet.
 */
export function checkShims(opts: ShimOptions = {}): ShimReport {
  const canon = resolveCanonical(opts);
  const canonicalHash = canon ? sha256(canon.bytes) : null;
  const panes: InstalledShim[] = [];

  for (const { uiId, dir } of listInstalledPanes(opts)) {
    const file = path.join(dir, 'assets', 'lmui.js');
    let bytes: Buffer | null = null;
    try { bytes = fs.readFileSync(file); } catch { bytes = null; }
    if (bytes) {
      const hash = sha256(bytes);
      panes.push({ uiId, dir, file, hash, state: !canonicalHash || hash === canonicalHash ? 'match' : 'stale' });
      continue;
    }
    panes.push({
      uiId, dir, file: '', hash: null,
      state: hasInlinedShim(dir) ? 'bundled' : 'no-shim',
    });
  }

  return {
    canonicalHash,
    canonicalPath: canon ? canon.path : null,
    appsRoot: resolveAppsRoot(opts),
    panes,
    stale: panes.filter((p) => p.state === 'stale'),
    bundled: panes.filter((p) => p.state === 'bundled'),
  };
}

const short = (h: string | null): string => (h ? h.slice(0, 12) : 'unknown');

/**
 * The lines a human needs to see, in the order they need them: what is wrong, why a build did
 * not fix it, which panes, what to run, and what a sync will NOT reach.
 * Returns [] when there is nothing to say.
 */
export function formatDrift(r: ShimReport): string[] {
  const out: string[] = [];
  if (r.canonicalHash === null) {
    out.push('[ui-pages] ⚠️  PANE SHIM CHECK SKIPPED — cannot resolve the canonical shim'
      + ` (looked for <dist>/ui-pages/shim/lmui.js and ui-apps/${CANONICAL_PANE}/assets/lmui.js).`);
    out.push('[ui-pages] ⚠️  Rebuild Core (`./core.sh build`) to bake it in. Deployed panes were NOT verified.');
    return out;
  }
  if (r.stale.length === 0) return out;

  out.push(`[ui-pages] 🔴 STALE PANE SHIMS — ${r.stale.length} of ${r.panes.length} installed pane(s) run an OLD lmui.js.`);
  out.push('[ui-pages] 🔴 A Core build does NOT touch the apps root, so these panes still speak the PREVIOUS');
  out.push('[ui-pages] 🔴 client contract. They keep working until each pane\'s 15-min view token expires,');
  out.push('[ui-pages] 🔴 then their remint fails — silent at deploy time, broken minutes later.');
  out.push(`[ui-pages] 🔴 canonical ${short(r.canonicalHash)}  (${r.canonicalPath})`);
  for (const p of r.stale) out.push(`[ui-pages] 🔴   ${p.uiId}  ${short(p.hash)} != ${short(r.canonicalHash)}  ${p.file}`);
  out.push('[ui-pages] 🔴 FIX: node core/scripts/sync-ui-shims.js   (or ./core.sh panes sync)');
  out.push('[ui-pages] 🔴 Panes already open in a browser need ONE reload to pick up the new shim.');
  if (r.bundled.length) {
    out.push(`[ui-pages] 🔴 NOT FIXED BY A SYNC — ${r.bundled.length} pane(s) inline the shim into a bundled app.js`);
    out.push(`[ui-pages] 🔴 (${r.bundled.map((p) => p.uiId).join(', ')}). Rebuild them from their own source.`);
  }
  return out;
}

/** Boot-time alarm. Never throws — a check that can crash Core is worse than the drift. */
export function logShimDrift(log: (m: string) => void = () => {}, opts: ShimOptions = {}): ShimReport | null {
  let r: ShimReport;
  try { r = checkShims(opts); } catch (e) {
    log(`[ui-pages] pane shim check failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  const lines = formatDrift(r);
  if (lines.length) { for (const l of lines) log(l); return r; }
  const n = r.panes.filter((p) => p.state === 'match').length;
  log(`[ui-pages] pane shims up to date (${n} in sync @ ${short(r.canonicalHash)}`
    + `${r.bundled.length ? `, ${r.bundled.length} bundled` : ''})`);
  return r;
}

// ── the sync ─────────────────────────────────────────────────────────────────────────────

export interface SyncResult {
  report: ShimReport;
  dryRun: boolean;
  synced: string[];
  failed: Array<{ uiId: string; error: string }>;
  /** Panes a copy cannot repair — reported so the result never overstates what it fixed. */
  bundled: string[];
}

/**
 * Re-copy the canonical shim over every stale pane.
 *
 * 🔴 Only OVERWRITES an existing `assets/lmui.js`. It never creates one, because a pane without
 * a shim file either does not use the shim or inlines it — writing a file into either would be
 * a guess, and the `bundled` list exists to report them honestly instead.
 * Writes via a temp file + rename in the SAME directory, so a pane is never served a
 * half-written shim if the process dies mid-copy.
 */
export function syncShims(opts: ShimOptions & { dryRun?: boolean } = {}): SyncResult {
  const dryRun = opts.dryRun === true;
  const report = checkShims(opts);
  const synced: string[] = [];
  const failed: Array<{ uiId: string; error: string }> = [];

  if (report.canonicalHash === null) {
    return {
      report, dryRun, synced,
      failed: [{ uiId: '(all)', error: 'canonical shim not resolvable — rebuild Core (./core.sh build)' }],
      bundled: report.bundled.map((p) => p.uiId),
    };
  }
  const canon = resolveCanonical(opts)?.bytes;
  if (!canon || canon.length === 0) {
    return {
      report, dryRun, synced,
      failed: [{ uiId: '(all)', error: 'canonical shim disappeared between check and copy' }],
      bundled: report.bundled.map((p) => p.uiId),
    };
  }

  for (const p of report.stale) {
    if (dryRun) { synced.push(p.uiId); continue; }
    const tmp = `${p.file}.lmui-sync-${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, canon);
      fs.renameSync(tmp, p.file);
      synced.push(p.uiId);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
      failed.push({ uiId: p.uiId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { report, dryRun, synced, failed, bundled: report.bundled.map((p) => p.uiId) };
}
