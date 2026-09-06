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

import { isProcessAlive } from '../utils/process-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spawn } from '../utils/exec';
import { execFileSync } from '../utils/exec';
import { TerminalError, type TerminalErrorCode } from './errors';
import { sendKeys as tmuxSendKeys } from './tmux';
import { sessionVerdict } from './cc-sessions';
import type { ConnectStrategy } from './cc-sessions';
import { anthropicOAuthPost, getOrganizationUuid } from '../utils/claude-oauth';
import {
  computeLiveness,
  reapRecords,
  DEFAULT_REAP_AFTER_MS,
  type CcrLiveness,
  type LivenessDeps,
} from './ccr-liveness';

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
  /** 'inject' = native /remote-control connect into a LIVE session (no tmux owned);
   *  'native' = we created the tmux and ran `claude --resume … --remote-control`
   *  (Claude Code owns the bridge; webUrl is the bridge id IT recorded). */
  strategy?: ConnectStrategy | 'inject' | 'native';
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

/**
 * Liveness probes for ccr-liveness.ts.
 *
 * `sessionLive` is the one that matters: the registry's own `pid` belongs to the
 * detached ccr-bridge.js relay, NOT to `claude`, so it can never answer "is this
 * session alive?". sessionVerdict can — it carries the pid-alive check, the /proc
 * starttime pid-reuse guard, and the tmux pane mapping.
 */
function livenessDeps(): LivenessDeps {
  return {
    pidAlive: (pid) => isAlive(pid),
    sessionLive: (sessionId) => {
      const v = sessionVerdict(sessionId);
      return { live: v.live, pid: v.owner?.pid ?? null, tmuxSession: v.tmuxSession ?? null };
    },
    tmuxExists: (name) => {
      const tmux = require('./tmux') as typeof import('./tmux');
      return tmux.exists(name);
    },
  };
}

