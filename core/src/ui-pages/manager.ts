/**
 * Pluggable-UI page manager — visibility + lifecycle for the local `lmui` dev servers
 * that the Core's /ui-* hub route relays to.
 *
 * Contract (public, agentic-ui-spec sdk/README.md): `lmui start` writes
 * `~/.lmui/dev-<uiId>.json` { uiId, service, pid, port, dir, sdkPath, log, startedAt }
 * and `lmui stop` removes it. lmui is the ONLY writer — this module only reads state
 * files and spawns/signals the processes they describe.
 *
 * Boot respawn: when the Core starts with a /ui-* route configured (uiWebPort set),
 * every state file whose recorded pid is dead is respawned. Without this a host reboot
 * silently kills all worker-hosted UIs until the author remembers — the exact class of
 * silent breakage the persisted uiWebPort was built to avoid.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';

export interface UiPageState {
  uiId: string;
  service: string;
  pid: number;
  port: number;
  dir: string;
  sdkPath: string;
  log: string;
  startedAt: string;
}

export interface UiPageStatus extends UiPageState {
  alive: boolean;          // recorded pid exists
  serving: boolean;        // HTTP probe on 127.0.0.1:<port>/<service>/index.html succeeded
  reachableViaHub: boolean; // serving AND port === uiWebPort (else the hub route can't reach it)
  stale: boolean;          // dead AND not respawnable (dir gone / config gone)
  autoStart: boolean;      // will the boot respawn bring this page back? (default true)
  issue?: string;          // human-readable reason when something is off
}

export interface UiPagesReport {
  uiWebPort: number | null;
  routeActive: boolean;
  uiAppsDir: string;
  pages: UiPageStatus[];
}

const runDir = (): string => path.join(os.homedir(), '.lmui');

/** Preferred root for UI app directories. Apps can live anywhere (the state file's
 *  `dir` is the truth) — this is where NEW apps should be scaffolded so they survive
 *  as a browsable, backed-up set. Overridable via uiAppsDir in hub{,-dev}.json. */
export function defaultUiAppsDir(override?: string): string {
  const d = override || path.join(runDir(), 'apps');
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* report it anyway */ }
  return d;
}

export function listStateFiles(): UiPageState[] {
  let names: string[] = [];
  try { names = fs.readdirSync(runDir()); } catch { return []; }
  const out: UiPageState[] = [];
  for (const n of names) {
    if (!/^dev-.+\.json$/.test(n)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(runDir(), n), 'utf8')) as UiPageState;
      if (s && s.uiId && s.pid && s.port) out.push(s);
    } catch { /* unreadable state file — skip; lmui owns repairs */ }
  }
  return out;
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ── Autostart flags ────────────────────────────────────────────────────────────────────
// ~/.lmui/autostart.json: { "<uiId>": false } — Core-owned (lmui never reads it), default
// TRUE for every page. false = the boot respawn leaves this page down; start/stop remain
// available. Distinct from parking (stopped-*.json): parking is "stopped right now",
// autostart is "what boot does" — disable-autostart on a running page keeps it running.
const autostartFile = (): string => path.join(runDir(), 'autostart.json');

export function readAutostartFlags(): Record<string, boolean> {
  try { return JSON.parse(fs.readFileSync(autostartFile(), 'utf8')) || {}; } catch { return {}; }
}

export function autoStartEnabled(uiId: string): boolean {
  return readAutostartFlags()[uiId] !== false;
}

export function setAutoStart(uiId: string, enabled: boolean): void {
  const flags = readAutostartFlags();
  if (enabled) delete flags[uiId]; else flags[uiId] = false;
  fs.mkdirSync(runDir(), { recursive: true });
  fs.writeFileSync(autostartFile(), JSON.stringify(flags, null, 2) + '\n');
}

