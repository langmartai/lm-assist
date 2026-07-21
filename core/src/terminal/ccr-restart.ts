/**
 * CCR restart — recycle a LOCAL Claude Code session's process so it re-fetches
 * its MCP tool list (Claude Code loads MCP tools at process START only; there is
 * no in-place reload for a running session).
 *
 * SAFETY CONTRACT (the whole point of this module — two processes resuming the
 * same session storage corrupt it):
 *   1. STOP any existing CCR bridge remotes for the session first.
 *   2. KILL the live owner process (SIGTERM → poll-verify → SIGKILL → poll-verify).
 *   3. VERIFY DEAD twice: killOwner's own waitDead AND a fresh sessionVerdict —
 *      if ANYTHING still owns the session, ABORT (state 'kill-failed'). We never
 *      resume over a live process.
 *   4. Only then spawn the fresh `claude --resume` (which re-fetches MCP tools).
 *
 * A BUSY session (mid-turn) is refused without force:true — killing a session
 * mid-write is the other corruption vector. Idle sessions restart without force.
 *
 * Deps-injected (mirrors live-rc-connect's EnsureDeps style) so the orchestration
 * is unit-testable without tmux/processes.
 */

import { killEligibility, idleMs } from './live-rc-connect';

export type RestartState =
  | 'restarted'        // old process gone (or was already dead), fresh resume live
  | 'needs-force'      // live and actively busy — refuse without force:true
  | 'kill-failed'      // owner did not terminate / something still owns the session — ABORTED
  | 'gone'             // no transcript and no live process on this host
  | 'error';

export interface RestartResult {
  ok: boolean;
  state: RestartState;
  sid: string;
  /** what the old owner was, when there was one */
  oldPid?: number | null;
  wasLive?: boolean;
  killMethod?: string;
  /** the fresh resume's record (webUrl/tmux), present on ok */
  record?: unknown;
  reason: string;
}

export interface RestartDeps {
  now: () => number;
  verdict: (sid: string) => {
    live: boolean; connectStrategy: string; pid: number | null;
    tmuxSession: string | null; updatedAt: string | undefined;
  };
  /** Stop existing CCR bridge remotes registered for this session (best-effort). */
  stopExistingRemotes: (sid: string) => Promise<number>;
  /** Kill + VERIFY-DEAD the owner pid. Must not resolve killed:true unless the process is gone. */
  killOwner: (pid: number) => Promise<{ killed: boolean; wasAlive: boolean; method: string }>;
  /** Kill a stale ccr-<sid8> tmux left from a previous connect (best-effort). */
  killStaleCcrTmux: (sid: string) => Promise<void>;
  /** Spawn the fresh `claude --resume` bridge — ONLY called after verified-dead. */
  resume: (sid: string) => Promise<unknown>;
}

const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

export async function restartLocal(
  sid: string,
  opts: { force?: boolean; idleThresholdMs?: number },
  deps: RestartDeps,
): Promise<RestartResult> {
  const force = !!opts.force;
  const idleThresholdMs = opts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;

  let v: ReturnType<RestartDeps['verdict']>;
  try { v = deps.verdict(sid); }
  catch (e) { return { ok: false, state: 'error', sid, reason: `verdict failed: ${(e as Error).message}` }; }

  if (v.connectStrategy === 'none') {
    return { ok: false, state: 'gone', sid, reason: 'no transcript and no live process on this host' };
  }

  const wasLive = v.live;
  const oldPid = v.pid;

  // BUSY gate BEFORE any destructive step: a mid-turn session is only killed with force.
  if (wasLive) {
    const idle = idleMs(v.updatedAt, deps.now());
    if (killEligibility({ idleMs: idle, idleThresholdMs, force }) === 'needs-force') {
      return {
        ok: false, state: 'needs-force', sid, oldPid, wasLive,
        reason: 'session is actively busy (mid-turn); killing it now risks corrupting the turn — pass force:true to restart anyway',
      };
    }
  }

  // 1. Stop existing bridge remotes (their bridge process + owned tmux) — before the
  //    owner kill so nothing races a half-dead session.
  try { await deps.stopExistingRemotes(sid); } catch { /* best-effort */ }

  let killMethod = 'none';
  if (wasLive) {
    // 2. Kill the owner and VERIFY it died.
    if (!oldPid) return { ok: false, state: 'error', sid, wasLive, reason: 'live session but no owner pid to kill' };
    const k = await deps.killOwner(oldPid).catch(() => ({ killed: false, wasAlive: true, method: 'error' }));
    killMethod = k.method;
    // INVARIANT: never resume over a live process.
    if (!k.killed) {
      return { ok: false, state: 'kill-failed', sid, oldPid, wasLive, killMethod, reason: 'owner process did not terminate; NOT resuming over a live process' };
    }
    // 3. Independent re-verify: a fresh verdict must agree nothing owns the session
    //    (catches a second process owning the transcript beyond the killed pid).
    let stillLive = false;
    try { stillLive = deps.verdict(sid).live; } catch { stillLive = false; }
    if (stillLive) {
      return { ok: false, state: 'kill-failed', sid, oldPid, wasLive, killMethod, reason: 'session still reports a live owner after kill; ABORTING resume (no corruption)' };
    }
  }

  // 4. Clear a stale ccr-<sid8> tmux (ours by naming convention) so the fresh
  //    resume's create-tmux cannot collide on the name.
  try { await deps.killStaleCcrTmux(sid); } catch { /* best-effort */ }

  // 5. Fresh resume — new process ⇒ MCP tools re-fetched at startup.
  try {
    const record = await deps.resume(sid);
    return {
      ok: true, state: 'restarted', sid, oldPid, wasLive, killMethod, record,
      reason: wasLive
        ? 'killed the old owner (verified dead) and resumed fresh — MCP tools re-fetched at startup'
        : 'session was not running; resumed fresh — MCP tools re-fetched at startup',
    };
  } catch (e) {
    return { ok: false, state: 'error', sid, oldPid, wasLive, killMethod, reason: `resume failed: ${(e as Error).message}` };
  }
}
