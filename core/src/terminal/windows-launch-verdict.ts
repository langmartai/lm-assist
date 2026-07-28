/**
 * Did a Windows Terminal launch actually produce anything?
 *
 * The spawn is `spawn('wt.exe', …, { detached: true, stdio: 'ignore' })` followed
 * by `unref()` — fire-and-forget. Nothing about that call tells us a window
 * exists, so `launched` must be decided by OBSERVED evidence afterwards.
 *
 * 🔴 It used to be a hardcoded `true`. Measured on DESKTOP-GDKLATG 2026-07-28:
 * `windows_terminal_create` reported `launched: true, sessionId: null` while the
 * host had gained no process at all. The cause is Session 0 isolation — Core runs
 * as a service in Windows session 0 and cannot create a window on the interactive
 * desktop — and the caller was told it had succeeded.
 *
 * Pure: every fact is injected, so the verdict is testable without Windows.
 */

export interface LaunchEvidence {
  /** A new Claude Code session registered in the session registry. */
  sessionRegistered: boolean;
  /** The Windows Terminal tab set gained at least one tab. */
  tabAppeared: boolean;
  /** A new claude/terminal process was observed. */
  processAppeared: boolean;
  /** Windows session the Core runs in — 0 is the non-interactive service session. */
  coreSessionId: number | null;
  /** The interactive desktop session, when known. */
  desktopSessionId: number | null;
  /** Whatever `spawn` reported, if anything. */
  spawnError?: string | null;
}

export interface LaunchVerdict {
  /** True only when something was actually observed. */
  launched: boolean;
  /** Why it failed, or what is still pending. Undefined on a clean success. */
  note: string | undefined;
}

const SESSION0_DIAGNOSIS =
  'nothing appeared on the host. lm-assist Core is running in Windows session 0 '
  + '(the non-interactive service session), which cannot create a window on the '
  + 'interactive desktop — Session 0 isolation. Run the Core in the interactive '
  + 'desktop session (e.g. a scheduled task set to "run only when user is logged on").';

export function describeWindowsLaunch(ev: LaunchEvidence): LaunchVerdict {
  const appeared = ev.sessionRegistered || ev.tabAppeared || ev.processAppeared;

  if (!appeared) {
    // Report the spawn error first when there is one — it is the most specific
    // thing we know, and a missing wt.exe is not a Session 0 problem.
    if (ev.spawnError) {
      return { launched: false, note: `launch failed: ${ev.spawnError}` };
    }
    // A session-0 Core is a sufficient explanation on its own: the failure path
    // usually has no pid to map, so desktopSessionId is frequently unknown.
    if (ev.coreSessionId === 0) {
      return { launched: false, note: SESSION0_DIAGNOSIS };
    }
    return {
      launched: false,
      note: 'nothing appeared on the host — no new session, tab or process was observed '
        + 'within the wait window. The terminal was never created.',
    };
  }

  // Something exists. The only remaining question is whether it finished
  // becoming a usable session.
  if (!ev.sessionRegistered) {
    return {
      launched: true,
      note: 'a terminal was created but no Claude session registered within the wait '
        + 'window — a folder-trust prompt may still be pending (autoTrust disabled, or '
        + 'the prompt differs). Capture the new pid to see it.',
    };
  }

  return { launched: true, note: undefined };
}
