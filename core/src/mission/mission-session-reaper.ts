/**
 * Mission session reaper: tracks resumed native sessions and auto-closes them after idle timeout.
 *
 * Pure-testable (inject `close`); the leader supervisor calls sweepIdle on each tick.
 * In-memory only — only the leader runs the sweep, so cross-node persistence is not needed.
 */

interface TrackedSession {
  missionId: string | undefined;
  lastActivityAt: number;
}

/** Factory to create an isolated reaper instance (used by tests). */
export function createReaper() {
  const tracked = new Map<string, TrackedSession>();

  /**
   * Start tracking a newly-resumed native session.
   * Re-calling for an existing sid overwrites the lastActivityAt (idempotent re-track).
   */
  function trackResumedNative(sid: string, missionId: string | undefined, now: number): void {
    tracked.set(sid, { missionId, lastActivityAt: now });
  }

  /**
   * Refresh the lastActivityAt for a tracked native session.
   * Called by handleSessionRead + handleSessionDrive for native sids (best-effort).
   * No-op if the sid is not tracked.
   */
  function touchActivity(sid: string, now: number): void {
    const entry = tracked.get(sid);
    if (entry) {
      tracked.set(sid, { ...entry, lastActivityAt: now });
    }
  }

  /**
   * Sweep: close and untrack all sids that have been idle for > idleMin minutes.
   * `close(sid)` errors are caught per-sid (best-effort) so one failure never blocks others.
   */
  async function sweepIdle(opts: {
    now: number;
    idleMin: number;
    close: (sid: string) => Promise<void>;
    /** Veto: return true to spare a sid this sweep WITHOUT untracking it. Used to
     *  protect manually-operated sessions — the reaper's idle timer is refreshed by
     *  lm-assist's own reads/drives, and a standby session gets none of those, so
     *  without this it would kill the terminal of the person we are protecting. */
    skip?: (sid: string) => boolean;
  }): Promise<void> {
    const { now, idleMin, close, skip } = opts;
    const idleMs = idleMin * 60_000;
    const expired: string[] = [];
    for (const [sid, entry] of tracked.entries()) {
      if ((now - entry.lastActivityAt) > idleMs && !skip?.(sid)) {
        expired.push(sid);
      }
    }
    for (const sid of expired) {
      // Untrack first so a close error doesn't keep the sid tracked indefinitely.
      tracked.delete(sid);
      try {
        await close(sid);
      } catch (e) {
        // Best-effort: log but don't re-throw so other sids are still swept.
        console.debug(`[mission-session-reaper] close(${sid}) failed: ${(e as Error).message}`);
      }
    }
  }

  return { trackResumedNative, touchActivity, sweepIdle };
}

// ── Module-level singleton (used by the supervisor tick and the route handlers) ──

const _singleton = createReaper();

/**
 * Track a newly-resumed native session in the module-level reaper.
 * Called by handleSessionResume (native path).
 */
export function trackResumedNative(sid: string, missionId: string | undefined, now: number): void {
  _singleton.trackResumedNative(sid, missionId, now);
}

/**
 * Refresh the idle timer for a native session.
 * Called by handleSessionRead + handleSessionDrive for native sids (best-effort).
 */
export function touchActivity(sid: string, now: number): void {
  _singleton.touchActivity(sid, now);
}

/**
 * Sweep idle sessions. Called by the supervisor tick (leader only).
 * `close(sid)` should kill the tmux session for the given native sid.
 */
export async function sweepIdle(opts: {
  now: number;
  idleMin: number;
  close: (sid: string) => Promise<void>;
  skip?: (sid: string) => boolean;
}): Promise<void> {
  return _singleton.sweepIdle(opts);
}
