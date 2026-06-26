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
