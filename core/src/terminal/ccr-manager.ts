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
import { spawn } from '../utils/exec';
import { execFileSync } from '../utils/exec';
import { TerminalError } from './errors';
import { sessionVerdict } from './cc-sessions';
import type { ConnectStrategy } from './cc-sessions';

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
  // On hosts that MITM api.anthropic.com (e.g. lm-proxy on 123), the spawned ccr
  // scripts need the proxy CA or every fetch fails TLS. Pass through the service env
  // if set, else auto-detect a known lm-proxy CA. No-op where neither exists.
  if (!env.NODE_EXTRA_CA_CERTS) {
    for (const ca of [process.env.LM_ASSIST_EXTRA_CA, '/home/yi/lm-proxy/ca/ca.crt']) {
      if (ca && fs.existsSync(ca)) { env.NODE_EXTRA_CA_CERTS = ca; break; }
    }
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

  // Bridge writes URL to its own /tmp/ccr-bridge.log via its log() function
  const webUrl = await pollForUrl(logFile, 30_000);

  const rec: CcrRecord = {
    id,
    mode: 'connected',
    sessionId,
    jsonl: jsonlPath,
    pid: child.pid ?? null,
    webUrl,
    strategy: v.connectStrategy,
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
  delete data[id];
  saveRegistry(data);
  return { stopped: true, wasAlive };
}
