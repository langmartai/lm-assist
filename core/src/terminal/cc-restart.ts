/**
 * Restart a live Claude Code session in place: kill it, PROVE it is dead, then
 * relaunch with `--resume <sessionId>` so the transcript continues.
 *
 * Why this needs to exist: a live session is deliberately `connectStrategy:
 * "refuse"` — a second `claude --resume` against a transcript that a live process
 * still owns double-writes the JSONL and corrupts it. That policy is right, and
 * it leaves no supported way to recycle a session (pick up new MCP tools, clear a
 * wedged context, recover a stuck turn) short of doing it by hand.
 *
 * A restart is exactly the operation that makes resuming safe, because it removes
 * the other writer FIRST. The whole design rests on one gate:
 *
 *   🔴 NEVER launch the resume until the old pid is OBSERVED gone.
 *
 * Not "we sent a kill", not "close() returned ok" — observed. `close()` reporting
 * success is not proof the process died (this repo has shipped four bugs of
 * exactly that shape). If liveness cannot be confirmed, we refuse rather than
 * risk two writers on one transcript.
 *
 * Backend-neutral: composed from CcController primitives, so it works on tmux and
 * Windows Terminal alike.
 */

export type RestartAction = 'restart' | 'refuse';

export interface RestartFacts {
  /** Is a process currently running this session? */
  live: boolean;
  /** Is it mid-turn? Killing here loses in-flight work. */
  busy: boolean;
  /** Caller asked to restart a busy session anyway. */
  force: boolean;
  /** A transcript exists, so `--resume` has something to continue. */
  hasTranscript: boolean;
  /** Where to relaunch. */
  cwd: string | null;
}

export interface RestartDecision {
  action: RestartAction;
  reason: string;
}

/**
 * Should we restart? Pure, so every refusal is testable without processes.
 */
export function planCcRestart(f: RestartFacts): RestartDecision {
  if (!f.hasTranscript) {
    // Killing here would destroy the session with nothing to resume into.
    return { action: 'refuse', reason: 'no transcript for this session — a restart would end it, not resume it' };
  }
  if (!f.cwd) {
    return { action: 'refuse', reason: 'session has no recorded cwd — cannot relaunch it in the right directory' };
  }
  if (!f.live) {
    // Nothing to kill; this is a plain resume, which is already safe.
    return { action: 'restart', reason: 'session is not live — resuming its transcript directly' };
  }
  if (f.busy && !f.force) {
    return { action: 'refuse', reason: 'session is mid-turn — killing it now loses the in-flight turn. Pass force to override' };
  }
  return {
    action: 'restart',
    reason: f.busy ? 'live and busy, force requested — killing and resuming' : 'live and idle — killing and resuming',
  };
}

/**
 * Is it safe to launch the resume yet?
 *
 * The ONLY acceptable answer is a confirmed-dead old process. `unknown` liveness
 * is treated as still-alive: a transcript is worth more than a fast restart.
 */
export function safeToResume(oldPidAlive: boolean | null): { ok: boolean; reason: string } {
  if (oldPidAlive === false) return { ok: true, reason: 'old process confirmed gone' };
  if (oldPidAlive === null) {
    return { ok: false, reason: 'could not determine whether the old process died — refusing to risk two writers on one transcript' };
  }
  return { ok: false, reason: 'old process is still alive — resuming now would double-write the transcript' };
}
