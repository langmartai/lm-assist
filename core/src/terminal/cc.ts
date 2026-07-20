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
import { decideOnboardingKeys } from './onboarding-prompts';
import type { CCLaunchInput, CCPivotInput, CCPromptInput, CCSessionState, CCPhase, SlashCommandInput, SelectChoiceInput, AwaitIdleInput } from './types';

function assertPosix(): void {
  if (!IS_POSIX) throw new TerminalError('PLATFORM_UNSUPPORTED', 'CC control requires a POSIX host');
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function remoteControlFlags(rc?: boolean): string[] {
  return rc ? ['--remote-control'] : [];
}

export function buildLaunchCmd(opts: CCLaunchInput): string {
  // Use the same binary resolution as the SDK runner (handles ~/.local/bin
  // installs that aren't on PATH for service-managed lm-assist).
  const bin = getClaudeBinaryPath();
  const flags: string[] = [
    ...(opts.skipPermissions ? ['--dangerously-skip-permissions'] : []),
    ...remoteControlFlags(opts.remoteControl),
    // Optional display name (-n) — titles the session (picker / terminal title /
    // the account /v1/code/sessions title), so RC sessions are identifiable.
    ...(opts.name ? ['-n', opts.name] : []),
    // Optional file-path flags (controller bootstrap). File paths only — never
    // an inline prompt, since this string is run as a shell command.
    ...(opts.appendSystemPromptFile ? ['--append-system-prompt-file', opts.appendSystemPromptFile] : []),
    ...(opts.mcpConfigPath ? ['--mcp-config', opts.mcpConfigPath] : []),
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

    // Poll loop: wait for idle, handling onboarding prompts and trust prompt as they appear.
    const pollMs = 200;
    const deadline = Date.now() + opts.readyTimeoutMs;
    const DEAD_THRESHOLD = 5;
    let consecutiveDead = 0;
    let finalPhase: CCPhase = 'unknown';
    while (Date.now() < deadline) {
      const state = inspector.getCCState(session);
      finalPhase = state.phase;

      if (state.phase === 'idle') {
        return { ready: true, finalPhase, trustPromptHandled, elapsedMs: Date.now() - start };
      }

      // Dismiss known onboarding prompts (e.g. fullscreen renderer?).
      const screen = state.lastSnapshot?.text ?? (tmux.exists(session) ? tmux.capture(session, { paneQualifier: null, lines: null, start: null }) : '');
      const onboardingAction = decideOnboardingKeys(screen);
      if (onboardingAction !== null) {
        tmux.sendKeysUnlocked(session, {
          keys: onboardingAction.keys,
          literal: true,
          enter: onboardingAction.enter,
          paneQualifier: null,
        });
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }

      // Handle workspace trust prompt when autoAcceptTrust is set.
      if (state.phase === 'trust-prompt' && opts.autoAcceptTrust) {
        // Default selection in the trust prompt is "Yes, I trust this folder".
        // Sending Enter accepts it.
        tmux.sendKeysUnlocked(session, { keys: 'Enter', literal: false, enter: false, paneQualifier: null });
        trustPromptHandled = true;
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }

      if (state.phase === 'dead') {
        consecutiveDead++;
        if (consecutiveDead >= DEAD_THRESHOLD) break;
      } else {
        consecutiveDead = 0;
      }

      await new Promise((r) => setTimeout(r, pollMs));
    }

    return { ready: false, finalPhase, trustPromptHandled, elapsedMs: Date.now() - start };
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

    // Send the prompt as literal text + VERIFIED submit (literal preserves any
    // chars tmux would otherwise interpret as key names).
    await typeAndSubmitVerified(session, opts.prompt);
    return { pivoted: true, finalPhase: 'busy', elapsedMs: Date.now() - start };
  });
}

