/**
 * Regression guard: did a restart reap the tmux server?
 *
 * The 2026-07-28 prod incident reported a CLEAN restart. Services came back
 * healthy, the CLI printed success and exited 0 — while the tmux server and every
 * Claude Code pane on the node had been killed, and the mission controller had to
 * rebuild the world from scratch. Nothing in the restart path was measuring the
 * one thing that had been destroyed.
 *
 * So: sample the tmux server pid before and after, and refuse to call a restart
 * clean when that pid did not survive it.
 */

import { execFileSync } from '../utils/exec';
import { IS_POSIX } from '../utils/process-utils';

export interface TmuxServerChange {
  /** False when the restart reaped the server. */
  ok: boolean;
  reaped: boolean;
  before: number | null;
  after: number | null;
  message: string;
}

/**
 * The tmux SERVER pid, or null when no server is running.
 *
 * `#{pid}` is the server's own pid — not the client's, and not a pane's.
 */
export function readTmuxServerPid(): number | null {
  if (!IS_POSIX) return null;
  try {
    const out = execFileSync('tmux', ['display-message', '-p', '#{pid}'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const pid = parseInt(String(out).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    // "no server running on /tmp/tmux-1000/default", tmux absent, or a
    // non-POSIX host — all mean "no server to protect".
    return null;
  }
}

export function describeTmuxServerChange(before: number | null, after: number | null): TmuxServerChange {
  if (before === null) {
    // Nothing was running beforehand, so nothing could be lost. A server
    // appearing during the restart is normal (Core starts one on demand).
    return {
      ok: true, reaped: false, before, after,
      message: after === null
        ? 'tmux: no server running before or after the restart'
        : `tmux: no server before the restart; server ${after} started after (nothing was lost)`,
    };
  }

  if (after === before) {
    return {
      ok: true, reaped: false, before, after,
      message: `tmux: server ${before} survived the restart`,
    };
  }

  // State what was LOST, not merely that a number moved — "pid changed" is not
  // something an operator can act on at 02:21.
  const fate = after === null
    ? `tmux server ${before} was REAPED by this restart and no server is running now`
    : `tmux server ${before} was REAPED by this restart and replaced by ${after}`;
  return {
    ok: false, reaped: true, before, after,
    message: `🔴 ${fate} — every Claude Code pane/session it hosted on this host is GONE. `
      + 'This is not a clean restart. See bl_88bf050b: the tmux server must not share Core\'s cgroup.',
  };
}
