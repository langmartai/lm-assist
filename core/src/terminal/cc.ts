/**
 * Claude Code adapter — phase-aware operations on a tmux-hosted CC session.
 *
 * Every operation:
 *   1. holds the per-session mutex (no interleaving with parallel callers)
 *   2. asserts the precondition (CC is in an allowed phase)
 *   3. mutates (send-keys, etc.)
 *   4. verifies the postcondition (screen changed, expected phase reached)
 *
 * Without this, every cc* operation is fire-and-pray. Bugs 1, 2, 3, 8 in the
 * original implementation were all instances of skipping step 1, 2, or 4.
 */

import { getClaudeBinaryPath, IS_POSIX } from '../utils/process-utils';
import * as tmux from './tmux';
import * as inspector from './inspector';
import { withSessionLock } from './mutex';
import { TerminalError } from './errors';
import type { CCLaunchInput, CCPivotInput, CCPromptInput, CCSessionState, CCPhase } from './types';

function assertPosix(): void {
  if (!IS_POSIX) throw new TerminalError('PLATFORM_UNSUPPORTED', 'CC control requires a POSIX host');
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildLaunchCmd(opts: CCLaunchInput): string {
  // Use the same binary resolution as the SDK runner (handles ~/.local/bin
  // installs that aren't on PATH for service-managed lm-assist).
  const bin = getClaudeBinaryPath();
  const flags: string[] = [
    ...(opts.skipPermissions ? ['--dangerously-skip-permissions'] : []),
    ...opts.extraFlags,                              // MERGED with default, not replaced
    ...(opts.model ? ['--model', opts.model] : []),
  ];
  return `${shellQuote(bin)} ${flags.map(shellQuote).join(' ')}`.trim();
}

/**
 * Launch CC inside (or attach to existing) tmux session, wait until it's
 * idle (at the ❯ prompt). Handles the workspace trust prompt.
 */
export async function launch(session: string, opts: CCLaunchInput): Promise<{
  ready: boolean;
  finalPhase: CCPhase;
  trustPromptHandled: boolean;
  elapsedMs: number;
}> {
  assertPosix();
  return await withSessionLock(session, async () => {
    const start = Date.now();
    let trustPromptHandled = false;

    // Create session if needed (unlocked variant — we already hold the lock).
    tmux.createUnlocked(session, { cwd: opts.cwd, cols: opts.cols, rows: opts.rows });

    // Send the launch command.
    const cmd = buildLaunchCmd(opts);
    tmux.sendKeysUnlocked(session, { keys: cmd, literal: false, enter: true, paneQualifier: null });

    // Wait for either: ready footer (ctx:), trust prompt, or timeout.
    const ready = await inspector.awaitPhase(session, 'idle', { timeoutMs: opts.readyTimeoutMs });
    if (ready.reached) {
      return { ready: true, finalPhase: ready.finalPhase, trustPromptHandled, elapsedMs: Date.now() - start };
    }

    // Not idle — check what we ARE in.
    const state = inspector.getCCState(session);
    if (state.phase === 'trust-prompt' && opts.autoAcceptTrust) {
      // Default selection in the trust prompt is "Yes, I trust this folder".
      // Sending Enter accepts it.
      tmux.sendKeysUnlocked(session, { keys: 'Enter', literal: false, enter: false, paneQualifier: null });
      trustPromptHandled = true;
      const after = await inspector.awaitPhase(session, 'idle', { timeoutMs: opts.readyTimeoutMs });
      return {
        ready: after.reached,
        finalPhase: after.finalPhase,
        trustPromptHandled,
        elapsedMs: Date.now() - start,
      };
    }

    return { ready: false, finalPhase: state.phase, trustPromptHandled, elapsedMs: Date.now() - start };
  });
}

/**
 * Pivot a running CC to a different session id and re-send a prompt.
 *
 * Race-safe: snapshots the screen BEFORE sending /resume, then waits for the
 * screen to materially change (proving /resume took effect) BEFORE waiting for
 * the new ❯ prompt. The original implementation matched the OLD ❯ instantly
 * and sent the prompt during the resume's loading screen.
 */
export async function pivot(session: string, opts: CCPivotInput): Promise<{
  pivoted: boolean;
  finalPhase: CCPhase;
  elapsedMs: number;
}> {
  assertPosix();
  return await withSessionLock(session, async () => {
    const start = Date.now();
    inspector.assertPhase(session, ['idle', 'busy', 'plan-mode']);

    const before = inspector.snapshot(session);
    tmux.sendKeysUnlocked(session, {
      keys: `/resume ${opts.newSessionId}`, literal: false, enter: true, paneQualifier: null,
    });

    // Wait for screen to change — proves /resume started loading.
    const changed = await inspector.awaitScreenChange(session, before, { timeoutMs: 5000 });
    if (!changed.changed) {
      return { pivoted: false, finalPhase: 'unknown', elapsedMs: Date.now() - start };
    }

    // Now wait for new idle phase.
    const ready = await inspector.awaitPhase(session, 'idle', { timeoutMs: opts.timeoutMs });
    if (!ready.reached) {
      return { pivoted: false, finalPhase: ready.finalPhase, elapsedMs: Date.now() - start };
    }

    // Send the prompt as literal text + Enter (literal preserves any chars
    // tmux would otherwise interpret as key names).
    tmux.sendKeysUnlocked(session, { keys: opts.prompt, literal: true, enter: true, paneQualifier: null });
    return { pivoted: true, finalPhase: 'busy', elapsedMs: Date.now() - start };
  });
}

/**
 * Send a prompt to the currently-loaded CC session. Asserts CC is at idle
 * phase first so we don't blast text into bash if CC has died, or into a
 * trust prompt, or into plan-mode confirmation.
 */
export async function prompt(session: string, opts: CCPromptInput): Promise<void> {
  assertPosix();
  return await withSessionLock(session, async () => {
    inspector.assertPhase(session, ['idle']);
    tmux.sendKeysUnlocked(session, { keys: opts.text, literal: true, enter: true, paneQualifier: null });
  });
}

/** Read-only state query (no lock — query is idempotent). */
export function status(session: string): CCSessionState {
  assertPosix();
  return inspector.getCCState(session);
}
