/**
 * Inspector — derives Claude Code phase from tmux pane state and screen text.
 *
 * Read-only. Used by cc.ts to assert preconditions (am I at the prompt?) and
 * verify postconditions (did the screen actually transition?). Without this,
 * every cc* operation is fire-and-pray.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tmux from './tmux';
import type { CCPhase, CCSessionState, CCMode, CCDialog, CCAuthState } from './types';
import { TerminalError } from './errors';

const PROMPT_INDICATOR = '❯';
const TRUST_INDICATORS = [
  'Yes, I trust this folder',
  'Quick safety check',
];
const PERMISSION_INDICATORS = [
  'Allow this action?',
  'Permission required',
  'Do you want to',
];
const PLAN_MODE_INDICATORS = [
  '⏺ plan mode',
  'PLAN MODE',
  'plan mode on',
];
const COMPACT_INDICATORS = [
  'Compact this conversation',
  'context limit',
  'compact now',
];
const BASH_MODE_INDICATORS = [
  '! bash',
  'bash mode',
];
const LOGGED_OUT_INDICATORS = [
  'Please log in',
  'Login Required',
  'OAuth',
  'auth.anthropic.com',
];
const READY_FOOTER_INDICATORS = ['ctx:'];
// e.g. "ctx: 42%" or "ctx: 100%"
const CONTEXT_PCT_RE = /ctx:\s*(\d{1,3})\s*%/i;

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

/**
 * Known POSIX shell names — if the pane is running one of these AND there
 * are no CC markers on screen, CC truly isn't running here.
 */
const KNOWN_SHELLS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh']);

/** Derive CCPhase from the pane's program + screen text. */
export function derivePhase(paneCommand: string | null, screen: string): CCPhase {
  if (paneCommand === null) return 'dead';
  const hasMarkers = screen.includes(PROMPT_INDICATOR)
    || TRUST_INDICATORS.some((s) => screen.includes(s))
    || READY_FOOTER_INDICATORS.some((s) => screen.includes(s))
    || PERMISSION_INDICATORS.some((s) => screen.includes(s));
  if (!hasMarkers) {
    // No CC markers yet. Two cases:
    //   - pane runs a known shell → CC is not here (dead)
    //   - pane runs something else (typically 'node' for the npm-installed
    //     claude) → CC is initializing its TUI (launching)
    return KNOWN_SHELLS.has(paneCommand) ? 'dead' : 'launching';
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

/** Detect CC's interaction mode from screen text. */
export function deriveMode(screen: string): CCMode {
  if (PLAN_MODE_INDICATORS.some((s) => screen.includes(s))) return 'plan';
  if (BASH_MODE_INDICATORS.some((s) => screen.includes(s))) return 'bash';
  if (READY_FOOTER_INDICATORS.some((s) => screen.includes(s))) return 'normal';
  return 'unknown';
}

/** Detect which dialog (if any) CC is currently asking about. */
export function deriveDialog(screen: string): CCDialog {
  if (TRUST_INDICATORS.some((s) => screen.includes(s))) return 'trust';
  if (PERMISSION_INDICATORS.some((s) => screen.includes(s))) return 'permission';
  if (COMPACT_INDICATORS.some((s) => screen.includes(s))) return 'compact';
  // Multi-choice menus: "1. ... 2. ... 3. ..." with a leading ❯ on one line
  // and no other dialog matched. Heuristic: at least two numbered items.
  const numbered = screen.match(/^\s*\d+[\).]\s+\S/gm);
  if (numbered && numbered.length >= 2 && screen.includes(PROMPT_INDICATOR)) return 'choice';
  return null;
}

/** Parse `ctx: NN%` from footer. */
export function parseContextPct(screen: string): number | null {
  const m = screen.match(CONTEXT_PCT_RE);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

interface AuthInfo {
  state: CCAuthState;
  email: string | null;
}

/**
 * Resolve auth state with a layered strategy:
 *   1. Read ~/.claude.json `oauthAccount` — primary source of truth.
 *   2. If absent/missing, look at the screen for logged-out indicators.
 *   3. Otherwise: unknown.
 */
export function getAuthInfo(screen: string): AuthInfo {
  // Layer 1: config file.
  try {
    const cfgPath = path.join(os.homedir(), '.claude.json');
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    const cfg = JSON.parse(raw) as { oauthAccount?: { accountUuid?: string; emailAddress?: string } };
    if (cfg.oauthAccount && typeof cfg.oauthAccount.accountUuid === 'string' && cfg.oauthAccount.accountUuid.length > 0) {
      return { state: 'authenticated', email: cfg.oauthAccount.emailAddress ?? null };
    }
    // Config exists but no oauth → explicitly logged out.
    return { state: 'unauthenticated', email: null };
  } catch {
    // Config not readable; fall back to screen.
  }
  if (LOGGED_OUT_INDICATORS.some((s) => screen.includes(s))) {
    return { state: 'unauthenticated', email: null };
  }
  return { state: 'unknown', email: null };
}

export function getCCState(name: string): CCSessionState {
  if (!tmux.exists(name)) {
    return {
      phase: 'dead', model: null, lastSnapshot: null,
      currentMode: 'unknown', pendingDialog: null,
      authState: 'unknown', contextPct: null, authEmail: null,
    };
  }
  const tstate = tmux.getState(name);
  const snap = snapshot(name);
  const phase = derivePhase(tstate.paneCommand, snap.text);
  const m = snap.text.match(/(?:claude-)?(opus|sonnet|haiku)-?\d?(?:\.\d)?(?:-\d)?/i);
  const model = m ? m[0] : null;
  const currentMode = deriveMode(snap.text);
  const pendingDialog = deriveDialog(snap.text);
  const contextPct = parseContextPct(snap.text);
  const auth = getAuthInfo(snap.text);
  return {
    phase, model, lastSnapshot: snap,
    currentMode, pendingDialog,
    authState: auth.state, contextPct, authEmail: auth.email,
  };
}

export async function awaitPhase(
  name: string,
  desired: CCPhase,
  opts: { timeoutMs: number; pollMs?: number },
): Promise<{ reached: boolean; elapsedMs: number; finalPhase: CCPhase }> {
  const pollMs = opts.pollMs ?? 200;
  const start = Date.now();
  let finalPhase: CCPhase = 'unknown';
  // Allow a few consecutive 'dead' polls before bailing — CC can momentarily
  // appear dead between the bash spawn and the node process taking over the
  // pane (paneCommand may still be 'bash' for a tick).
  const DEAD_THRESHOLD = 5;
  let consecutiveDead = 0;
  while (Date.now() - start < opts.timeoutMs) {
    const state = getCCState(name);
    finalPhase = state.phase;
    if (state.phase === desired) {
      return { reached: true, elapsedMs: Date.now() - start, finalPhase };
    }
    if (state.phase === 'dead' && desired !== 'dead') {
      consecutiveDead++;
      if (consecutiveDead >= DEAD_THRESHOLD) {
        return { reached: false, elapsedMs: Date.now() - start, finalPhase };
      }
    } else {
      consecutiveDead = 0;
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
