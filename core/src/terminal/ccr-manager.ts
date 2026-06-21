/**
 * CCR (Claude Code Remote) manager.
 *
 * Spawns and tracks detached ccr/* scripts for load, mirror, and connect
 * modes. Enforces the safety gate on connect: NEVER create a new tmux
 * `claude --resume` if a live process already owns the session (double-write
 * corrupts the append-only .jsonl).
 *
 * Registry: ~/.cache/lm-assist/ccr-remotes.json — same atomic-write pattern
 * as terminal/registry.ts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spawn } from '../utils/exec';
import { execFileSync } from '../utils/exec';
import { TerminalError } from './errors';
import { sessionVerdict } from './cc-sessions';
import type { ConnectStrategy } from './cc-sessions';
import { anthropicOAuthPost, getOrganizationUuid } from '../utils/claude-oauth';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CACHE_DIR = path.join(os.homedir(), '.cache', 'lm-assist');
const REGISTRY_FILE = path.join(CACHE_DIR, 'ccr-remotes.json');
const REGISTRY_TMP = path.join(CACHE_DIR, 'ccr-remotes.json.tmp');

// ccr/ lives 3 levels above __dirname (core/dist/terminal → core/dist → core → repo root)
const CCR_DIR = path.join(__dirname, '..', '..', '..', 'ccr');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CcrRecord {
  id: string;
  mode: 'load' | 'mirror' | 'connected';
  sessionId: string | null;
  jsonl: string | null;
  pid: number | null;
  webUrl: string | null;
  strategy?: ConnectStrategy;
  /** tmux session backing a `connect`; set for both attach-existing and create-tmux. */
  tmuxSession?: string;
  /** true only when WE created the tmux (create-tmux) — stop() may kill it. Never kill a user's existing tmux. */
  ownsTmux?: boolean;
  logFile: string | null;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Registry helpers (simplified, single-writer in this process)
// ---------------------------------------------------------------------------

function loadRegistry(): Record<string, CcrRecord> {
  try {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, CcrRecord>;
    }
  } catch {
    // missing or corrupt — start fresh
  }
  return {};
}

function saveRegistry(data: Record<string, CcrRecord>): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const json = JSON.stringify(data, null, 2) + '\n';
  const fd = fs.openSync(REGISTRY_TMP, 'w');
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(REGISTRY_TMP, REGISTRY_FILE);
}