export function probeHttp(port: number, pathName: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathName, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve((res.statusCode || 0) < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/** Can this (dead) page be respawned from its state file? */
export function respawnable(s: UiPageState): { ok: boolean; reason?: string } {
  if (!fs.existsSync(s.dir)) return { ok: false, reason: `app dir gone: ${s.dir}` };
  if (!fs.existsSync(path.join(s.dir, 'lmui.config.json'))) return { ok: false, reason: `lmui.config.json missing in ${s.dir}` };
  const sdk = path.join(s.sdkPath, 'lmui.js');
  if (!fs.existsSync(sdk)) return { ok: false, reason: `sdk gone: ${sdk}` };
  return { ok: true };
}

export async function statusOf(s: UiPageState, uiWebPort: number | null): Promise<UiPageStatus> {
  const alive = pidAlive(s.pid);
  const serving = alive ? await probeHttp(s.port, `/${s.service}/index.html`) : false;
  const r = alive ? { ok: true as const } : respawnable(s);
  const autoStart = autoStartEnabled(s.uiId);
  const issues: string[] = [];
  if (!alive) issues.push(r.ok ? (autoStart ? 'process dead (respawns on boot)' : 'process dead (autostart disabled)') : `stale: ${r.reason}`);
  if (alive && !serving) issues.push('process alive but HTTP probe failed');
  if (uiWebPort !== null && s.port !== uiWebPort) issues.push(`port ${s.port} ≠ uiWebPort ${uiWebPort} — unreachable through the hub`);
  return {
    ...s, alive, serving,
    reachableViaHub: serving && uiWebPort !== null && s.port === uiWebPort,
    stale: !alive && !r.ok,
    autoStart,
    issue: issues.length ? issues.join('; ') : undefined,
  };
}

export async function uiPagesReport(uiWebPort: number | null, routeActive: boolean, uiAppsDir: string): Promise<UiPagesReport> {
  const pages = await Promise.all(listStateFiles().map((s) => statusOf(s, uiWebPort)));
  return { uiWebPort, routeActive, uiAppsDir, pages };
}

function spawnLmui(s: UiPageState): { ok: boolean; error?: string } {
  try {
    // Foreground `start`: lmui daemonizes itself (detached spawn of `lmui dev`) and
    // rewrites its own pid/state files — we only kick it off and let it own the record.
    const child = spawn(process.execPath, [path.join(s.sdkPath, 'lmui.js'), 'start'], {
      cwd: s.dir, detached: true, stdio: 'ignore',
      env: { ...process.env, PORT: String(s.port) },
    });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface RespawnResult { uiId: string; action: 'alive' | 'respawned' | 'skipped'; reason?: string }

/** Respawn every dead-but-respawnable page. Called on Core boot when the /ui-* route is
 *  configured; also reachable via the control route for manual recovery. */
export function respawnDeadPages(log: (msg: string) => void = () => {}): RespawnResult[] {
  const results: RespawnResult[] = [];
  for (const s of listStateFiles()) {
    if (pidAlive(s.pid)) { results.push({ uiId: s.uiId, action: 'alive' }); continue; }
    if (!autoStartEnabled(s.uiId)) {
      results.push({ uiId: s.uiId, action: 'skipped', reason: 'autostart disabled' });
      log(`[ui-pages] NOT respawning ${s.uiId}: autostart disabled`);
      continue;
    }
    const r = respawnable(s);
    if (!r.ok) {
      results.push({ uiId: s.uiId, action: 'skipped', reason: r.reason });
      log(`[ui-pages] NOT respawning ${s.uiId}: ${r.reason}`);
      continue;
    }
    const sp = spawnLmui(s);
    results.push(sp.ok ? { uiId: s.uiId, action: 'respawned' } : { uiId: s.uiId, action: 'skipped', reason: sp.error });
    log(sp.ok ? `[ui-pages] respawned ${s.uiId} (port ${s.port})` : `[ui-pages] respawn of ${s.uiId} failed: ${sp.error}`);
  }
  return results;
}

/** Verify a recorded pid actually belongs to an lmui process before signalling it —
 *  never trust a stale pidfile (the pid may have been recycled by an unrelated process). */
export function pidLooksLikeLmui(pid: number): boolean {
  try {
    if (process.platform === 'linux') {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      return cmdline.includes('lmui.js');
    }
    // Non-Linux: no cheap cmdline read; fall back to "alive" (the stop path is only used
    // by the owner about their own state files, and lmui stop has the same exposure).
    return pidAlive(pid);
  } catch { return false; }
}

// An explicit stop parks the state as stopped-<uiId>.json: the dev-*.json contract file
// is removed (so boot-respawn honors the stop), but `start` can still resurrect it
// without the author re-running lmui in the app dir. lmui never reads this file.
const stoppedFile = (uiId: string): string => path.join(runDir(), `stopped-${uiId}.json`);

function readStopped(uiId: string): UiPageState | null {
  try { return JSON.parse(fs.readFileSync(stoppedFile(uiId), 'utf8')) as UiPageState; } catch { return null; }
}

export async function controlPage(uiId: string, action: 'start' | 'stop'): Promise<{ ok: boolean; detail: string }> {
  let s = listStateFiles().find((x) => x.uiId === uiId);
  if (!s && action === 'start') {
    const parked = readStopped(uiId);
    if (parked) s = parked;
  }
  if (!s) return { ok: false, detail: `no state file for ${uiId} — start it once with 'lmui start' in its app dir (state lives in ~/.lmui/)` };
  if (action === 'start') {
    if (pidAlive(s.pid)) return { ok: true, detail: `${uiId} already running (pid ${s.pid})` };
    const r = respawnable(s);
    if (!r.ok) return { ok: false, detail: `cannot start ${uiId}: ${r.reason}` };
    const sp = spawnLmui(s);
    if (sp.ok) { try { fs.unlinkSync(stoppedFile(uiId)); } catch { /* wasn't parked */ } }
    return sp.ok ? { ok: true, detail: `started ${uiId} (port ${s.port})` } : { ok: false, detail: sp.error || 'spawn failed' };
  }
  // stop
  if (!pidAlive(s.pid)) return { ok: true, detail: `${uiId} already stopped` };
  if (!pidLooksLikeLmui(s.pid)) return { ok: false, detail: `pid ${s.pid} does not look like an lmui process — refusing to signal it` };
  try {
    process.kill(s.pid); // SIGTERM, same as lmui stop
    try { fs.writeFileSync(stoppedFile(uiId), JSON.stringify(s, null, 2) + '\n'); } catch { /* resurrect via lmui then */ }
    try { fs.unlinkSync(path.join(runDir(), `dev-${uiId}.pid`)); } catch { /* lmui's file */ }
    try { fs.unlinkSync(path.join(runDir(), `dev-${uiId}.json`)); } catch { /* lmui's file */ }
    return { ok: true, detail: `stopped ${uiId} (pid ${s.pid})` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
