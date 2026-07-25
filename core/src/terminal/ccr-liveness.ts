/**
 * CCR liveness — decide whether a registry entry refers to something ACTUALLY
 * alive, which entries may be reaped, and how to report the answer honestly.
 *
 * WHY THIS EXISTS: the registry records the pid of the detached `ccr-bridge.js`
 * helper, NOT of `claude`. `connectDeadCreateTmux` creates the tmux session that
 * runs `claude --resume` and then spawns the bridge as a SEPARATE detached child
 * (ccr-manager.ts), so the recorded pid belongs to the relay, not the session.
 * Reporting it as `alive` answers "is the bridge up?" under a name every caller
 * reads as "is the session alive?".
 *
 * Measured on node 117, 2026-07-25: three entries reported `alive:false` while
 * all three referred to LIVE sessions (bridge pids 1319611/1339045 dead; the real
 * claude pids 1319220/1338505 alive in tmux ccr-32c5294c / ccr-9b43fd03). An agent
 * asked what was running, believed the registry, and told the user nothing was.
 *
 * Everything here is pure + dependency-injected: the ladder is testable without
 * processes, tmux, or a filesystem.
 */

/** How `alive` was established. */
export type LivenessSource = 'session-registry' | 'tmux' | 'bridge-pid' | 'none';

/** The subset of a CcrRecord this module needs (structural — no import cycle). */
export interface CcrLivenessInput {
  sessionId?: string | null;
  tmuxSession?: string | null;
  pid?: number | null;
  startedAt?: string;
}

export interface CcrLiveness {
  /** Is the SESSION behind this entry live? This is what callers mean by "alive". */
  alive: boolean;
  verifiedBy: LivenessSource;
  /**
   * True when the session could NOT be checked. An unverified entry is reported as
   * unknown — never as a confident death. This is the flag that stops a registry row
   * from being read as "that session is gone".
   */
  unverified: boolean;
  /** The ccr-bridge.js relay process — what `alive` used to (mis)report. */
  bridgeAlive: boolean;
  /** null = not determined. */
  sessionAlive: boolean | null;
  tmuxAlive: boolean | null;
  /** The REAL owner pid of the live session. Not the same as the record's `pid`. */
  sessionPid: number | null;
  reason: string;
}

export interface SessionLiveness {
  live: boolean;
  pid: number | null;
  tmuxSession: string | null;
}

export interface LivenessDeps {
  /** POSIX signal-0 probe for the bridge helper pid. */
  pidAlive(pid: number): boolean;
  /**
   * Authoritative session liveness — cc-sessions' `sessionVerdict`, which carries the
   * pid-alive check, the /proc starttime pid-reuse guard, and the tmux pane mapping.
   * Return null when it could not be determined at all (then we degrade, not guess).
   */
  sessionLive(sessionId: string): SessionLiveness | null;
  /** Does this tmux session still exist? */
  tmuxExists(name: string): boolean;
}

/** Never let a probe throw out of the ladder — a failed check degrades, it does not error. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function hasPid(rec: CcrLivenessInput): rec is CcrLivenessInput & { pid: number } {
  return typeof rec.pid === 'number' && rec.pid > 0;
}

/**
 * Resolve liveness by the first CHECKABLE source, most authoritative first:
 *   sessionId → the session registry   (the real answer)
 *   tmuxSession → tmux has-session     (real process state, no sessionId on the record)
 *   pid → signal-0 on the bridge       (all that exists for load/mirror records)
 *   nothing → unverified               (reported as unknown, never as dead)
 */
export function computeLiveness(rec: CcrLivenessInput, deps: LivenessDeps): CcrLiveness {
  const bridgeAlive = hasPid(rec) ? safe(() => deps.pidAlive(rec.pid), false) : false;
  const bridgeNote = hasPid(rec)
    ? ` — the ccr bridge (pid ${rec.pid}) is ${bridgeAlive ? 'up' : 'DOWN: the two-way relay is broken, reconnect with ccr_connect'}`
    : '';

  // 1. The session registry — authoritative.
  if (rec.sessionId) {
    const v = safe(() => deps.sessionLive(rec.sessionId as string), null);
    if (v) {
      const tmuxAlive = rec.tmuxSession
        ? v.tmuxSession === rec.tmuxSession || safe(() => deps.tmuxExists(rec.tmuxSession as string), false)
        : null;
      const where = v.tmuxSession ? ` in tmux '${v.tmuxSession}'` : '';
      return {
        alive: v.live,
        verifiedBy: 'session-registry',
        unverified: false,
        bridgeAlive,
        sessionAlive: v.live,
        tmuxAlive,
        sessionPid: v.pid,
        reason: v.live
          ? `session ${rec.sessionId} is LIVE (pid ${v.pid ?? '?'})${where}${bridgeNote}`
          : `session ${rec.sessionId} has no live owner process${bridgeNote}`,
      };
    }
  }

  // 2. tmux — real process state when the record carries no resolvable session.
  if (rec.tmuxSession) {
    const exists = safe(() => deps.tmuxExists(rec.tmuxSession as string), false);
    return {
      alive: exists,
      verifiedBy: 'tmux',
      unverified: false,
      bridgeAlive,
      sessionAlive: null,
      tmuxAlive: exists,
      sessionPid: null,
      reason: exists
        ? `tmux '${rec.tmuxSession}' exists${bridgeNote}`
        : `tmux '${rec.tmuxSession}' is gone${bridgeNote}`,
    };
  }

  // 3. The bridge pid alone. For load/mirror records the bridge IS the unit of work,
  //    but it says nothing about any session — hence unverified.
  if (hasPid(rec)) {
    return {
      alive: bridgeAlive,
      verifiedBy: 'bridge-pid',
      unverified: true,
      bridgeAlive,
      sessionAlive: null,
      tmuxAlive: null,
      sessionPid: null,
      reason: `only the bridge pid ${rec.pid} could be checked (${bridgeAlive ? 'up' : 'down'}) — this record names no session or tmux, so session liveness is NOT verified`,
    };
  }

  // 4. Nothing checkable.
  return {
    alive: false,
    verifiedBy: 'none',
    unverified: true,
    bridgeAlive: false,
    sessionAlive: null,
    tmuxAlive: null,
    sessionPid: null,
    reason: 'registry-only entry: no session, tmux, or pid to check — liveness UNKNOWN, not asserted dead',
  };
}

