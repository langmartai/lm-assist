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
  /** how long we waited for the in-flight turn to finish (wait-for-idle path) */
  waitedMs?: number;
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
  /** Real TUI activity: 'idle' = at the prompt (safe to recycle NOW, whatever the
   *  transcript age); 'busy' = actively mid-turn; 'unknown' = can't tell (headless /
   *  non-tmux) → the conservative transcript-age gate applies instead. */
  phase?: (sid: string) => 'idle' | 'busy' | 'unknown';
  sleep?: (ms: number) => Promise<void>;
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
const DEFAULT_WAIT_MS = 120_000;   // how long to wait for an in-flight turn to finish
const WAIT_POLL_MS = 2_000;

/** Is the session ACTUALLY working right now? Prefer the real TUI phase; fall back
 *  to the transcript-age gate when the phase is unknowable. */
function isActivelyBusy(
  v: { updatedAt: string | undefined },
  phase: 'idle' | 'busy' | 'unknown',
  now: number,
  idleThresholdMs: number,
): boolean {
  if (phase === 'idle') return false;   // at the prompt — safe now, whatever updatedAt says
  if (phase === 'busy') return true;    // genuinely mid-turn
  return killEligibility({ idleMs: idleMs(v.updatedAt, now), idleThresholdMs, force: false }) === 'needs-force';
}

export async function restartLocal(
  sid: string,
  opts: { force?: boolean; idleThresholdMs?: number; waitMs?: number },
  deps: RestartDeps,
): Promise<RestartResult> {
  const force = !!opts.force;
  const idleThresholdMs = opts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  // How long to WAIT for an in-flight turn to finish before giving up (0 = don't
  // wait — refuse a busy session immediately, the pre-wait behavior).
  const waitMs = opts.waitMs === undefined ? DEFAULT_WAIT_MS : Math.max(0, Math.min(opts.waitMs, 600_000));
  const phaseOf = deps.phase ?? (() => 'unknown' as const);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let v: ReturnType<RestartDeps['verdict']>;
  try { v = deps.verdict(sid); }
  catch (e) { return { ok: false, state: 'error', sid, reason: `verdict failed: ${(e as Error).message}` }; }

  if (v.connectStrategy === 'none') {
    return { ok: false, state: 'gone', sid, reason: 'no transcript and no live process on this host' };
  }

  let wasLive = v.live;
  let oldPid = v.pid;
  let waitedMs = 0;

  // BUSY gate BEFORE any destructive step: a session ACTUALLY mid-turn is not
  // killed silently. force:true kills immediately; otherwise WAIT (bounded) for
  // the current work to finish, then proceed. A session idle at its prompt
  // restarts right away — whatever the transcript age.
  if (wasLive && !force) {
    let busy = isActivelyBusy(v, phaseOf(sid), deps.now(), idleThresholdMs);
    if (busy && waitMs === 0) {
      return {
        ok: false, state: 'needs-force', sid, oldPid, wasLive,
        reason: 'session is actively busy (mid-turn) and waiting is disabled (waitMs:0) — pass force:true to kill immediately, or allow waitMs',
      };
    }
    const waitStart = deps.now();
    while (busy) {
      if (deps.now() - waitStart >= waitMs) {
        return {
          ok: false, state: 'needs-force', sid, oldPid, wasLive, waitedMs: deps.now() - waitStart,
          reason: `session stayed busy for the full wait window (${Math.round(waitMs / 1000)}s) — its current work has not finished; retry with a longer waitMs or pass force:true to kill it mid-turn`,
        };
      }
      await sleep(Math.min(WAIT_POLL_MS, waitMs));
      busy = isActivelyBusy(v, phaseOf(sid), deps.now(), idleThresholdMs);
    }
    waitedMs = deps.now() - waitStart;
    // The wait may have outlived the process (turn ended = session exited, or a
    // user closed it) — refresh the verdict so the kill targets the CURRENT owner.
    if (waitedMs > 0) {
      try { v = deps.verdict(sid); wasLive = v.live; oldPid = v.pid; } catch { /* keep the entry verdict */ }
    }
  }

  // 1. Stop existing bridge remotes (their bridge process + owned tmux) — before the
  //    owner kill so nothing races a half-dead session.
  try { await deps.stopExistingRemotes(sid); } catch { /* best-effort */ }

  let killMethod = 'none';
  if (wasLive) {
    // 2. Kill the owner and VERIFY it died.
    if (!oldPid) return { ok: false, state: 'error', sid, wasLive, waitedMs, reason: 'live session but no owner pid to kill' };
    const k = await deps.killOwner(oldPid).catch(() => ({ killed: false, wasAlive: true, method: 'error' }));
    killMethod = k.method;
    // INVARIANT: never resume over a live process.
    if (!k.killed) {
      return { ok: false, state: 'kill-failed', sid, oldPid, wasLive, killMethod, waitedMs, reason: 'owner process did not terminate; NOT resuming over a live process' };
    }
    // 3. Independent re-verify: a fresh verdict must agree nothing owns the session
    //    (catches a second process owning the transcript beyond the killed pid).
    let stillLive = false;
    try { stillLive = deps.verdict(sid).live; } catch { stillLive = false; }
    if (stillLive) {
      return { ok: false, state: 'kill-failed', sid, oldPid, wasLive, killMethod, waitedMs, reason: 'session still reports a live owner after kill; ABORTING resume (no corruption)' };
    }
  }

  // 4. Clear a stale ccr-<sid8> tmux (ours by naming convention) so the fresh
  //    resume's create-tmux cannot collide on the name.
  try { await deps.killStaleCcrTmux(sid); } catch { /* best-effort */ }

  // 5. Fresh resume — new process ⇒ MCP tools re-fetched at startup.
  try {
    const record = await deps.resume(sid);
    const waited = waitedMs > 0 ? ` (waited ${Math.round(waitedMs / 1000)}s for its in-flight work to finish)` : '';
    return {
      ok: true, state: 'restarted', sid, oldPid, wasLive, killMethod, waitedMs, record,
      reason: wasLive
        ? `killed the old owner (verified dead) and resumed fresh — MCP tools re-fetched at startup${waited}`
        : `session was not running; resumed fresh — MCP tools re-fetched at startup${waited}`,
    };
  } catch (e) {
    return { ok: false, state: 'error', sid, oldPid, wasLive, killMethod, waitedMs, reason: `resume failed: ${(e as Error).message}` };
  }
}
