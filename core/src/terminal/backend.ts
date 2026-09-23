/**
 * Standardized terminal abstraction — the SHARED interface both platforms
 * implement, so routes / MCP / session-messaging drivers are a thin uniform
 * dispatch instead of per-handler `if (IS_WINDOWS)`.
 *
 *   TerminalBackend  — generic terminal ops (list/create/capture/sendKeys/close).
 *                      Opaque `id`: a tmux session name on Linux, a terminal-
 *                      hosted pid on Windows. Implemented by tmux-backend.ts /
 *                      wt-backend.ts (adapters over tmux.ts / windows-terminal.ts).
 *   CcController      — Claude Code session ops, keyed by the cross-platform
 *                      Claude `sessionId` (cc-sessions maps it to a tmux pane on
 *                      Linux or a pid/tab on Windows). Implemented per backend
 *                      (adapters over cc.ts / windows-cc.ts).
 *
 * The registry picks the platform backend once; callers never branch on OS.
 */

import { IS_WINDOWS } from '../utils/process-utils';
import type { Verdict } from './cc-sessions';

/**
 * Cross-platform navigation/dialog keys accepted in the cc-sessions prompt
 * `keys` array. RESTRICTED on purpose to the set BOTH backends deliver
 * identically:
 *   - `tmux` — a tmux send-keys key name (types.ts NAMED_KEYS).
 *   - `wt`   — a WriteConsoleInput token (windows-terminal.ts SendConsoleKeys).
 * These are the keys that drive a CC menu/dialog. Deliberately NOT here:
 *   - Ctrl-C — that is the interrupt endpoint's job on both platforms.
 *   - F-keys / PageUp / Home / End — the Windows console-input token set has no
 *     word for them, and an unknown token there is silently TYPED as literal
 *     text (measured: `S-Enter` became the string "S-Enter"). A key we cannot
 *     honor on BOTH platforms does not belong in a cross-platform vocabulary.
 */
export const CC_NAV_KEYS: Readonly<Record<string, { tmux: string; wt: string }>> = {
  Enter: { tmux: 'Enter', wt: 'ENTER' },
  Escape: { tmux: 'Escape', wt: 'ESC' },
  Up: { tmux: 'Up', wt: 'UP' },
  Down: { tmux: 'Down', wt: 'DOWN' },
  Left: { tmux: 'Left', wt: 'LEFT' },
  Right: { tmux: 'Right', wt: 'RIGHT' },
  Tab: { tmux: 'Tab', wt: 'TAB' },
  Space: { tmux: 'Space', wt: 'SPACE' },
};

/** Validate + split a caller `keys` array against CC_NAV_KEYS. Throws on any
 *  unknown key (naming a bad key must fail loudly, never be typed as text). */
export function assertNavKeys(keys: unknown): string[] {
  if (!Array.isArray(keys)) throw new Error('keys must be an array of key names');
  if (keys.length === 0) throw new Error('keys array must not be empty');
  if (keys.length > 32) throw new Error('keys array exceeds 32 keys per call');
  return keys.map((k, i) => {
    if (typeof k !== 'string' || !(k in CC_NAV_KEYS)) {
      throw new Error(
        `keys[${i}] ${JSON.stringify(k)} is not a navigation key; allowed: ${Object.keys(CC_NAV_KEYS).join(', ')} ` +
        `(Ctrl-C is the interrupt endpoint; type text via \`text\`)`,
      );
    }
    return k;
  });
}

// ---------------------------------------------------------------------------
// Generic terminal backend
// ---------------------------------------------------------------------------

/** A generic terminal/session reference. `id` is the backend's native handle. */
export interface TerminalRef {
  /** opaque id — tmux session name (Linux) | terminal-hosted pid as string (Windows) */
  id: string;
  /** human title (tmux session name / window text / console title) */
  title?: string;
  /** backend kind that produced this ref */
  backend: 'tmux' | 'wt';
  [k: string]: unknown;
}

export interface CaptureOut {
  text: string;
}

