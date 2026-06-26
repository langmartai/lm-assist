// Convert a LIVE local Claude Code session to remote-control IN PLACE by injecting
// the `/remote-control` slash command; gated kill-then-resume fallback when the
// input is unreachable (headless) or the inject fails. Pure decisions + no-throw
// I/O primitives + the ensureRemoteControlled orchestrator (injected deps).

export type Reachability = 'tmux' | 'windows' | 'none';

export type LiveAction =
  | 'resume-dead'
  | 'already-connected'
  | 'inject-tmux'
  | 'inject-windows'
  | 'kill'
  | 'needs-force';

/** Cloud statuses that are NOT an active connection (terminal/dead/unknown). */
export const DEAD_CLOUD_STATUSES = ['stopped', 'completed', 'failed', 'error', 'archived', 'unknown'];

export function classifyReachability(
  v: { live: boolean; inTmux: boolean },
  platform: { isWindows: boolean; windowsDriveable?: boolean },
): Reachability {
  if (!v.live) return 'none';
  if (platform.isWindows) return platform.windowsDriveable ? 'windows' : 'none';
  return v.inTmux ? 'tmux' : 'none';
}

export function idleMs(updatedAt: string | undefined, now: number): number {
  if (!updatedAt) return 0;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, now - t);
}

export function killEligibility(i: { idleMs: number; idleThresholdMs: number; force: boolean }): 'kill' | 'needs-force' {
  if (i.force) return 'kill';
  return i.idleMs >= i.idleThresholdMs ? 'kill' : 'needs-force';
}

export function decideLiveAction(i: {
  live: boolean;
  alreadyConnected: boolean;
  reachable: Reachability;
  idleMs: number;
  idleThresholdMs: number;
  force: boolean;
}): LiveAction {
  if (!i.live) return 'resume-dead';
  if (i.alreadyConnected) return 'already-connected';
  if (i.reachable === 'tmux') return 'inject-tmux';
  if (i.reachable === 'windows') return 'inject-windows';
  return killEligibility(i) === 'kill' ? 'kill' : 'needs-force';
}

// ── No-throw safety primitives (all I/O injected) ─────────────────────────────

export interface KillExec {
  isAlive: (pid: number) => boolean;
  signal: (pid: number, sig: 'SIGTERM' | 'SIGKILL') => void;
  taskkill: (pid: number) => void;
  sleep: (ms: number) => Promise<void>;
}

async function waitDead(pid: number, totalMs: number, pollMs: number, exec: KillExec): Promise<boolean> {
  let waited = 0;
  while (waited < totalMs) {
    let alive = true;
    try { alive = exec.isAlive(pid); } catch { return true; }
    if (!alive) return true;
    try { await exec.sleep(pollMs); } catch { /* ignore */ }
    waited += pollMs;
  }
  try { return !exec.isAlive(pid); } catch { return true; }
}

export async function killOwner(
  pid: number,
  opts: { isWindows: boolean; graceMs?: number; pollMs?: number },
  exec: KillExec,
): Promise<{ killed: boolean; wasAlive: boolean; method: 'sigterm' | 'sigkill' | 'taskkill' | 'none' }> {
  const graceMs = opts.graceMs ?? 5000;
  const pollMs = opts.pollMs ?? 250;
  let wasAlive = false;
  try { wasAlive = exec.isAlive(pid); } catch { wasAlive = false; }
  if (!wasAlive) return { killed: true, wasAlive: false, method: 'none' };

  if (opts.isWindows) {
    try { exec.taskkill(pid); } catch { /* ignore */ }
    return { killed: await waitDead(pid, graceMs, pollMs, exec), wasAlive: true, method: 'taskkill' };
  }

  try { exec.signal(pid, 'SIGTERM'); } catch { /* ignore */ }
  if (await waitDead(pid, graceMs, pollMs, exec)) return { killed: true, wasAlive: true, method: 'sigterm' };
  try { exec.signal(pid, 'SIGKILL'); } catch { /* ignore */ }
  return { killed: await waitDead(pid, graceMs, pollMs, exec), wasAlive: true, method: 'sigkill' };
}

export type InjectTarget = { via: 'tmux' | 'windows'; tmuxTarget?: string; pid?: number };

export interface InjectExec {
  tmuxSend: (target: string, keys: string, literal: boolean, enter: boolean) => void;
  windowsSend: (pid: number, opts: { text?: string; keys?: string; submit?: boolean }) => Promise<{ ok: boolean; error?: string }>;
}