function reapTtlMs(): number {
  const raw = parseInt(process.env.CCR_REAP_AFTER_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REAP_AFTER_MS;
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
 *   LIVE session (attach-existing OR refuse) → ensureRemoteControlled ladder:
 *     inject /remote-control in place; kill-and-resume only when idle or force:true
 *   create-tmux  → only if safeToCreateTmux===true (no live owner)
 *   none         → throws SESSION_NOT_FOUND (HTTP 404)
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

/**
 * Resume-fidelity: the flags that restore the session's recorded permission
 * mode. A plain `claude --resume` comes up in the DEFAULT mode, silently
 * downgrading e.g. a bypass-permissions session (found live 2026-07-22: a
 * restarted session's MCP call was blocked by "don't ask" that the original
 * never ran under). The jsonl records permissionMode per turn — the LAST one
 * is the session's current operating mode. Restoring the mode the user already
 * granted is fidelity, not escalation.
 */
/**
 * SECURITY MODEL (reviewed 2026-07-22): this restores a mode the session
 * ALREADY ran under — it grants an API caller nothing new, because (a) the
 * transcript is writable only by the local user, who could equally run
 * `claude --dangerously-skip-permissions` directly (same trust domain), and
 * (b) the Core API key already launches bypass sessions by design
 * (tmux-backend launch, skipPermissions defaults true). Injection is
 * precluded: the regex captures [A-Za-z]+ only, and the value must ALSO be
 * in the strict allowlist below — an unknown/tampered mode restores nothing.
 */
const RESUME_MODE_FLAGS: Record<string, string> = {
  bypassPermissions: ' --dangerously-skip-permissions',
  acceptEdits: ' --permission-mode acceptEdits',
  plan: ' --permission-mode plan',
  dontAsk: ' --permission-mode dontAsk',
  default: '',
};

export function resumePermissionFlags(jsonlPath: string): string {
  let mode: string | null = null;
  try {
    const text = fs.readFileSync(jsonlPath, 'utf-8');
    const re = /"permissionMode":"([A-Za-z]+)"/g;
    for (let m = re.exec(text); m; m = re.exec(text)) mode = m[1];
  } catch { /* unknown → default */ }
  // Strict allowlist — anything unknown (corrupt/tampered transcript, or a
  // future mode this build doesn't know) restores NO flag (default mode).
  return (mode && RESUME_MODE_FLAGS[mode]) || '';
}

/**
 * Map an EnsureResult state to a TerminalError code+message, or null on success.
 * Used by connect() to surface clear errors from the ensure ladder.
 */
export function mapEnsureToConnectError(state: string): { code: TerminalErrorCode; message: string } | null {
  switch (state) {
    case 'connected':
    case 'already-connected': return null;
    case 'needs-force': return { code: 'CONFLICT', message: 'live session is busy/unreachable; pass force:true to kill-and-resume (idle sessions auto-kill)' };
    case 'kill-failed': return { code: 'CONFLICT', message: 'owner process did not terminate; not resuming over a live process' };
    case 'gone': return { code: 'SESSION_NOT_FOUND', message: 'no transcript and no live process on this host' };
    default: return { code: 'INTERNAL_ERROR', message: 'remote-control connect failed' };
  }
}

/**
 * Spawn the tmux bridge for a DEAD (or freshly-killed) session.
 * Handles both 'attach-existing' (live in tmux) and 'create-tmux' (no live owner)
 * strategies verbatim from the original connect() body.
 *
 * IMPORTANT: Only call this for a dead session (create-tmux verdict) or as the
 * resumeDead callback after a kill — NEVER directly for a live session.
 */
async function connectDeadCreateTmux(sessionId: string): Promise<CcrRecord> {
  const v = sessionVerdict(sessionId);
  const jsonlPath = v.jsonl!;

  let tmuxSession: string;

  if (v.connectStrategy === 'attach-existing') {
    tmuxSession = v.tmuxSession!;
  } else {
    // create-tmux — extra guard: safeToCreateTmux must be true
    if (!v.safeToCreateTmux) {
      throw new TerminalError('CONFLICT', `safeToCreateTmux=false despite strategy=create-tmux: ${v.reason}`, { verdict: v });
    }
    tmuxSession = `ccr-${sessionId.slice(0, 8)}`;
    const cwd = resolveSessionCwd(jsonlPath);
    // Restore the session's recorded permission mode — a bare `claude --resume`
    // silently downgrades it to default (see resumePermissionFlags).
    execFileSync('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', cwd, `claude --resume ${sessionId}${resumePermissionFlags(jsonlPath)}`], {
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

/**
 * Build and save a CcrRecord for a native /remote-control connection (no tmux owned).
 * webUrl is derived from e.cse so that cseFromWebUrl(rec.webUrl) === e.cse, which
 * means ccr_drive's cloud path resolves the right cse.
 */
async function recordForLiveConnection(
  sessionId: string,
  e: { state: string; cse?: string },
): Promise<CcrRecord> {
  const id = newCcrId();
  // e.cse is 'cse_<X>'; webUrl must be 'https://claude.ai/code/session_<X>'
  // so that cseFromWebUrl(webUrl) round-trips back to e.cse.
  const webUrl = e.cse ? `https://claude.ai/code/${e.cse.replace(/^cse_/, 'session_')}` : null;
  const rec: CcrRecord = {
    id,
    mode: 'connected',
    sessionId,
    jsonl: null,
    pid: null,
    webUrl,
    strategy: 'inject',
    ownsTmux: false,
    logFile: null,
    startedAt: new Date().toISOString(),
  };
  const data = loadRegistry();
  data[id] = rec;
  saveRegistry(data);
  return rec;
}

/**
 * Resume a DEAD session NATIVELY remote-controlled: tmux → `claude --resume <sid>
 * --remote-control` (+ the recorded permission mode), then OBSERVE the bridge id
 * Claude Code records for it (`bridgeSessionId` in ~/.claude/sessions). No
 * ccr-bridge.js, so no new claude.ai session is minted — the session keeps (or
 * Claude Code re-binds) its own link. See ccr-native-resume.ts for why.
 *
 * Only for a session with NO live owner (create-tmux verdict). Never call it
 * for a live session — the caller (restart / connect) enforces the kill-verify.
 */
export async function connectDeadNative(
  sessionId: string,
  opts: { waitMs?: number } = {},
): Promise<CcrRecord & { bridgeSessionId: string | null; resumedPid: number | null }> {
  const { nativeResumeCommand, bridgeWebUrl, waitForNativeBridge } = require('./ccr-native-resume') as typeof import('./ccr-native-resume');
  const v = sessionVerdict(sessionId);
  if (v.connectStrategy === 'none') throw new TerminalError('SESSION_NOT_FOUND', v.reason, { verdict: v });
  if (v.live || v.connectStrategy !== 'create-tmux' || !v.safeToCreateTmux) {
    throw new TerminalError('CONFLICT', `native resume needs an UNOWNED session (got ${v.connectStrategy}): ${v.reason}`, { verdict: v });
  }
  const jsonlPath = v.jsonl!;
  const tmuxSession = `ccr-${sessionId.slice(0, 8)}`;
  const cwd = resolveSessionCwd(jsonlPath);
  execFileSync('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', cwd, nativeResumeCommand(sessionId, resumePermissionFlags(jsonlPath))], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  await acceptTrustIfPrompted(tmuxSession);

  const obs = await waitForNativeBridge(sessionId, {
    lookup: (sid) => {
      const w = sessionVerdict(sid);
      return w.live && w.owner ? { pid: w.owner.pid, bridgeSessionId: w.owner.bridgeSessionId ?? null } : null;
    },
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  }, { timeoutMs: opts.waitMs ?? 45_000 });

  const bridgeSessionId = obs?.bridgeSessionId ?? null;
  const rec: CcrRecord = {
    id: newCcrId(),
    mode: 'connected',
    sessionId,
    jsonl: jsonlPath,
    pid: null,
    webUrl: bridgeWebUrl(bridgeSessionId),
    strategy: 'native',
    tmuxSession,
    ownsTmux: true,
    logFile: null,
    startedAt: new Date().toISOString(),
  };
  const data = loadRegistry();
  data[rec.id] = rec;
  saveRegistry(data);
  return { ...rec, bridgeSessionId, resumedPid: obs?.pid ?? null };
}

export async function connect({ sessionId, force }: { sessionId: string; force?: boolean }): Promise<CcrRecord> {
  const v = sessionVerdict(sessionId);

  if (v.connectStrategy === 'none') {
    throw new TerminalError('SESSION_NOT_FOUND', v.reason, { verdict: v });
  }

  // LIVE session (attach-existing OR refuse) → inject-first / kill-gated ladder
  if (v.live) {
    const { buildEnsureDeps } = require('./live-rc-connect-deps') as typeof import('./live-rc-connect-deps');
    const { ensureRemoteControlled } = require('./live-rc-connect') as typeof import('./live-rc-connect');
    const deps = buildEnsureDeps({
      // resumeDead here means: process already died between verdict and now →
      // use the existing create-tmux bridge path. Build inline to avoid recursion.
      resumeDead: async (sid) => {
        const rec = await connectDeadCreateTmux(sid);
        return { ok: !!rec.webUrl, cse: cseFromWebUrl(rec.webUrl) ?? undefined };
      },
    });
    const e = await ensureRemoteControlled(sessionId, { force }, deps);
    const errMap = mapEnsureToConnectError(e.state);
    if (errMap) throw new TerminalError(errMap.code, errMap.message, { ensure: e });
    // success → return a CcrRecord describing the live /remote-control connection
    return await recordForLiveConnection(sessionId, e);
  }

  // DEAD (create-tmux) — unchanged path
  return connectDeadCreateTmux(sessionId);
}

/**
 * RESTART a local session's process so it re-fetches its MCP tool list (Claude
 * Code loads MCP tools at process start only — no in-place reload exists).
 *
 * Corruption-safe by construction (ccr-restart.ts orchestrates): stops existing
 * bridge remotes → kills the live owner (SIGTERM→verify→SIGKILL→verify) → an
 * INDEPENDENT re-verdict must agree nothing owns the session → only then spawns
 * the fresh `claude --resume`. A busy (mid-turn) session is refused without
 * force:true. kill-failed ⇒ ABORT, never resume over a live process.
 *
 * Every outcome with a reachable pane carries the SCREEN verbatim (see
 * ccr-restart.ts): the caller reads what the session is actually showing instead
 * of trusting `state:'restarted'` to mean "usable". The busy refusal returns
 * immediately with the screen rather than waiting — waiting is opt-in via waitMs.
 */
export interface RestartBridgeInfo {
  /** the bridge id the session had BEFORE the restart (null = was not remote-controlled) */
  previousBridgeSessionId: string | null;
  /** the bridge id Claude Code recorded AFTER the native resume (null = did not connect in time) */
  bridgeSessionId: string | null;
  verdict: import('./ccr-native-resume').ReclaimVerdict;
  /** 'native' = claude --resume --remote-control (no new session minted); 'bridge' = legacy ccr-bridge.js (mints a NEW claude.ai session) */
  resumeMode: 'native' | 'bridge';
}

export async function restart({ sessionId, force, waitMs, native }: { sessionId: string; force?: boolean; waitMs?: number; native?: boolean }): Promise<import('./ccr-restart').RestartResult & { bridge?: RestartBridgeInfo }> {
  const { restartLocal } = require('./ccr-restart') as typeof import('./ccr-restart');
  const { killOwner: killOwnerPrim } = require('./live-rc-connect') as typeof import('./live-rc-connect');
  const { describeReclaim } = require('./ccr-native-resume') as typeof import('./ccr-native-resume');
  const IS_WINDOWS = process.platform === 'win32';
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  // Native is the DEFAULT: the legacy bridge mints a NEW claude.ai session on every
  // restart (three lost links on 117, 2026-09). Opt out only with native:false.
  const useNative = native !== false;
  // Remember the link the session had, so the result can say whether it survived.
  let previousBridgeSessionId: string | null = null;
  try { previousBridgeSessionId = sessionVerdict(sessionId).owner?.bridgeSessionId ?? null; } catch { /* not live — fine */ }
  let observedBridge: string | null = null;

  const r = await restartLocal(sessionId, { force, waitMs }, {
    now: () => Date.now(),
    verdict: (sid) => {
      const v = sessionVerdict(sid);
      return {
        live: v.live, connectStrategy: v.connectStrategy, pid: v.owner?.pid ?? null,
        tmuxSession: v.tmuxSession ?? null, updatedAt: v.owner?.updatedAt,
      };
    },
    // Real activity detection. The modern TUI keeps the ❯ input box visible
    // DURING work, so inspector's "footer+prompt ⇒ idle" is unreliable mid-turn
    // (observed live 2026-07-22: phase read 'idle' while a Bash tool ran).
    // Robust order:
    //   1. the in-progress marker on screen ("esc to interrupt" spinner) ⇒ busy;
    //   2. transcript mtime fresh (a streaming turn appends continuously; also
    //      covers just-submitted-before-any-render) ⇒ busy;
    //   3. inspector phase idle ⇒ idle; anything else ⇒ unknown (conservative
    //      transcript-age gate applies).
    phase: (sid) => {
      try {
        const v = sessionVerdict(sid);
        if (!v.tmuxSession) return 'unknown';
        const tmux = require('./tmux') as typeof import('./tmux');
        const screen = tmux.capture(v.tmuxSession, { paneQualifier: null, lines: null, start: null });
        // ACTIVE-work markers (observed live 2026-07-22 on this TUI version):
        //   "✽ Infusing… (37s · ↓ 650 tokens)"  ← running spinner: glyph + word + "… (Ns"
        //   a finished turn renders "✻ Cogitated for 25s" (no paren) — no false match.
        // "esc to interrupt" kept for TUI versions that render it.
        if (screen.includes('esc to interrupt')) return 'busy';
        if (/[✻✶✽✢✳✺·]\s?\S+…\s*\(\d+s/.test(screen)) return 'busy';
        if (/↓\s*\d+\s+tokens/.test(screen)) return 'busy'; // streaming counter
        if (v.jsonl) {
          try {
            const age = Date.now() - fs.statSync(v.jsonl).mtimeMs;
            if (age < 12_000) return 'busy'; // records still flushing — the turn is live
          } catch { /* stat failed — fall through */ }
        }
        const { getCCState } = require('./inspector') as typeof import('./inspector');
        const p = getCCState(v.tmuxSession).phase;
        if (p === 'idle') return 'idle';
        if (p === 'busy') return 'busy';
        return 'unknown';
      } catch { return 'unknown'; }
    },
    sleep,
    stopExistingRemotes: async (sid) => {
      let n = 0;
      for (const rec of Object.values(loadRegistry())) {
        if (rec.sessionId !== sid) continue;
        try { await stop(rec.id); n++; } catch { /* per-record best-effort */ }
      }
      return n;
    },
    killOwner: (pid) => killOwnerPrim(pid, { isWindows: IS_WINDOWS }, {
      // isProcessAlive, not a bare signal-0: a Linux ZOMBIE answers signal 0 and
      // would read as "never terminated" (→ kill-failed) forever.
      isAlive: (p) => isProcessAlive(p),
      signal: (p, sig) => process.kill(p, sig),
      taskkill: (p) => { execFileSync('taskkill', ['/PID', String(p), '/T', '/F'], { encoding: 'utf-8', timeout: 8000 }); },
      sleep,
    }),
    killStaleCcrTmux: async (sid) => {
      const name = `ccr-${sid.slice(0, 8)}`;
      try { execFileSync('tmux', ['kill-session', '-t', name], { encoding: 'utf-8', timeout: 5000 }); } catch { /* not there — fine */ }
    },
    // The pane, verbatim — the same bytes terminal_capture would return. Prefer the
    // caller's hint (the FRESH resume's own tmux, which sessionVerdict may not have
    // caught up to yet) and fall back to whatever the verdict knows. Never throws:
    // an unreadable screen must not fail a restart, it just isn't reported.
    captureScreen: (sid, tmuxSession) => {
      try {
        let name = typeof tmuxSession === 'string' && tmuxSession ? tmuxSession : null;
        if (!name) name = sessionVerdict(sid).tmuxSession ?? null;
        if (!name) return null;
        const tmux = require('./tmux') as typeof import('./tmux');
        return { tmuxSession: name, screen: tmux.capture(name, { paneQualifier: null, lines: null, start: null }) };
      } catch { return null; }
    },
    resume: async (sid) => {
      if (!useNative) return connectDeadCreateTmux(sid);
      const rec = await connectDeadNative(sid);
      observedBridge = rec.bridgeSessionId;
      return rec;
    },
  });

  const current = useNative ? observedBridge : ((r.record as CcrRecord | undefined)?.webUrl ?? null);
  const bridge: RestartBridgeInfo = {
    previousBridgeSessionId,
    bridgeSessionId: current,
    verdict: describeReclaim(previousBridgeSessionId, current),
    resumeMode: useNative ? 'native' : 'bridge',
  };
  if (!r.ok) {
    const code: TerminalErrorCode =
      r.state === 'gone' ? 'SESSION_NOT_FOUND'
      : r.state === 'needs-force' || r.state === 'kill-failed' ? 'CONFLICT'
      : 'INTERNAL_ERROR';
    throw new TerminalError(code, r.reason, { restart: r, bridge });
  }
  const note =
    bridge.verdict === 'reclaimed' ? ' — the session came back on its ORIGINAL remote-control bridge (same claude.ai/code link)'
    : bridge.verdict === 'new-bridge' ? ' — Claude Code bound a NEW bridge id; the old claude.ai/code link is dead, use the new webUrl'
    : bridge.verdict === 'first-bridge' ? ' — now remote-controlled (it was not before)'
    : useNative ? ' — resumed, but no remote-control bridge id was recorded within the wait window; it may still connect (re-check cc_sessions) or run ccr_connect'
    : '';
  return { ...r, reason: r.reason + note, bridge };
}

/**
 * List all registered remotes with CROSS-CHECKED liveness, reaping entries that are
 * both not-alive and older than the TTL.
 *
 * `alive` here means "the session behind this entry is live" — cross-checked against
 * the session registry / tmux — NOT "the bridge helper's pid responds", which is what
 * it used to mean and why this listing once reported 3/3 dead for 3 live sessions.
 *
 * Reaping is bookkeeping only (it drops rows, never signals a process), so it is safe
 * on a read path. A failed cleanup write must never fail the read.
 */
export function list(): { rows: Array<CcrRecord & CcrLiveness>; reaped: string[] } {
  const data = loadRegistry();
  const { kept, rows, reaped, changed } = reapRecords(data, livenessDeps(), {
    now: Date.now(),
    ttlMs: reapTtlMs(),
  });
  if (changed) {
    try { saveRegistry(kept); } catch { /* a read must not fail because cleanup could not persist */ }
  }
  return { rows, reaped };
}

/** Get a single remote by id. */
export function get(id: string): (CcrRecord & CcrLiveness) | undefined {
  const rec = loadRegistry()[id];
  if (!rec) return undefined;
  return { ...rec, ...computeLiveness(rec, livenessDeps()) };
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

/**
 * Find the best live `connected` bridge record for a session id (most-recent, alive-preferred).
 *
 * Preference is on SESSION liveness, not the bridge pid: a live session whose relay
 * helper has exited is the best drive target there is, yet the old bridge-pid test
 * ranked it below nothing and fell through to `recs[0]`.
 */
function pickConnectedBySession(sessionId: string): CcrRecord | undefined {
  const recs = Object.values(loadRegistry())
    .filter((r) => r.mode === 'connected' && r.sessionId === sessionId)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)); // most-recent first
  if (recs.length <= 1) return recs[0];
  const deps = livenessDeps();
  return recs.find((r) => computeLiveness(r, deps).alive) || recs[0];
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
async function driveViaTmux(tmux: string, text: string): Promise<void> {
  // Same shape as the bridge's send-keys {literal:true, enter:true}, but through
  // the hardened path: trailing-`;`/leading-`-` survive, multiline lands as ONE
  // paste instead of submitting per line, and the per-session lock keeps a
  // concurrent cc.prompt from interleaving with the Enter.
  await tmuxSendKeys(tmux, { keys: text, literal: true, enter: true, paneQualifier: null });
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
      await driveViaTmux(tmux, text);
      return { ...base, path: 'tmux', delivered: true, fellBack: true, detail: `cloud failed (${(e as Error).message}); delivered via tmux` };
    }
  }

  // planned === 'tmux'
  await driveViaTmux(tmux!, text);
  return { ...base, path: 'tmux', delivered: true };
}