export interface SendKeysOpts {
  /** the keystrokes/text to send */
  keys: string;
  /** press Enter after (default depends on caller) */
  enter?: boolean;
  /** send keys literally (vs interpreting key names) — tmux semantics; wt always literal-ish */
  literal?: boolean;
}

export interface CreateOpts {
  cwd?: string;
  /** the command to run in the new terminal */
  command: string;
  /** 'window' | 'tab' (wt) — ignored by tmux which always makes a session */
  mode?: string;
  /** optional explicit name (tmux); ignored by wt */
  name?: string;
}

/** Generic terminal driver — the platform multiplexer/host. */
export interface TerminalBackend {
  readonly id: 'tmux' | 'wt';
  /** true when this backend can run on the current host. */
  available(): boolean;
  /** list the terminals this backend can observe. */
  list(): Promise<TerminalRef[]>;
  /** launch a command in a new terminal; returns its ref. */
  create(opts: CreateOpts): Promise<TerminalRef>;
  /** read the visible screen text of terminal `id`. */
  capture(id: string): Promise<CaptureOut>;
  /** send keystrokes/text to terminal `id`. */
  sendKeys(id: string, opts: SendKeysOpts): Promise<void>;
  /** terminate / close terminal `id`. */
  close(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Claude Code controller (keyed by Claude sessionId on both platforms)
// ---------------------------------------------------------------------------

export interface CcSessionInfo {
  sessionId: string;
  driveable: boolean;
  /** backend-specific mapping detail (tmux pane / windows tab) */
  [k: string]: unknown;
}

export interface CcScreen {
  /** raw visible terminal text */
  text: string;
  /** classified state, when the backend supports it (Windows classifier) */
  state?: string;
  detail?: string;
  options?: string[];
  retryHint?: string;
}

export interface CcLaunchOpts {
  cwd?: string;
  mode?: string;
  resume?: string;
  waitMs?: number;
  autoTrust?: boolean;
  skipPermissions?: boolean;
  /** Optional: bypassPermissions | acceptEdits | plan | dontAsk | default (bypassPermissions ≡ skipPermissions). */
  permissionMode?: string;
  remoteControl?: boolean | string;
  /** Optional: --model. */
  model?: string;
  /** Optional: reasoning effort passed as --effort (low|medium|high|xhigh|max). Invalid ⇒ dropped. */
  effort?: string;
  /** Optional: path to a file passed as --append-system-prompt-file (controller bootstrap). */
  appendSystemPromptFile?: string;
  /** Optional: path to an MCP config JSON passed as --mcp-config (controller bootstrap). */
  mcpConfigPath?: string;
  /** Optional: display name passed as -n (session title — picker / terminal / account list). */
  name?: string;
  /** Optional: after the TUI is ready, run `/rename <renameTo>` so the session gets a
   *  proper customTitle (the -n flag sets the account/terminal title but NOT the local
   *  customTitle the sessions UI shows). Best-effort; a failure never fails the launch. */
  renameTo?: string;
  /** Optional tmux session-name prefix (default 'lmcc'). Executors MUST use a non-lmcc
   *  prefix ('lmx') — the controller stray-sweep kills every lmcc-* that isn't the
   *  recorded controller, so an lmcc-named executor gets murdered on the next tick. */
  tmuxPrefix?: string;
}

export interface CcAutoHandleOut {
  ok: boolean;
  sessionId?: string;
  pid?: number;
  state?: string;
  handled?: boolean;
  action?: string;
  detail?: string;
  options?: string[];
  retryHint?: string;
  error?: string;
}

/** Claude Code session controller — sessionId-keyed, same surface both OS. */
export interface CcController {
  readonly backend: 'tmux' | 'wt';
  available(): boolean;
  /** list live Claude sessions on this host (with backend window/pane mapping). */
  list(): Promise<CcSessionInfo[]>;
  /** ownership verdict for a sessionId (safe-to-resume etc.). */
  verdict(sessionId: string): Verdict;
  /** launch a new Claude session; returns the launch result (incl. new sessionId). */
  launch(opts: CcLaunchOpts): Promise<Record<string, unknown>>;
  /** send a prompt to a session: `text` (typed/pasted), then any `keys`
   *  (navigation/dialog keys from CC_NAV_KEYS), then Enter if `submit`. Any
   *  subset may be empty — keys-only is how you press Escape / arrows without
   *  typing (there is no other cross-platform way to reach a menu or dialog). */
  prompt(sessionId: string, text: string, opts?: { submit?: boolean; keys?: string[] }): Promise<Record<string, unknown>>;
  /** read + (where supported) classify the session's screen. */
  screen(sessionId: string): Promise<CcScreen>;
  /** detect screen state and advance the actionable ones (trust / numbered answer). */
  autoHandle(sessionId: string, opts: { trust?: boolean; answer?: number }): Promise<CcAutoHandleOut>;
  /** send Ctrl-C to the session. */
  interrupt(sessionId: string): Promise<void>;
  /** terminate the session (optionally close its tab/window). */
  close(sessionId: string, opts?: { closeTab?: boolean }): Promise<Record<string, unknown>>;
  /**
   * Optional: kill a live session and resume its transcript in a fresh terminal.
   * Optional because tmux hosts already have the ccr_restart path; a backend that
   * does not implement it reports NOT_SUPPORTED rather than pretending.
   */
  restart?(sessionId: string, opts?: { force?: boolean }): Promise<Record<string, unknown>>;
  /**
   * Optional: accept a terminal handle another component already holds for this
   * session (e.g. the mission supervisor's controller record after a Core restart).
   * Windows keeps the tab RuntimeId it needs to drive a busy session; tmux needs nothing.
   */
  rememberTerminal?(sessionId: string, handle: string): void;
}

// ---------------------------------------------------------------------------
// Registry — one place that picks the platform backend.
// ---------------------------------------------------------------------------

/** Backend id for the current host. */
export function activeBackendId(): 'tmux' | 'wt' {
  return IS_WINDOWS ? 'wt' : 'tmux';
}

let _terminal: TerminalBackend | null = null;
let _cc: CcController | null = null;

/** The generic terminal backend for this host (tmux on Linux, wt on Windows). */
export function getTerminalBackend(): TerminalBackend {
  if (_terminal) return _terminal;
  // Lazy require to keep platform modules out of each other's load path.
  /* eslint-disable @typescript-eslint/no-require-imports */
  _terminal = IS_WINDOWS
    ? (require('./wt-backend').wtTerminalBackend as TerminalBackend)
    : (require('./tmux-backend').tmuxTerminalBackend as TerminalBackend);
  return _terminal;
}

/**
 * One neutral handle for a launched Claude session's terminal.
 *
 * The two backends describe the same thing differently: tmux by session NAME
 * (`tmuxSession`), Windows Terminal by tab RuntimeId (`tabRid`, title-independent so a
 * still-animating title cannot break drive), falling back to the process id when concurrent
 * launches make the new tab ambiguous. Callers above this layer must not have to know which
 * one they got — a field literally called `tmuxSession` is unfillable on Windows, and that
 * is how the mission layer ended up POSIX-only (bl_ee6b080c).
 *
 * Pure. Returns `terminal: ''` when nothing registered, rather than inventing a handle.
 */
export function normalizeLaunchResult(res: Record<string, unknown>): { sessionId: string | null; terminal: string } {
  const sessionId = (res.sessionId as string | null) ?? null;
  const handle = res.tmuxSession ?? res.tabRid ?? res.pid ?? '';
  return { sessionId, terminal: handle === null || handle === undefined ? '' : String(handle) };
}

/** The Claude Code controller for this host. */
export function getCcController(): CcController {
  if (_cc) return _cc;
  /* eslint-disable @typescript-eslint/no-require-imports */
  _cc = IS_WINDOWS
    ? (require('./wt-backend').wtCcController as CcController)
    : (require('./tmux-backend').tmuxCcController as CcController);
  return _cc;
}
