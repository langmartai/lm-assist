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