// ── Verified submit ──────────────────────────────────────────────────────────
// Typing a large (multiline) text and firing Enter IMMEDIATELY afterwards is a
// race: the ink TUI is still ingesting the burst and the Enter gets consumed
// as pasted input instead of a submit — the message then sits SILENTLY in the
// composer. Observed live on the mission controller: pass directives and user
// chat messages stacked unsubmitted ("inputs lost"), and a later Enter flushed
// them all as ONE combined turn ("inputs duplicated"). So: type, let the TUI
// settle, submit, and VERIFY — retrying Enter is harmless (a no-op on an empty
// composer). An unverifiable submit throws, so callers record a FAILED
// delivery instead of a silent lie.

/** Pure: how long to let the TUI ingest a typed burst before submitting. */
export function computeSettleMs(textLength: number): number {
  return Math.max(150, Math.min(1500, 150 + Math.floor(textLength / 8)));
}

/**
 * Pure: the composer block of a captured pane — the contiguous lines between
 * the last blank line and the cwd/footer block at the bottom. Pending input
 * lives here; submitted history scrolls above the blank separator.
 */
export function extractComposerBlock(pane: string): string {
  const rows = pane.replace(/\n+$/, '').split('\n');
  // Walk up past the footer/status region (footer carries the ctx:/sid footer,
  // then the cwd line) to the input area, then collect until a blank line.
  let i = rows.length - 1;
  while (i >= 0 && rows[i].trim() !== '' && !/^\s*>/.test(rows[i])) i--; // skip footer lines upward
  const block: string[] = [];
  for (; i >= 0; i--) {
    if (rows[i].trim() === '') break;
    block.unshift(rows[i]);
  }
  return block.join('\n');
}