function newCcrId(): string {
  return 'ccr-' + Math.random().toString(36).slice(2, 10).padEnd(8, '0').slice(0, 8);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAlive(pid: number | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Build spawn env — always pass NODE_EXTRA_CA_CERTS through if set (for lm-proxy). */
function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // On hosts that MITM api.anthropic.com (e.g. an lm-proxy), the spawned ccr scripts
  // need the proxy CA or every fetch fails TLS. Honor an explicitly-configured extra
  // CA (`lm-assist serve --extra-ca <path>` / LM_ASSIST_EXTRA_CA) when the service env
  // doesn't already set NODE_EXTRA_CA_CERTS. No-op when neither is configured.
  if (!env.NODE_EXTRA_CA_CERTS) {
    const ca = process.env.LM_ASSIST_EXTRA_CA;
    if (ca && fs.existsSync(ca)) env.NODE_EXTRA_CA_CERTS = ca;
  }
  return env;
}

/** Open a writable log file fd for spawn stdio. */
function openLogFd(logFile: string): number {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  return fs.openSync(logFile, 'a');
}

/**
 * Poll a log file for a line matching `URL https://...`.
 * Returns the URL or null on timeout.
 * Checks both the provided file and /tmp/ccr-bridge.log (for the bridge).
 */
async function pollForUrl(logFile: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  const urlRe = /URL (https:\/\/claude\.ai\/code\/\S+)/;
  while (Date.now() < deadline) {
    for (const f of [logFile]) {
      try {
        const content = fs.readFileSync(f, 'utf-8');
        const m = content.match(urlRe);
        if (m) return m[1];
      } catch { /* not written yet */ }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Drive helpers (pure — unit-tested in __tests__/ccr-drive.test.ts)
// ---------------------------------------------------------------------------

/** Derive the cloud-session id (cse_…) from a bridge webUrl (…/code/session_<X>). */
export function cseFromWebUrl(webUrl: string | null | undefined): string | null {
  if (!webUrl) return null;
  const m = webUrl.match(/\/code\/session_([A-Za-z0-9]+)/);
  return m ? `cse_${m[1]}` : null;
}

export type DrivePath = 'cloud' | 'tmux' | 'none';

/**
 * Decide how to deliver a turn: the claude.ai CLOUD endpoint is primary (it
 * reaches the session from anywhere, incl. off-host drivers); direct tmux
 * send-keys is the same-host SECOND option. `preferTmux` flips the order when
 * a tmux is available (skips the cloud round-trip on the local host).
 */
export function chooseDrivePath(opts: { cse: string | null; tmux: string | null; preferTmux?: boolean }): DrivePath {
  const { cse, tmux, preferTmux } = opts;
  if (preferTmux && tmux) return 'tmux';
  if (cse) return 'cloud';
  if (tmux) return 'tmux';
  return 'none';
}

/** Build the client `user` event payload claude.ai posts to /{cse}/events. */
export function buildUserEventPayload(cse: string, text: string, uuid?: string) {
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content: [{ type: 'text' as const, text }] },
    uuid: uuid || randomUUID(),
    session_id: cse,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawn ccr-load-session.js (read-only replay) detached.
 * Polls the log file for the printed `URL https://...` line and returns it.
 */
export async function startLoad({ sessionId, jsonl }: { sessionId?: string; jsonl?: string }): Promise<CcrRecord> {
  let resolvedJsonl = jsonl;
  if (!resolvedJsonl && sessionId) {
    const v = sessionVerdict(sessionId);
    if (!v.jsonl) throw new TerminalError('SESSION_NOT_FOUND', `no transcript found for session ${sessionId}`);
    resolvedJsonl = v.jsonl;
  }
  if (!resolvedJsonl) throw new TerminalError('INVALID_INPUT', 'provide sessionId or jsonl path');
  if (!fs.existsSync(resolvedJsonl)) throw new TerminalError('INVALID_INPUT', `jsonl not found: ${resolvedJsonl}`);

  const id = newCcrId();
  const logFile = path.join(CACHE_DIR, `${id}.log`);
  const fd = openLogFd(logFile);

  const child = spawn(process.execPath, [path.join(CCR_DIR, 'ccr-load-session.js'), resolvedJsonl], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: buildEnv(),
  });
  child.unref();
  try { fs.closeSync(fd); } catch { /* ignore */ }

  const pid = child.pid ?? null;

  // load-session.js runs to completion and prints URL on the last line — poll up to 90s
  const webUrl = await pollForUrl(logFile, 90_000);

  const rec: CcrRecord = {
    id,
    mode: 'load',
    sessionId: sessionId ?? null,
    jsonl: resolvedJsonl,
    pid,
    webUrl,
    logFile,
    startedAt: new Date().toISOString(),
  };
  const data = loadRegistry();
  data[id] = rec;
  saveRegistry(data);
  return rec;
}

/**
 * Spawn ccr-oneway-mirror.js (live one-way mirror) detached.
 * Resolves jsonl via sessionVerdict; returns the remote URL once printed.
 */
export async function startMirror({ sessionId }: { sessionId: string }): Promise<CcrRecord> {
  const v = sessionVerdict(sessionId);
  if (!v.jsonl) throw new TerminalError('SESSION_NOT_FOUND', `no transcript found for session ${sessionId}`);

  const id = newCcrId();
  const logFile = path.join(CACHE_DIR, `${id}.log`);
  const fd = openLogFd(logFile);

  const child = spawn(process.execPath, [path.join(CCR_DIR, 'ccr-oneway-mirror.js'), v.jsonl], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: buildEnv(),
  });
  child.unref();
  try { fs.closeSync(fd); } catch { /* ignore */ }

  const webUrl = await pollForUrl(logFile, 30_000);

  const rec: CcrRecord = {
    id,
    mode: 'mirror',
    sessionId,
    jsonl: v.jsonl,
    pid: child.pid ?? null,
    webUrl,
    logFile,
    startedAt: new Date().toISOString(),
  };
  const data = loadRegistry();
  data[id] = rec;
  saveRegistry(data);
  return rec;
}

/**
 * Connect to a session via two-way bridge.
 *
 * SAFETY GATE — enforced strictly:
 *   attach-existing  → attach existing tmux pane (no new tmux)
 *   create-tmux      → only if safeToCreateTmux===true (no live owner)
 *   refuse           → throws CONFLICT (HTTP 409); DO NOT SPAWN
 *   none             → throws SESSION_NOT_FOUND (HTTP 404)
 */
/** Best-effort: read the session's recorded cwd from its transcript (first entry with a cwd). */
/** Auto-accept Claude Code's folder-trust prompt if a freshly-resumed session blocks on it. */
async function acceptTrustIfPrompted(tmuxSession: string): Promise<void> {
  const TRUST = ['trust this folder', 'Quick safety check'];
  for (let i = 0; i < 20; i++) {
    let screen = '';
    try { screen = execFileSync('tmux', ['capture-pane', '-t', tmuxSession, '-p'], { encoding: 'utf-8' }); } catch { return; }
    if (TRUST.some((t) => screen.includes(t))) {
      try { execFileSync('tmux', ['send-keys', '-t', tmuxSession, '1', 'Enter']); } catch { /* ignore */ }
      return;
    }
    if (screen.includes('ctx:')) return; // already at prompt, no trust dialog
    await new Promise((r) => setTimeout(r, 500));
  }
}

function resolveSessionCwd(jsonlPath: string): string {
  try {
    const lines = fs.readFileSync(jsonlPath, 'utf-8').split(/\r?\n/).slice(0, 8);
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try { const r = JSON.parse(ln); if (r && typeof r.cwd === 'string' && r.cwd) return r.cwd; } catch { /* skip */ }
    }
  } catch { /* fall through */ }
  return os.homedir();
}

export async function connect({ sessionId }: { sessionId: string }): Promise<CcrRecord> {
  const v = sessionVerdict(sessionId);

  if (v.connectStrategy === 'refuse') {
    throw new TerminalError('CONFLICT', v.reason, { verdict: v });
  }
  if (v.connectStrategy === 'none') {
    throw new TerminalError('SESSION_NOT_FOUND', v.reason, { verdict: v });
  }

  let tmuxSession: string;
  const jsonlPath = v.jsonl!;

  if (v.connectStrategy === 'attach-existing') {
    tmuxSession = v.tmuxSession!;
  } else {
    // create-tmux — extra guard: safeToCreateTmux must be true
    if (!v.safeToCreateTmux) {
      throw new TerminalError('CONFLICT', `safeToCreateTmux=false despite strategy=create-tmux: ${v.reason}`, { verdict: v });
    }
    tmuxSession = `ccr-${sessionId.slice(0, 8)}`;
    const cwd = resolveSessionCwd(jsonlPath);
    execFileSync('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', cwd, `claude --resume ${sessionId}`], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    await acceptTrustIfPrompted(tmuxSession);
  }

  const id = newCcrId();
  const logFile = path.join(CACHE_DIR, `${id}.log`);
  const fd = openLogFd(logFile);

  const child = spawn(process.execPath, [path.join(CCR_DIR, 'ccr-bridge.js'), tmuxSession, jsonlPath, 'twoway'], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: buildEnv(),
  });
  child.unref();
  try { fs.closeSync(fd); } catch { /* ignore */ }

  // The bridge prints its URL to stdout (captured in the per-run logFile).
  const webUrl = await pollForUrl(logFile, 30_000);

  const rec: CcrRecord = {
    id,
    mode: 'connected',
    sessionId,
    jsonl: jsonlPath,
    pid: child.pid ?? null,
    webUrl,
    strategy: v.connectStrategy,
    tmuxSession,
    ownsTmux: v.connectStrategy === 'create-tmux',
    logFile,
    startedAt: new Date().toISOString(),
  };
  const data = loadRegistry();
  data[id] = rec;
  saveRegistry(data);
  return rec;
}