export async function injectRemoteControl(
  target: InjectTarget,
  exec: InjectExec,
): Promise<{ ok: boolean; via: 'tmux' | 'windows'; error?: string }> {
  try {
    if (target.via === 'tmux') {
      if (!target.tmuxTarget) return { ok: false, via: 'tmux', error: 'no tmux target' };
      exec.tmuxSend(target.tmuxTarget, '/remote-control', true, true);
      return { ok: true, via: 'tmux' };
    }
    if (!target.pid) return { ok: false, via: 'windows', error: 'no pid' };
    const r = await exec.windowsSend(target.pid, { text: '/remote-control', submit: true });
    return { ok: !!r.ok, via: 'windows', ...(r.error !== undefined ? { error: r.error } : {}) };
  } catch (e) {
    return { ok: false, via: target.via, error: (e as Error).message };
  }
}

export async function clearInjectedInput(target: InjectTarget, exec: InjectExec): Promise<void> {
  try {
    if (target.via === 'tmux' && target.tmuxTarget) {
      exec.tmuxSend(target.tmuxTarget, 'Escape', false, false);
      exec.tmuxSend(target.tmuxTarget, 'C-u', false, false);
    } else if (target.via === 'windows' && target.pid) {
      await exec.windowsSend(target.pid, { keys: '{ESC}' });
    }
  } catch { /* best-effort cosmetic cleanup */ }
}

export interface CloudSession { sid: string; status: string; title?: string }