/** Default age after which a not-alive entry is dropped from the registry. */
export const DEFAULT_REAP_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Reaping is BOOKKEEPING ONLY — it drops a registry row and never signals a process
 * or kills a tmux. That is what makes it safe to run on read.
 *
 * An `unverified` row is reapable on the same clock: it has no pid, no tmux and no
 * resolvable session, so `stop()` on it is already a no-op — it can hold nothing.
 */
export function isReapable(
  rec: CcrLivenessInput,
  liveness: CcrLiveness,
  opts: { now: number; ttlMs: number },
): boolean {
  if (liveness.alive) return false; // never reap something alive, at any age
  const started = Date.parse(rec.startedAt ?? '');
  if (!Number.isFinite(started)) return false; // unparseable — keep it rather than guess
  return opts.now - started > opts.ttlMs;
}

/**
 * Compute liveness for every record and drop the reapable ones, in one pass.
 * `changed` tells the caller whether a persist is warranted at all.
 */
export function reapRecords<T extends CcrLivenessInput>(
  records: Record<string, T>,
  deps: LivenessDeps,
  opts: { now: number; ttlMs: number },
): { kept: Record<string, T>; rows: Array<T & CcrLiveness>; reaped: string[]; changed: boolean } {
  const kept: Record<string, T> = {};
  const rows: Array<T & CcrLiveness> = [];
  const reaped: string[] = [];

  for (const [id, rec] of Object.entries(records)) {
    const liveness = computeLiveness(rec, deps);
    if (isReapable(rec, liveness, opts)) {
      reaped.push(id);
      continue;
    }
    kept[id] = rec;
    rows.push({ ...rec, ...liveness });
  }

  return { kept, rows, reaped, changed: reaped.length > 0 };
}

// ---------------------------------------------------------------------------
// Reporting — say WHAT was found and WHERE it was looked for
// ---------------------------------------------------------------------------

export interface RemoteListReport {
  searched: { node: string; cluster: string; scope: string };
  summary: { total: number; alive: number; bridgeDown: number; unverified: number; reaped: number };
  note: string;
  /** Present only when nothing is alive — an empty answer must not read as "nothing exists". */
  hint?: string;
}

const NOTE =
  'These are CCR bridge REGISTRATIONS, not the list of running Claude Code sessions. ' +
  'For what is actually running use cc_sessions (this host) or session_footprints (cross-fleet).';

/**
 * Build the scope-aware envelope. Callers routinely mistake an empty or all-dead list
 * for "nothing is running anywhere" — in the incident the first query landed on the
 * hub's default node, which is on a DIFFERENT cluster than the user's sessions. The
 * node that served the request names itself here so that cannot happen silently.
 */
export function buildRemoteListReport(
  rows: Array<CcrLiveness>,
  where: { node: string; cluster: string },
  reaped: number,
): RemoteListReport {
  const alive = rows.filter((r) => r.alive).length;
  const report: RemoteListReport = {
    searched: { node: where.node, cluster: where.cluster, scope: 'this node only' },
    summary: {
      total: rows.length,
      alive,
      bridgeDown: rows.filter((r) => r.alive && !r.bridgeAlive).length,
      unverified: rows.filter((r) => r.unverified).length,
      reaped,
    },
    note: NOTE,
  };

  if (alive === 0) {
    report.hint =
      `No live CCR bridges on node ${where.node} (cluster ${where.cluster}). ` +
      'This tool covers ONE node — other nodes and clusters are NOT included, so this is ' +
      'not evidence that nothing is running. For sessions running on this host use ' +
      "cc_sessions; across the fleet use session_footprints(scope:'fleet'); to target " +
      'another node pass node=<hostname> (see list_nodes / cluster_list).';
  }

  return report;
}
