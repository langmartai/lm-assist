/**
 * Inspector — derives Claude Code phase from tmux pane state and screen text.
 *
 * Read-only. Used by cc.ts to assert preconditions (am I at the prompt?) and
 * verify postconditions (did the screen actually transition?). Without this,
 * every cc* operation is fire-and-pray.
 */

import * as tmux from './tmux';
import type { CCPhase, CCSessionState } from './types';
import { TerminalError } from './errors';

const PROMPT_INDICATOR = '❯';
const TRUST_INDICATORS = [
  'Yes, I trust this folder',
  'Quick safety check',
];
const PERMISSION_INDICATORS = [
  'Allow this action?',
  'Permission required',
];
const PLAN_MODE_INDICATORS = [
  '⏺ plan mode',
  'PLAN MODE',
];
const READY_FOOTER_INDICATORS = ['ctx:'];

/** Snapshot the current pane screen with timestamp — used for delta-waits. */
export function snapshot(name: string): { text: string; capturedAt: number } {
  const text = tmux.capture(name, { paneQualifier: null, lines: null, start: null });
  return { text, capturedAt: Date.now() };
}

/** Wait until the pane's visible screen is materially different from `before`. */
export async function awaitScreenChange(
  name: string,
  before: { text: string },
  opts: { timeoutMs: number; pollMs?: number } = { timeoutMs: 5000 },
): Promise<{ changed: boolean; elapsedMs: number; latest: string }> {
  const pollMs = opts.pollMs ?? 100;
  const start = Date.now();
  let latest = before.text;
  while (Date.now() - start < opts.timeoutMs) {
    if (!tmux.exists(name)) {
      return { changed: false, elapsedMs: Date.now() - start, latest };
    }
    latest = tmux.capture(name, { paneQualifier: null, lines: null, start: null });
    if (latest !== before.text) return { changed: true, elapsedMs: Date.now() - start, latest };
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { changed: false, elapsedMs: Date.now() - start, latest };
}

/** Derive CCPhase from the pane's program + screen text. */
export function derivePhase(paneCommand: string | null, screen: string): CCPhase {
  if (paneCommand === null) return 'dead';
  // CC TUI runs as 'node' (or 'claude' on some installs). Heuristic: trust
  // text content, not the process name, because CC runs as `node` from npm.
  const looksLikeCC = screen.includes(PROMPT_INDICATOR)
    || TRUST_INDICATORS.some((s) => screen.includes(s))
    || READY_FOOTER_INDICATORS.some((s) => screen.includes(s))
    || PERMISSION_INDICATORS.some((s) => screen.includes(s));
  if (!looksLikeCC) {
    // Pane has a program (probably bash) but no CC TUI markers → CC not running.
    return 'dead';
  }
  if (TRUST_INDICATORS.some((s) => screen.includes(s))) return 'trust-prompt';
  if (PERMISSION_INDICATORS.some((s) => screen.includes(s))) return 'permission';
  if (PLAN_MODE_INDICATORS.some((s) => screen.includes(s))) return 'plan-mode';
  if (READY_FOOTER_INDICATORS.some((s) => screen.includes(s)) && screen.includes(PROMPT_INDICATOR)) {
    return 'idle';
  }
  if (READY_FOOTER_INDICATORS.some((s) => screen.includes(s))) return 'busy';
  return 'launching';
}

export function getCCState(name: string): CCSessionState {
  if (!tmux.exists(name)) {
    return { phase: 'dead', model: null, lastSnapshot: null };
  }
  const tstate = tmux.getState(name);
  const snap = snapshot(name);
  const phase = derivePhase(tstate.paneCommand, snap.text);
  // Best-effort model extraction from TUI footer (e.g. "claude-opus-4-7").
  const m = snap.text.match(/(?:claude-)?(opus|sonnet|haiku)-?\d?(?:\.\d)?(?:-\d)?/i);
  const model = m ? m[0] : null;
  return { phase, model, lastSnapshot: snap };
}

export async function awaitPhase(
  name: string,
  desired: CCPhase,
  opts: { timeoutMs: number; pollMs?: number },
): Promise<{ reached: boolean; elapsedMs: number; finalPhase: CCPhase }> {
  const pollMs = opts.pollMs ?? 200;
  const start = Date.now();
  let finalPhase: CCPhase = 'unknown';
  while (Date.now() - start < opts.timeoutMs) {
    const state = getCCState(name);
    finalPhase = state.phase;
    if (state.phase === desired) {
      return { reached: true, elapsedMs: Date.now() - start, finalPhase };
    }
    if (state.phase === 'dead' && desired !== 'dead') {
      // No point waiting; the pane has no CC.
      return { reached: false, elapsedMs: Date.now() - start, finalPhase };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { reached: false, elapsedMs: Date.now() - start, finalPhase };
}

export function assertPhase(name: string, allowed: CCPhase[]): CCSessionState {
  const state = getCCState(name);
  if (!allowed.includes(state.phase)) {
    throw new TerminalError(
      'PRECONDITION_FAILED',
      `CC session ${name} is in phase '${state.phase}', expected one of: ${allowed.join(', ')}`,
      { session: name, current: state.phase, allowed },
    );
  }
  return state;
}