/** List all registered remotes with liveness. */
export function list(): Array<CcrRecord & { alive: boolean }> {
  return Object.values(loadRegistry()).map((rec) => ({ ...rec, alive: isAlive(rec.pid) }));
}

/** Get a single remote by id. */
export function get(id: string): (CcrRecord & { alive: boolean }) | undefined {
  const rec = loadRegistry()[id];
  if (!rec) return undefined;
  return { ...rec, alive: isAlive(rec.pid) };
}

/** Kill the child process and remove from registry. */
export async function stop(id: string): Promise<{ stopped: boolean; wasAlive: boolean }> {
  const data = loadRegistry();
  const rec = data[id];
  if (!rec) throw new TerminalError('SESSION_NOT_FOUND', `ccr remote ${id} not found`);

  let wasAlive = false;
  if (rec.pid) {
    try { process.kill(rec.pid, 'SIGTERM'); wasAlive = true; } catch { /* already gone */ }
  }
  // For a create-tmux connect WE own the tmux (running `claude --resume`); kill it too,
  // else the resumed claude leaks and the session stays "live". NEVER kill the tmux for
  // attach-existing — that is the user's own session.
  if (rec.ownsTmux && rec.tmuxSession) {
    try { execFileSync('tmux', ['kill-session', '-t', rec.tmuxSession], { encoding: 'utf-8', timeout: 5000 }); } catch { /* already gone */ }
  }
  delete data[id];
  saveRegistry(data);
  return { stopped: true, wasAlive };
}

// ---------------------------------------------------------------------------
// Drive — deliver a prompt (user turn) to a two-way connected session
// ---------------------------------------------------------------------------

