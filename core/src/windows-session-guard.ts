/**
 * Refuse to start a Core that cannot drive anything.
 *
 * On Windows, `lm-assist start` over SSH lands in **session 0** — OpenSSH runs
 * there — and Session 0 isolation then blocks Core from touching the interactive
 * desktop. Everything still looks healthy: the API answers, sessions list,
 * restarts survive. But every session reports `driveable:false`, keystrokes go
 * nowhere, and `windows_terminal_create` creates nothing at all.
 *
 * That silent degradation is the whole problem. The Linux equivalent already has
 * a guard — `startCore` refuses when systemd owns the unit — but its failure is
 * LOUD (a crash-loop on EADDRINUSE), so a start-time message suffices. Here the
 * failure is invisible, so this also feeds `status`, letting someone who never
 * saw the start-time message still find out.
 *
 * Measured on DESKTOP-GDKLATG 2026-07-28: Core in session 0 → every session
 * `driveable:false` with an empty `consoleTitle`; moved to session 1 → all
 * driveable, titles readable, typing works.
 *
 * Pure. Every environment fact is injected.
 */

/** The scheduled task that launches Core in the interactive desktop session. */
export const INTERACTIVE_TASK = 'LmAssistCoreInteractive';

export interface WindowsStartFacts {
  isWindows: boolean;
  /** Windows session of the process about to start Core. `null` = could not tell. */
  mySessionId: number | null;
  /** An ACTIVE interactive console session, if one exists. `null` = nobody logged on. */
  interactiveSessionId: number | null;
  /** Name of the interactive-launch scheduled task, when one is registered. */
  taskName: string | null;
}

export interface WindowsStartVerdict {
  /**
   * redirect = start it through the interactive task instead (self-correcting);
   * refuse   = do not start, nothing better is available to redirect to;
   * warn     = start anyway, but say it will not be able to drive.
   */
  action: 'proceed' | 'redirect' | 'refuse' | 'warn';
  message: string | null;
  /** The task to redirect through. Set only with action 'redirect'. */
  taskName?: string;
}

/**
 * Should this start proceed?
 *
 * Refuses ONLY when there is a better way available — a registered task and a
 * desktop to land in. Every other degraded case still starts: a Core that cannot
 * drive is worse than a healthy one, but far better than no Core at all.
 */
export function planWindowsStart(f: WindowsStartFacts): WindowsStartVerdict {
  if (!f.isWindows) return { action: 'proceed', message: null };
  // Anything that is not a confirmed session 0 proceeds — including `null`, an
  // unknown from a failed probe. Unknown is not evidence of trouble, and refusing
  // on it would strand a node whose PowerShell probe merely timed out.
  if (f.mySessionId !== 0) return { action: 'proceed', message: null };

  // From here: we are in session 0, the non-interactive service session.
  if (f.taskName && f.interactiveSessionId !== null) {
    // REDIRECT rather than refuse. Session 0 can trigger a scheduled task, and the
    // task's own principal decides where Core lands — so the fix can simply be
    // APPLIED instead of printed. Telling someone to run a command we could run
    // ourselves is a worse answer to the same problem.
    return {
      action: 'redirect',
      taskName: f.taskName,
      message:
        `starting through "${f.taskName}" so Core lands in the interactive desktop session `
        + `(${f.interactiveSessionId}). A direct start here would be in Windows session 0, where `
        + `Session 0 isolation lets it list sessions but never TYPE into them, create a terminal, `
        + `or drive a mission worker — while still reporting healthy. `
        + `(Starting over SSH is the usual way to land in session 0 — OpenSSH runs there.)`,
    };
  }

  if (!f.taskName) {
    return {
      action: 'warn',
      message:
        `⚠ Starting in Windows session 0 — Core will NOT be able to type into sessions, create `
        + `terminals, or drive mission workers (Session 0 isolation). No "${INTERACTIVE_TASK}" `
        + `scheduled task is registered to start it on the interactive desktop. Register one `
        + `(RunLevel Highest, LogonType Interactive, action \`lm-assist start\`) and launch Core `
        + `through it to make driving work.`,
    };
  }

  // Task exists but nobody is logged on — session 1 does not exist yet, so
  // session 0 is genuinely the only option. Start, and say what is missing.
  return {
    action: 'warn',
    message:
      `⚠ Starting in Windows session 0 — no interactive desktop session exists (nobody logged on), `
      + `so Core cannot drive sessions yet. Once a user logs on, restart it via `
      + `"${INTERACTIVE_TASK}" (its Logon trigger does this automatically) to enable driving.`,
  };
}

/**
 * The persistent signal for `status` / health.
 *
 * The start-time message is seen once, by whoever ran the command. This is what
 * someone inheriting the box finds later.
 */
export function windowsDriveHealth(f: WindowsStartFacts): { driveable: boolean; reason: string | null } {
  if (!f.isWindows || f.mySessionId === null) return { driveable: true, reason: null };
  if (f.mySessionId !== 0) return { driveable: true, reason: null };
  return {
    driveable: false,
    reason:
      `Core is running in Windows session 0 (service session); interactive sessions live in `
      + `session ${f.interactiveSessionId ?? '<none>'}. Session 0 isolation blocks typing, terminal `
      + `creation and mission-worker driving. Restart via "${f.taskName ?? INTERACTIVE_TASK}".`,
  };
}

/**
 * Did the redirect actually work?
 *
 * Firing the task and reporting success would be the same false-confidence bug
 * this branch has fixed four times over. The only acceptable evidence is a Core
 * that answers AND is demonstrably out of session 0.
 */
export function describeRedirectOutcome(
  healthy: boolean, coreSession: number | null, taskName: string,
): { success: boolean; message: string } {
  if (!healthy) {
    return {
      success: false,
      message:
        `started "${taskName}" but Core did not come up. Run it by hand to see why:\n`
        + `    schtasks /run /tn ${taskName}\n`
        + `then check: lm-assist status`,
    };
  }
  if (coreSession === 0) {
    return {
      success: false,
      message:
        `"${taskName}" ran and Core is healthy, but it is STILL in Windows session 0 — it cannot `
        + `drive sessions. Check the task's principal: it needs LogonType=Interactive so it uses `
        + `the logged-on user's session.`,
    };
  }
  return {
    success: true,
    message: `Core API started via "${taskName}" in Windows session ${coreSession ?? '?'} (driveable)`,
  };
}