/** Pure: does the composer still hold the tail of the text we typed? */
export function composerHoldsText(pane: string, text: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const tail = norm(text).slice(-40);
  if (!tail) return false;
  return norm(extractComposerBlock(pane)).includes(tail);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Type text into the pane, settle, submit, and verify the submit took. */
async function typeAndSubmitVerified(session: string, text: string): Promise<void> {
  tmux.sendKeysUnlocked(session, { keys: text, literal: true, enter: false, paneQualifier: null });
  await sleep(computeSettleMs(text.length));
  for (let attempt = 1; attempt <= 3; attempt++) {
    tmux.sendKeysUnlocked(session, { keys: 'Enter', literal: false, enter: false, paneQualifier: null });
    await sleep(350 * attempt);
    // Submitted if the model left idle (working on it) …
    try { if (inspector.getCCState(session).phase !== 'idle') return; } catch { /* fall through to pane check */ }
    // … or if the composer no longer holds our text (instant completions).
    try {
      const pane = tmux.capture(session, { start: null, lines: 30, paneQualifier: null });
      if (!composerHoldsText(pane, text)) return;
    } catch { /* capture hiccup — retry */ }
  }
  throw new TerminalError('SUBMIT_UNVERIFIED', `typed prompt did not submit after 3 Enter attempts (text still in the composer of ${session})`);
}

/**
 * Send a prompt to the currently-loaded CC session. Asserts CC is at idle
 * phase first so we don't blast text into bash if CC has died, or into a
 * trust prompt, or into plan-mode confirmation. Submission is VERIFIED
 * (settle → Enter → confirm, with harmless retries).
 */
export async function prompt(session: string, opts: CCPromptInput): Promise<void> {
  assertPosix();
  return await withSessionLock(session, async () => {
    await redrawIfStuck(session);
    inspector.assertPhase(session, ['idle']);
    await typeAndSubmitVerified(session, opts.text);
  });
}

/**
 * A session detached/idle for a long time can accumulate STALE TUI PAINT — the
 * pane shows only border rows, so the inspector derives phase 'launching' and a
 * drive is wrongly rejected (observed live: it blocked a mission-controller
 * drive to an idle executor). Force a repaint (Ctrl+L) and let it settle when
 * the pane looks degenerate but the process is alive; harmless when the pane is
 * already healthy. Pure detector `paneLooksStuck` is unit-tested.
 */
export async function redrawIfStuck(session: string): Promise<void> {
  try {
    const state = inspector.getCCState(session);
    if (state.phase === 'idle') return;                 // healthy — no repaint needed
    if (!paneLooksStuck(state.lastSnapshot?.text ?? '')) return;
    tmux.sendKeysUnlocked(session, { keys: 'C-l', literal: false, enter: false, paneQualifier: null });
    await sleep(700);
  } catch { /* best-effort — assertPhase below still guards */ }
}

/** Pure: a pane is "stuck" when it has no real content — only borders/blank. */
export function paneLooksStuck(paneText: string): boolean {
  const rows = paneText.split('\n').map((r) => r.trim()).filter(Boolean);
  if (rows.length === 0) return true;
  // Real content = a line with letters/digits (a prompt ❯, footer, message).
  const hasContent = rows.some((r) => /[A-Za-z0-9❯$]/.test(r));
  return !hasContent;
}

/** Read-only state query (no lock — query is idempotent). */
export function status(session: string): CCSessionState {
  assertPosix();
  return inspector.getCCState(session);
}

/**
 * Pure: parse a numbered TUI dialog ("Would you like to proceed? ❯ 1. Yes …")
 * from a pane capture. Lets mission-control surface terminal dialogs (plan
 * approval, permission prompts) as answerable pendingQuestions — previously
 * they were invisible to every remote surface.
 */
export function parseDialogPrompt(paneText: string): { question: string; options: Array<{ label: string }> } | null {
  const rows = paneText.replace(/\n+$/, '').split('\n');
  const optRe = /^\s*(?:❯\s*)?([1-9])\.\s+(.+?)\s*$/;
  // The dialog's options are the BOTTOM-MOST contiguous numbered block that
  // includes option 1 — plan/content text above the dialog often contains its
  // own numbered lists and must not leak in.
  let end = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (optRe.test(rows[i])) { end = i; break; }
  }
  if (end < 0) return null;
  let start = end;
  while (start - 1 >= 0 && optRe.test(rows[start - 1])) start--;
  const block = rows.slice(start, end + 1)
    .map((r) => r.match(optRe) as RegExpMatchArray)
    .map((m) => ({ n: Number(m[1]), label: m[2] }));
  if (!block.some((o) => o.n === 1)) return null; // a trailing list, not a dialog
  // The question = nearest meaningful line above the block (skip borders/blank).
  let question = 'Session dialog';
  for (let i = start - 1; i >= 0; i--) {
    const t = rows[i].trim();
    if (t && !/^[─╌═┄┈\-—]+$/.test(t)) { question = t; break; }
  }
  const seen = new Set<number>();
  const options = block
    .filter((o) => (seen.has(o.n) ? false : (seen.add(o.n), true)))
    .sort((a, b) => a.n - b.n)
    .map((o) => ({ label: o.label }));
  return { question, options };
}

/**
 * Block until CC is idle (i.e. ready for the next prompt). Cheap wrapper
 * over `inspector.awaitPhase` that callers can use instead of polling
 * status or watching for the `ctx:` footer. Returns the final phase if
 * the wait expires.
 */
export async function awaitIdle(session: string, opts: AwaitIdleInput): Promise<{
  reached: boolean;
  elapsedMs: number;
  finalPhase: CCPhase;
}> {
  assertPosix();
  return await inspector.awaitPhase(session, 'idle', { timeoutMs: opts.timeoutMs, pollMs: opts.pollMs });
}

/**
 * Send Ctrl+C to the session, interrupting a running CC operation.
 *
 * Precondition: the session must exist. We don't require a specific phase —
 * `interrupt` is meant to be callable when CC is busy/wedged, and the caller
 * knows what they're doing.
 */
