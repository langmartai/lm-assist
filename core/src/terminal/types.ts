/**
 * Terminal domain types.
 *
 * Models the controlled systems (tmux session, Claude Code session) as stateful
 * entities, not name strings. Every wrapper that mutates state asserts the
 * precondition (current state allows this op) and verifies the postcondition
 * (the state actually transitioned).
 */

export type TabKind = 'gnome' | 'wt-ssh' | 'tmux';

/** Live state of a tmux session, derived by tmux query, not assumed. */
export interface TmuxSessionState {
  exists: boolean;
  windows: number;
  attached: boolean;
  /** PID of the program running in the session's first pane (null if no pane). */
  panePid: number | null;
  /** Command of the program running in the first pane (e.g. 'bash', 'claude'). */
  paneCommand: string | null;
}

/** A single window inside a tmux session (tmux's native multiplexing unit). */
export interface TmuxWindowState {
  /** Numeric index within the session (tmux's default identifier). */
  index: number;
  /** User-facing name. Defaults to the program name (e.g. "bash"). */
  name: string;
  /** Whether this is the active window in the session. */
  active: boolean;
  /** Command of the program in the window's first pane. */
  paneCommand: string | null;
  /** PID of that program. */
  panePid: number | null;
}

/**
 * Phase of a Claude Code session inside a tmux session.
 *
 * Transitions:
 *   unknown      → first inspection
 *   launching    → process spawned, TUI not yet drawn
 *   trust-prompt → CC asking "trust this folder?" (pre-idle, blocks ctx:)
 *   idle         → CC at ❯ prompt, ready for input
 *   busy         → CC processing (tool calls, streaming response)
 *   plan-mode    → CC in plan mode (different exit conditions)
 *   permission   → CC asking for permission (file edit, bash exec, MCP)
 *   dead         → no claude process in pane
 */
export type CCPhase =
  | 'unknown'
  | 'launching'
  | 'trust-prompt'
  | 'idle'
  | 'busy'
  | 'plan-mode'
  | 'permission'
  | 'dead';

/** Interaction mode of the CC TUI. */
export type CCMode = 'normal' | 'plan' | 'bash' | 'unknown';

/** What dialog (if any) CC is currently asking about. */
export type CCDialog = 'trust' | 'permission' | 'compact' | 'choice' | null;

/** Auth state, derived from ~/.claude.json oauthAccount field (primary) or screen text (fallback). */
export type CCAuthState = 'authenticated' | 'unauthenticated' | 'unknown';

export interface CCSessionState {
  phase: CCPhase;
  /** Best-effort model name parsed from TUI footer; null if not visible. */
  model: string | null;
  /** Last screen capture used to derive the phase, kept for diff-based waits. */
  lastSnapshot: { text: string; capturedAt: number } | null;
  /** Current interaction mode (plan/bash/normal). */
  currentMode: CCMode;
  /** Active dialog awaiting an answer, or null. */
  pendingDialog: CCDialog;
  /** Auth state of the CC binary as a whole (not per-session — CC is single-user). */
  authState: CCAuthState;
  /** Context usage 0–100 from `ctx: NN%` footer; null if not parseable. */
  contextPct: number | null;
  /** Email of the authenticated user, if any (from ~/.claude.json). */
  authEmail: string | null;
  /**
   * Claude Code conversation UUID (parsed from the TUI footer's `sid:`
   * field). Matches the sessionId the SDK returns and what `/resume`
   * accepts. Null if CC hasn't drawn its footer yet.
   */
  sessionId: string | null;
}

export interface SlashCommandInput {
  /** The command WITHOUT leading slash, e.g. 'clear', 'agents', 'export'. */
  cmd: string;
  /** Optional space-separated args, sent literally. */
  args: string | null;
}

export interface SelectChoiceInput {
  /** 1–9. CC's numbered menus accept the digit as a hotkey. */
  n: number;
}

export interface AwaitIdleInput {
  timeoutMs: number;
  pollMs: number;
}

export interface CreateWindowInput {
  /** Working directory for the new window's shell. */
  cwd: string | null;
  /** Command to run in the new window. Goes via tmux send-keys after create. */
  command: string | null;
  /** Optional human-readable name (tmux -n). */
  name: string | null;
}

/** Persisted tab record. Stored in registry, written atomically. */
export interface TabRecord {
  id: string;
  kind: TabKind;
  title: string | null;
  tmuxSession: string | null;
  sshTarget: string | null;
  command: string | null;
  cwd: string | null;
  createdAt: string;
  meta: Record<string, unknown>;
}

