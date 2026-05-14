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

export interface CCSessionState {
  phase: CCPhase;
  /** Best-effort model name parsed from TUI footer; null if not visible. */
  model: string | null;
  /** Last screen capture used to derive the phase, kept for diff-based waits. */
  lastSnapshot: { text: string; capturedAt: number } | null;
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
