/**
 * Harness transcript types — one normalized event stream for every recorded
 * harness run, whatever the source: the captured stdout of qwen/opencode, qwen's
 * own chat JSONL, or a readonly read of OpenCode's SQLite DB.
 *
 * Mirrored in web/src/lib/harness-runs.ts. Change both or neither.
 *
 * A tool call is ONE event carrying both its input and its output: OpenCode
 * stores it that way, and qwen's functionCall/functionResponse pair is joined by
 * id before it reaches here. Tool names stay NATIVE (write_file, bash, …); the
 * web layer canonicalizes them for display.
 */

export type HarnessEventKind = 'user' | 'reasoning' | 'text' | 'tool' | 'turn' | 'api_error' | 'lifecycle';
interface EvBase { seq: number; kind: HarnessEventKind; at?: number /* epoch ms */; turn?: number }
export interface UserEvent extends EvBase { kind: 'user'; text: string; truncated?: boolean }
export interface ReasoningEvent extends EvBase { kind: 'reasoning'; text: string; durationMs?: number; truncated?: boolean }
export interface TextEvent extends EvBase { kind: 'text'; text: string; final?: boolean; truncated?: boolean }
export interface ToolEvent extends EvBase {
  kind: 'tool'; callId?: string;
  name: string;                  // NATIVE name (write_file, read_file, edit, run_shell_command | write, read, bash, glob…)
  status: 'pending' | 'running' | 'completed' | 'error' | 'unknown'; nativeStatus?: string;
  input?: unknown;               // oversize => { _truncated: true, preview: string, originalBytes: number }
  output?: string; error?: string; title?: string;
  startedAt?: number; endedAt?: number; durationMs?: number;
  diff?: { file?: string; patch: string; added?: number; removed?: number };
  truncated?: boolean;
}
export interface TurnEvent extends EvBase { kind: 'turn'; model?: string; finish?: string; latencyMs?: number;
  usage?: { input: number; output: number; reasoning?: number; cacheRead?: number; cacheWrite?: number } }
export interface ApiErrorEvent extends EvBase { kind: 'api_error'; errorType?: string; statusCode?: number; message: string; retryable?: boolean; durationMs?: number }
export interface LifecycleEvent extends EvBase { kind: 'lifecycle'; phase: 'session' | 'killed_step' | 'shutdown' | 'capture_truncated'; detail?: string }
export type HarnessEvent = UserEvent | ReasoningEvent | TextEvent | ToolEvent | TurnEvent | ApiErrorEvent | LifecycleEvent;

export type TranscriptSource = 'captured' | 'qwen-chat' | 'opencode-db' | 'none';
export type NativeUnavailableReason = 'NO_CHAT_FILE' | 'NO_SESSION_ID' | 'SQLITE_UNAVAILABLE' | 'OPENCODE_DB_MISSING'
  | 'OPENCODE_DB_BUSY' | 'UNSUPPORTED_SCHEMA' | 'SESSION_NOT_FOUND' | 'NOT_APPLICABLE' | 'TOO_LARGE';
export interface TranscriptSources {
  captured: { available: boolean; bytes?: number; truncated?: boolean };
  native: { kind: 'qwen-chat' | 'opencode-db' | null; available: boolean; reason?: NativeUnavailableReason };
}
export interface TranscriptSourceRef {        // built by core-runtime; paths ABSOLUTE and already validated
  runner: string; runDir: string | null; capturePath: string | null; promptPath: string | null;
  sessionId: string | null; opencodeDbPath: string | null; live: boolean; startedAt: number;
}
export interface TranscriptResult {
  source: TranscriptSource; sources: TranscriptSources; version: string;
  events: HarnessEvent[]; total: number; offset: number; nextOffset: number | null; truncated: boolean;
  filesTouched: string[]; cliVersion?: string; title?: string; model?: string; warnings: string[];
}
/** Tool counts are ABSENT (unknown) when no transcript source could be read — never 0 for "could not tell". */
export interface RunEnrichment { toolCalls?: number; toolErrors?: number; toolsByName?: Record<string, number>;
  filesTouched: string[]; reasoningTokens: number | null; cliVersion?: string; model?: string; sessionId?: string }
export interface LegacyUsage { input: number; output: number; reasoning: number | null; cacheRead: number; total: number; reported: boolean }
export interface LegacyQwenRun { sessionId: string | null; cwd: string | null; model: string | null; cliVersion: string | null;
  startedAt: number | null; endedAt: number | null; status: 'succeeded' | 'failed' | 'aborted' | 'not_started' | 'unknown';
  error?: string; numTurns: number; toolCalls: number; usage: LegacyUsage; resultPreview?: string; promptPreview?: string; promptChars?: number; filesTouched: string[] }
export interface LegacyOpencodeSession { sessionId: string; directory: string | null; title: string | null; version: string | null;
  model: string | null; startedAt: number; endedAt: number | null; status: 'succeeded' | 'failed' | 'aborted' | 'unknown';
  error?: string; numTurns: number; toolCalls: number; usage: LegacyUsage; promptPreview?: string; promptChars?: number }