export async function interrupt(session: string): Promise<void> {
  assertPosix();
  return await withSessionLock(session, async () => {
    if (!tmux.exists(session)) throw new TerminalError('SESSION_NOT_FOUND', `tmux session not found: ${session}`);
    // 'C-c' is tmux's name for Ctrl-C. Must be non-literal (key name).
    tmux.sendKeysUnlocked(session, { keys: 'C-c', literal: false, enter: false, paneQualifier: null });
  });
}

/**
 * Send a slash command (e.g. /clear, /agents, /logout, /config, /export).
 *
 * Precondition: CC is idle (sending a slash command while CC is busy is a
 * silent no-op at best, undefined behavior at worst). For dialog-answering
 * use acceptDialog/rejectDialog/selectChoice instead.
 */
export async function slash(session: string, opts: SlashCommandInput): Promise<void> {
  assertPosix();
  return await withSessionLock(session, async () => {
    inspector.assertPhase(session, ['idle']);
    const text = '/' + opts.cmd + (opts.args ? ' ' + opts.args : '');
    tmux.sendKeysUnlocked(session, { keys: text, literal: true, enter: true, paneQualifier: null });
  });
}

/**
 * Accept the current dialog (Enter on the default option).
 *
 * Precondition: there must be a pendingDialog — otherwise this would send a
 * stray Enter into the prompt buffer, which CC interprets as "submit".
 */
export async function acceptDialog(session: string): Promise<{ dialog: string }> {
  assertPosix();
  return await withSessionLock(session, async () => {
    if (!tmux.exists(session)) throw new TerminalError('SESSION_NOT_FOUND', `tmux session not found: ${session}`);
    const state = inspector.getCCState(session);
    if (!state.pendingDialog) {
      throw new TerminalError('PRECONDITION_FAILED', `no pending dialog on ${session} (phase=${state.phase})`);
    }
    tmux.sendKeysUnlocked(session, { keys: 'Enter', literal: false, enter: false, paneQualifier: null });
    return { dialog: state.pendingDialog };
  });
}

/** Reject the current dialog (Esc). */
export async function rejectDialog(session: string): Promise<{ dialog: string }> {
  assertPosix();
  return await withSessionLock(session, async () => {
    if (!tmux.exists(session)) throw new TerminalError('SESSION_NOT_FOUND', `tmux session not found: ${session}`);
    const state = inspector.getCCState(session);
    if (!state.pendingDialog) {
      throw new TerminalError('PRECONDITION_FAILED', `no pending dialog on ${session} (phase=${state.phase})`);
    }
    tmux.sendKeysUnlocked(session, { keys: 'Escape', literal: false, enter: false, paneQualifier: null });
    return { dialog: state.pendingDialog };
  });
}

/**
 * Press a digit key (1–9) to select the corresponding numbered menu option.
 *
 * CC's multi-choice dialogs treat 1, 2, … as hotkeys, immediately selecting
 * that option. Precondition: a 'choice' dialog is pending.
 */
export async function selectChoice(session: string, opts: SelectChoiceInput): Promise<{ chose: number }> {
  assertPosix();
  return await withSessionLock(session, async () => {
    if (!tmux.exists(session)) throw new TerminalError('SESSION_NOT_FOUND', `tmux session not found: ${session}`);
    const state = inspector.getCCState(session);
    if (state.pendingDialog !== 'choice' && state.pendingDialog !== 'trust' && state.pendingDialog !== 'permission' && state.pendingDialog !== 'compact') {
      throw new TerminalError('PRECONDITION_FAILED', `no dialog accepting numbered choice on ${session} (pendingDialog=${state.pendingDialog})`);
    }
    if (!Number.isInteger(opts.n) || opts.n < 1 || opts.n > 9) {
      throw new TerminalError('INVALID_INPUT', `select-choice n must be 1..9, got ${opts.n}`);
    }
    tmux.sendKeysUnlocked(session, { keys: String(opts.n), literal: true, enter: false, paneQualifier: null });
    return { chose: opts.n };
  });
}