/**
 * Named-key allowlist for the `keyNames` / REST keys-ARRAY form.
 *
 * Every entry is a key name tmux itself resolves (verified against tmux 3.2a —
 * an unrecognized name is silently sent as LITERAL TEXT, so nothing may be in
 * this set on faith). Deliberately EXCLUDED: C-c (SIGINT — that is the
 * admin-gated interrupt path's job), C-d (EOF: exits the pane's shell) and
 * C-z (suspends the foreground app, wedging the pane).
 */
export const NAMED_KEYS: ReadonlySet<string> = new Set([
  'Enter', 'Escape', 'Tab', 'BTab', 'Space', 'BSpace', 'Delete', 'Insert',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  'M-Enter', // CC composer: insert a newline without submitting
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i))
    .filter((c) => c !== 'c' && c !== 'd' && c !== 'z')
    .map((c) => `C-${c}`),
]);

/**
 * Validated send-keys input.
 *
 * paneQualifier is a pane-within-session selector like "0.1" — NOT a session
 * name. The session is always taken from the URL :name; the body cannot
 * override it. (See validate.ts for the regex.)
 */
export interface SendKeysInput {
  /** Legacy single string: literal text when `literal`, else one tmux key
   *  name (an unrecognized name falls back to literal text — tmux behavior). */
  keys?: string | null;
  /** Literal text, delivered byte-exactly. Multiline becomes ONE paste
   *  (bracketed when the app opted in) instead of line-by-line submits. */
  text?: string | null;
  /** Named keys from NAMED_KEYS, pressed after `text`. Never literal. */
  keyNames?: string[];
  literal: boolean;
  enter: boolean;
  paneQualifier: string | null;
}

export interface WaitForInput {
  pattern: string;
  literal: boolean;
  flags: string;
  timeoutMs: number;
  pollMs: number;
  paneQualifier: string | null;
  /** Number of lines to capture per poll; null = full visible pane. */
  lines: number | null;
}

export interface CaptureInput {
  paneQualifier: string | null;
  /** Number of lines from bottom of buffer; null = full visible pane. */
  lines: number | null;
  /** Negative number reaches into scrollback (tmux -S). null = visible only. */
  start: number | null;
}

/**
 * Reasoning-effort levels the `claude` CLI accepts for `--effort`.
 *
 * Kept as a closed set on purpose: the CLI treats an UNKNOWN value as a warning and
 * silently falls back to its default ("Unknown --effort value 'x' — ignoring it"), so an
 * unvalidated pass-through would read as "effort applied" while the session actually ran
 * at default. Verified against `claude --help` + a live probe, 2026-07-26.
 */
export const CC_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type CCEffort = (typeof CC_EFFORT_LEVELS)[number];

export interface CCLaunchInput {
  cwd: string;
  model: string | null;
  /** Extra flags MERGED with the default (--dangerously-skip-permissions). */
  extraFlags: string[];
  /** Set false to NOT pass --dangerously-skip-permissions. Default true. */
  skipPermissions: boolean;
  /** Pass --remote-control to enable remote-control mode. Default false. */
  remoteControl?: boolean;
  /** Reasoning effort (`--effort`). Omitted ⇒ the CLI's own default. Invalid ⇒ dropped. */
  effort?: string;
  cols: number;
  rows: number;
  /** Indicator pattern for "ready" — default 'ctx:'. */
  readyPattern: string;
  /** Cap on time waiting for ready. */
  readyTimeoutMs: number;
  /**
   * Auto-answer the workspace trust prompt if it appears before ready.
   * Default true (mirrors --dangerously-skip-permissions semantics).
   */
  autoAcceptTrust: boolean;
  /** Optional: path to a file passed as --append-system-prompt-file (controller bootstrap). */
  appendSystemPromptFile?: string;
  /** Optional: path to an MCP config JSON passed as --mcp-config (controller bootstrap). */
  mcpConfigPath?: string;
  /** Optional: display name passed as -n (session title — picker / terminal / account list). */
  name?: string;
}

export interface CCPromptInput {
  text: string;
  /** Reject if multi-line unless set. When allowed, multiline text is
   *  delivered as ONE bracketed paste (inserted, not submitted per line). */
  allowNewlines: boolean;
}

export interface CCPivotInput {
  newSessionId: string;
  prompt: string;
  promptPattern: string;
  timeoutMs: number;
}

/**
 * Window-group label for gnome tabs. All tabs created with the same
 * `windowGroup` value land in the same gnome-terminal window (so the user
 * gets a tab-stripe view instead of N separate floating windows).
 *
 * Mechanism: window title is prefixed with `<windowGroup>: ` so the OS
 * window manager can identify it. Before each spawn we activate any
 * existing window whose title starts with the prefix; gnome-terminal's
 * `--tab` then attaches to that activated window.
 */
export type WindowGroup = string;