export async function pollForCloudConnection(
  match: { title?: string; excludeSids: Set<string> },
  list: () => Promise<CloudSession[]>,
  opts: { timeoutMs?: number; intervalMs?: number; sleep: (ms: number) => Promise<void> },
): Promise<{ connected: boolean; sid?: string }> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const intervalMs = opts.intervalMs ?? 1500;
  let waited = 0;
  for (;;) {
    let sessions: CloudSession[] = [];
    try { sessions = await list(); } catch { sessions = []; }
    const hit = sessions.find((s) =>
      !DEAD_CLOUD_STATUSES.includes((s.status || '').toLowerCase()) &&
      !match.excludeSids.has(s.sid) &&
      (match.title ? (s.title === match.title || (s.title || '').includes(match.title)) : true),
    );
    if (hit) return { connected: true, sid: hit.sid };
    if (waited >= timeoutMs) return { connected: false };
    try { await opts.sleep(intervalMs); } catch { /* ignore */ }
    waited += intervalMs;
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export interface EnsureResult {
  ok: boolean;
  state: 'connected' | 'already-connected' | 'needs-force' | 'gone' | 'kill-failed' | 'error';
  sid: string;
  via?: 'resume-dead' | 'inject' | 'kill-resume';
  cse?: string;
  attempts?: number;
  reason: string;
}

export interface EnsureDeps {
  now: () => number;
  verdict: (sid: string) => {
    live: boolean; inTmux: boolean; connectStrategy: string;
    tmuxTarget: string | null; pid: number | null; updatedAt: string | undefined;
  };
  isWindows: boolean;
  windowsDriveable: (pid: number) => Promise<boolean>;
  isConnected: (sid: string, title?: string) => Promise<boolean>;
  listCloud: () => Promise<CloudSession[]>;
  inject: (target: InjectTarget) => Promise<{ ok: boolean; error?: string }>;
  clearInput: (target: InjectTarget) => Promise<void>;
  pollConnection: (excludeSids: Set<string>, title?: string) => Promise<{ connected: boolean; sid?: string }>;
  killOwner: (pid: number) => Promise<{ killed: boolean }>;
  resumeDead: (sid: string) => Promise<{ ok: boolean; cse?: string; error?: string }>;
  verifyDriveable: (sid: string) => Promise<boolean>;
  bindCse: (sid: string, cse: string) => Promise<void>;
}

const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

export async function ensureRemoteControlled(
  sid: string,
  opts: { force?: boolean; idleThresholdMs?: number; title?: string },
  deps: EnsureDeps,
): Promise<EnsureResult> {
  const force = !!opts.force;
  const idleThresholdMs = opts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;

  let v: ReturnType<EnsureDeps['verdict']>;
  try { v = deps.verdict(sid); }
  catch (e) { return { ok: false, state: 'error', sid, reason: `verdict failed: ${(e as Error).message}` }; }

  if (v.connectStrategy === 'none') {
    return { ok: false, state: 'gone', sid, reason: 'no transcript and no live process on this host' };
  }

  // DEAD → resume-dead (existing safe path)
  if (!v.live) return finishResume(sid, deps, 'resume-dead', 0);

  // ALREADY CONNECTED? (best-effort; toggle safety)
  const alreadyConnected = await deps.isConnected(sid, opts.title).catch(() => false);

  let windowsDriveable = false;
  if (deps.isWindows && v.pid) windowsDriveable = await deps.windowsDriveable(v.pid).catch(() => false);
  const reachable = classifyReachability(v, { isWindows: deps.isWindows, windowsDriveable });
  const idle = idleMs(v.updatedAt, deps.now());
  const action = decideLiveAction({ live: v.live, alreadyConnected, reachable, idleMs: idle, idleThresholdMs, force });

  if (action === 'already-connected') {
    const ok = await deps.verifyDriveable(sid).catch(() => false);
    return ok
      ? { ok: true, state: 'already-connected', sid, reason: 'session already remote-controlled and driveable' }
      : { ok: false, state: 'error', sid, reason: 'reported connected but not driveable' };
  }

  const target: InjectTarget = reachable === 'windows'
    ? { via: 'windows', pid: v.pid ?? undefined }
    : { via: 'tmux', tmuxTarget: v.tmuxTarget ?? undefined };

  if (action === 'inject-tmux' || action === 'inject-windows') {
    let attempts = 0;
    for (let i = 0; i < 2; i++) {
      attempts++;
      const baseline = new Set((await deps.listCloud().catch(() => [] as CloudSession[])).map((s) => s.sid));
      const inj = await deps.inject(target).catch((e) => ({ ok: false, error: (e as Error).message }));
      if (!inj.ok) continue;
      const r = await deps.pollConnection(baseline, opts.title).catch(() => ({ connected: false as const }));
      if (r.connected) {
        if (r.sid) await deps.bindCse(sid, r.sid).catch(() => {});
        return { ok: true, state: 'connected', sid, via: 'inject', cse: r.sid, attempts, reason: `connected via /remote-control inject (attempt ${attempts})` };
      }
    }
    // inject exhausted → kill policy
    if (killEligibility({ idleMs: idle, idleThresholdMs, force }) === 'needs-force') {
      await deps.clearInput(target).catch(() => {});
      return { ok: false, state: 'needs-force', sid, attempts, reason: 'inject failed and session is actively busy; pass force:true to kill-and-resume' };
    }
    return killThenResume(sid, v.pid, deps, attempts);
  }

  if (action === 'needs-force') {
    return { ok: false, state: 'needs-force', sid, reason: 'live session is unreachable (headless) and actively busy; pass force:true to kill-and-resume' };
  }

  // action === 'kill'
  return killThenResume(sid, v.pid, deps, 0);
}

async function killThenResume(sid: string, pid: number | null, deps: EnsureDeps, attempts: number): Promise<EnsureResult> {
  if (!pid) return { ok: false, state: 'error', sid, attempts, reason: 'no owner pid to kill' };
  const k = await deps.killOwner(pid).catch(() => ({ killed: false }));
  // INVARIANT: never resume over a live process — if killOwner reports killed:false, stop here
  if (!k.killed) return { ok: false, state: 'kill-failed', sid, attempts, reason: 'owner process did not terminate; NOT resuming over a live process' };
  // re-verify the process is actually gone before resuming (invariant: catches the case where the
  // target pid died but another process still owns the transcript / verdict still reports live)
  let stillLive = false;
  try { stillLive = deps.verdict(sid).live; } catch { stillLive = false; }
  if (stillLive) return { ok: false, state: 'kill-failed', sid, attempts, reason: 'process still live after kill; aborting resume' };
  return finishResume(sid, deps, 'kill-resume', attempts);
}

async function finishResume(sid: string, deps: EnsureDeps, via: 'resume-dead' | 'kill-resume', attempts: number): Promise<EnsureResult> {
  const r = await deps.resumeDead(sid).catch((e) => ({ ok: false, error: (e as Error).message } as { ok: boolean; cse?: string; error?: string }));
  if (r.ok && await deps.verifyDriveable(sid).catch(() => false)) {
    if (r.cse) await deps.bindCse(sid, r.cse).catch(() => {});
    return { ok: true, state: 'connected', sid, via, cse: r.cse, attempts, reason: via === 'resume-dead' ? 'resumed dead session and connected' : 'killed idle/forced session and resumed' };
  }
  return { ok: false, state: 'error', sid, attempts, reason: `${via} failed: ${r.error || 'not driveable after resume'}` };
}
