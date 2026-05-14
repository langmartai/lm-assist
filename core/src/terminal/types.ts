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
 * Validated send-keys input.
 *
 * paneQualifier is a pane-within-session selector like "0.1" — NOT a session
 * name. The session is always taken from the URL :name; the body cannot
 * override it. (See validate.ts for the regex.)
 */
export interface SendKeysInput {
  keys: string;
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

export interface CCLaunchInput {
  cwd: string;
  model: string | null;
  /** Extra flags MERGED with the default (--dangerously-skip-permissions). */
  extraFlags: string[];
  /** Set false to NOT pass --dangerously-skip-permissions. Default true. */
  skipPermissions: boolean;
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
}

export interface CCPromptInput {
  text: string;
  /** Reject if multi-line; CC's Enter submits, splitting the prompt. */
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
