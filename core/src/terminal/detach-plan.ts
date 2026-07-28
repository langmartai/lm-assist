/**
 * How to start the tmux SERVER so its lifetime is independent of Core's.
 *
 * The tmux server inherits the cgroup of whichever process first starts it. When
 * Core starts it, the server lands in Core's cgroup — and on a systemd node
 * `systemctl restart lm-assist` SIGTERMs every task in that cgroup, because
 * KillMode defaults to `control-group`. The tmux server dies, and every Claude
 * Code pane on the host dies with it.
 *
 * 🔴 Parentage is NOT the coupling — cgroup membership is. Measured on yitest
 * 2026-07-28: the tmux server was already `ppid=1` (tmux self-daemonizes, so it
 * is reparented to init with no help from us) and it was reaped anyway, from
 * cgroup `/system.slice/lm-assist.service`. `setsid` does not change a cgroup, so
 * on a systemd host it does not fix this. Only moving the server into its own
 * cgroup does — verified: a `systemd-run --user --scope` tmux server survived the
 * same restart that killed the unscoped one.
 *
 * The planner is pure so the choice is testable without a systemd host; every
 * environment fact is injected. It ALWAYS returns a runnable plan — isolation is
 * best-effort and must never be the reason a session fails to start.
 */

export type DetachKind = 'systemd-scope' | 'setsid' | 'plain';

export interface DetachProbe {
  /** Is this binary resolvable on PATH? */
  hasBinary: (name: string) => boolean;
  /** Does this path exist (file, dir or socket)? */
  pathExists: (p: string) => boolean;
  /** Effective uid of the Core process. */
  uid: number;
  /** `XDG_RUNTIME_DIR` as inherited, or null when unset. */
  xdgRuntimeDir: string | null;
  /** `DBUS_SESSION_BUS_ADDRESS` as inherited, or null when unset. */
  dbusAddress: string | null;
}

export interface DetachPlan {
  kind: DetachKind;
  /** Binary to exec. */
  file: string;
  /** Full argv (excluding `file`). */
  args: string[];
  /** Environment ADDITIONS, to be merged over the parent env by the caller. */
  env: Record<string, string>;
  /** Human-readable reason, for logs. */
  why: string;
}

/** The canonical "is systemd actually running" check. */
const SYSTEMD_MARKER = '/run/systemd/system';

export function planDetachedTmuxSpawn(tmuxArgs: readonly string[], probe: DetachProbe): DetachPlan {
  const passthrough = ['tmux', ...tmuxArgs];

  if (probe.pathExists(SYSTEMD_MARKER) && probe.hasBinary('systemd-run')) {
    // root has no per-user manager (`/run/user/0` normally does not exist), but it
    // can create a transient scope on the SYSTEM manager directly — which is still
    // outside `lm-assist.service`, and that is all we need.
    if (probe.uid === 0) {
      return {
        kind: 'systemd-scope',
        file: 'systemd-run',
        args: ['--scope', '--quiet', '--', ...passthrough],
        env: {},
        why: 'transient system scope (root) — outside any service cgroup',
      };
    }

    const runtimeDir = probe.xdgRuntimeDir || `/run/user/${probe.uid}`;
    if (probe.pathExists(runtimeDir)) {
      // A `--user` scope has to reach the per-user manager over its bus. Core runs
      // as a SYSTEM service (`User=yi`) and inherits NEITHER var, so systemd-run
      // fails with "Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS and
      // $XDG_RUNTIME_DIR not defined" and no tmux server is created at all
      // (measured). Synthesize both — but only when the socket is really there,
      // so we degrade instead of planning a call that cannot connect.
      const dbus = probe.dbusAddress
        || (probe.pathExists(`${runtimeDir}/bus`) ? `unix:path=${runtimeDir}/bus` : null);
      if (dbus) {
        return {
          kind: 'systemd-scope',
          file: 'systemd-run',
          args: ['--user', '--scope', '--quiet', '--', ...passthrough],
          env: { XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: dbus },
          why: 'transient --user scope under user@.service/app.slice',
        };
      }
    }
  }

  if (probe.hasBinary('setsid')) {
    return {
      kind: 'setsid',
      file: 'setsid',
      args: [...passthrough],
      env: {},
      // Honest about its limits: this is the right tool on a non-systemd POSIX
      // host, where the reaping mechanism is a group-wide signal rather than a
      // cgroup kill. It does NOT rescue a systemd node.
      why: 'no usable systemd scope — new session/process group (does NOT escape a cgroup)',
    };
  }

  return {
    kind: 'plain',
    file: 'tmux',
    args: [...tmuxArgs],
    env: {},
    why: 'no detach mechanism available — server shares Core\'s cgroup',
  };
}
