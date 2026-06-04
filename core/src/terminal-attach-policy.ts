/**
 * Terminal attach policy — the single safety rule that decides whether a Claude
 * session may receive a writable console / tmux attach.
 *
 * THE RULE: a writable console (tmux send-keys, ttyd, or a fresh `claude --resume`)
 * may only target a Claude session that is hosted INSIDE tmux. A Claude process
 * running outside tmux (a plain terminal, or a `--chrome` full window) has no tmux
 * pane to share, so the only way to "connect" to it is to launch a SECOND
 * `claude --resume <sessionId>` — two live processes writing the same session
 * JSONL, which corrupts it. So: never attach to, or duplicate, a LIVE non-tmux
 * session. A DEAD one is harmless and must never block a fresh start.
 *
 * Pure functions over a process list — no ps/tmux/proc calls — so the rule is
 * deterministically unit-testable. Liveness is injected (defaults to the real
 * /proc check) so tests can simulate dead PIDs.
 */

import { isProcessAlive } from './utils/process-utils';

/** Minimal shape needed to apply the policy (satisfied by ClaudeProcessInfo). */
export interface AttachCandidate {
  pid: number;
  sessionId?: string;
  tmuxSessionName?: string;
  source?: string;
}

/**
 * True when the process is NOT hosted inside a tmux pane. The live-PID detector
 * (ancestor-walk against `#{pane_pid}`) sets `tmuxSessionName` only for processes
 * whose ancestor chain hits a tmux pane, so its absence means "outside tmux".
 */
export function isNonTmuxProcess(p: AttachCandidate): boolean {
  return !p.tmuxSessionName;
}

/**
 * Find a LIVE Claude process for `sessionId` that is running OUTSIDE tmux.
 * Returns the offending process (so callers can name its PID in the refusal),
 * or null when none exists (no conflict — a writable start is safe).
 *
 * @param processes the current live Claude process list
 * @param sessionId the session a caller wants to attach/resume
 * @param aliveCheck injected liveness predicate (defaults to real isProcessAlive)
 */
export function findLiveNonTmuxSession(
  processes: AttachCandidate[],
  sessionId: string,
  aliveCheck: (pid: number) => boolean = isProcessAlive,
): AttachCandidate | null {
  if (!sessionId) return null;
  return processes.find(
    (p) => p.sessionId === sessionId && isNonTmuxProcess(p) && aliveCheck(p.pid),
  ) ?? null;
}
