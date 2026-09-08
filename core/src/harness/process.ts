/**
 * Ending a harness run's child process.
 *
 * Shared by every harness that owns a whole CLI per run. It lives here rather
 * than in one harness because the second harness needed exactly the same thing,
 * and this file's own history is the argument: qwen.ts warns that three
 * option→flag mappers drifted apart precisely because each was embedded in its
 * own spawn path. A kill that is subtly different per harness is worse than a
 * mapper that is — it fails silently, and it fails while something is still
 * running.
 */

import type { ChildProcess } from 'child_process';

/** How long a terminated run may take to exit before it is killed outright. */
export const KILL_GRACE_MS = 5000;

/**
 * Signal a run's whole process group, escalating to SIGKILL if it lingers.
 *
 * Why the GROUP and not just the child: these CLIs run auto-approved shell
 * commands, and opencode additionally starts a local server subprocess. A
 * SIGTERM to the top-level process alone can leave a build, a curl or a server
 * running with nobody tracking it — the abort would look clean and leak work.
 * Callers spawn with `detached: true` precisely so `kill(-pid)` can end all of
 * it at once.
 *
 * Returns false when there was nothing alive to signal, which is what makes an
 * honest "no, that did not stop anything" answer possible upstream.
 *
 * A grandchild that calls setsid() escapes its group and therefore escapes this;
 * nothing short of a cgroup would catch that, and neither CLI does it.
 */
export function terminateRun(child: ChildProcess, graceMs: number = KILL_GRACE_MS): boolean {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return false;

  const pid = child.pid;
  const signalGroup = (sig: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      // No process group (already reaped, or a platform without one) — fall back
      // to the single child so a lingering run is still ended.
      try {
        return child.kill(sig as NodeJS.Signals);
      } catch {
        return false;
      }
    }
  };

  if (!signalGroup('SIGTERM')) return false;

  // 🔴 The escalation probes the GROUP and is deliberately NOT cancelled when the
  // direct child exits. MEASURED on qwen 0.15.10: `qwen` forks a second node
  // process that ignores SIGTERM and OUTLIVES its parent. The obvious way to
  // write this — clear the timer on the child's `close` event — therefore cancels
  // the escalation moments before the only process that still needs killing, and
  // the abort looks clean while an agent keeps running. Signalling a group whose
  // leader has exited is valid for as long as any member remains, which is
  // exactly the window that matters here.
  const escalate = setTimeout(() => {
    if (signalGroup(0)) signalGroup('SIGKILL');
  }, graceMs);
  // A pending kill timer must not hold Core's event loop open on shutdown.
  escalate.unref?.();
  return true;
}