export interface DriveResult {
  path: DrivePath;
  delivered: boolean;
  cse: string | null;
  sessionId: string | null;
  tmuxSession: string | null;
  /** Cloud-path result fields (from the /{cse}/events response). */
  eventId?: string;
  sequenceNum?: string;
  /** true when the cloud path was attempted, failed, and tmux took over. */
  fellBack?: boolean;
  detail?: string;
}

/** Find the best live `connected` bridge record for a session id (most-recent, alive-preferred). */
function pickConnectedBySession(sessionId: string): CcrRecord | undefined {
  const recs = Object.values(loadRegistry())
    .filter((r) => r.mode === 'connected' && r.sessionId === sessionId)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)); // most-recent first
  return recs.find((r) => isAlive(r.pid)) || recs[0];
}

/** POST a client `user` event to the public code-session endpoint (cloud relays it to the worker). */
async function driveViaCloud(cse: string, text: string): Promise<{ eventId?: string; sequenceNum?: string }> {
  const org = await getOrganizationUuid();
  const res = await anthropicOAuthPost(
    `/v1/code/sessions/${cse}/events`,
    { events: [{ payload: buildUserEventPayload(cse, text) }] },
    { betaHeader: 'ccr-byoc-2025-07-29', extraHeaders: { 'anthropic-version': '2023-06-01', 'x-organization-uuid': org } },
  );
  if (res.status < 200 || res.status >= 300) {
    throw new TerminalError('UPSTREAM_ERROR', `cloud drive failed: HTTP ${res.status} ${res.statusText}`, { status: res.status, body: res.body });
  }
  const r = res.body && Array.isArray(res.body.results) ? res.body.results[0] : undefined;
  return { eventId: r?.event_id, sequenceNum: r?.sequence_num != null ? String(r.sequence_num) : undefined };
}

/** Type a turn into the local tmux pane (literal text + Enter) — the same-host fallback. */
function driveViaTmux(tmux: string, text: string): void {
  // Matches the bridge's send-keys {literal:true, enter:true}: literal text, then Enter.
  execFileSync('tmux', ['send-keys', '-t', tmux, '-l', text], { encoding: 'utf-8', timeout: 5000 });
  execFileSync('tmux', ['send-keys', '-t', tmux, 'Enter'], { encoding: 'utf-8', timeout: 5000 });
}

/**
 * Deliver a prompt (a user turn) to a two-way connected session.
 *
 * Primary path = the claude.ai CLOUD endpoint (`POST /v1/code/sessions/{cse}/events`,
 * OAuth) which the cloud relays down the worker SSE the bridge holds → reaches the
 * local session from anywhere. Second option = same-host tmux send-keys. On cloud
 * failure, falls back to tmux when one is available (same host).
 *
 * Resolve the target by `id` (ccr remote id), `sessionId` (its live bridge), or an
 * explicit `cse`. `preferTmux` forces the same-host shortcut when a tmux exists.
 */
export async function drive(opts: {
  id?: string;
  sessionId?: string;
  cse?: string;
  text: string;
  preferTmux?: boolean;
}): Promise<DriveResult> {
  const text = (opts.text || '').toString();
  if (!text.trim()) throw new TerminalError('INVALID_INPUT', 'text is required');

  let rec: CcrRecord | undefined;
  if (opts.id) {
    rec = loadRegistry()[opts.id];
    if (!rec) throw new TerminalError('SESSION_NOT_FOUND', `ccr remote ${opts.id} not found`);
  } else if (opts.sessionId) {
    rec = pickConnectedBySession(opts.sessionId);
  }

  const cse = opts.cse || cseFromWebUrl(rec?.webUrl);
  const tmux = rec?.tmuxSession || null;
  const sessionId = rec?.sessionId ?? opts.sessionId ?? null;
  const base: DriveResult = { path: 'none', delivered: false, cse, sessionId, tmuxSession: tmux };

  const planned = chooseDrivePath({ cse, tmux, preferTmux: opts.preferTmux });
  if (planned === 'none') {
    throw new TerminalError(
      'SESSION_NOT_FOUND',
      'no live cloud bridge (cse) and no tmux for this target — start a two-way connect first (ccr_connect)',
    );
  }

  if (planned === 'cloud') {
    try {
      const r = await driveViaCloud(cse!, text);
      return { ...base, path: 'cloud', delivered: true, eventId: r.eventId, sequenceNum: r.sequenceNum };
    } catch (e) {
      if (!tmux) throw e;
      // cloud failed but we are same-host — fall back to tmux send-keys
      driveViaTmux(tmux, text);
      return { ...base, path: 'tmux', delivered: true, fellBack: true, detail: `cloud failed (${(e as Error).message}); delivered via tmux` };
    }
  }

  // planned === 'tmux'
  driveViaTmux(tmux!, text);
  return { ...base, path: 'tmux', delivered: true };
}
