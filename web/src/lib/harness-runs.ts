/**
 * Pure helpers for the /harness page (Harness Runs spec §7.8): the wire types of the
 * /harness/runs* and /harness/runners routes, mirrored from core, plus IO-free
 * formatting, grouping, tool-name canonicalization and transcript shaping.
 * vitest-covered in __tests__/harness-runs.test.ts.
 *
 * The type block below mirrors core/src/harness/run-types.ts and
 * core/src/harness/transcript/types.ts. Change both or neither.
 */

import { formatSummary, summarizeToolCall } from './tool-summary';

// ─── Mirrored from core/src/harness/types.ts ──────────────────────────────────

export type CostFidelity = 'reported' | 'computed' | 'unavailable';

export interface HarnessCapabilities {
  cost: CostFidelity;
  sessionResume: boolean;
  mcp: boolean;
  permissionBroker: boolean;
  durableBackground: boolean;
  usesProviderProfile: boolean;
  abortable: boolean;
}

export interface HarnessProbe { available: boolean; version?: string; reason?: string; binary?: string }

// ─── Mirrored from core/src/harness/run-types.ts (§2.1) ───────────────────────

export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/; // executionId == run-dir basename; no . / \ : NUL
export const RUN_LIMITS = {
  promptPreviewChars: 300, rowPromptChars: 200, promptFileChars: 65536,
  resultPreviewChars: 2000, errorChars: 2000, errorPreviewChars: 200,
  captureMaxBytes: 8 * 1024 * 1024, captureLineMaxBytes: 1024 * 1024,
  filesTouchedMax: 50, toolsByNameMax: 30,
  listDefault: 50, listMax: 200,
  retentionDays: 30, retentionMaxRuns: 500, indexCompactBytes: 2 * 1024 * 1024,
} as const;

export type HarnessRunStatus =
  | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'aborted'
  | 'refused'        // config_error before spawn, or recorder refusal
  | 'launch_failed'  // child 'error' or synchronous spawn throw
  | 'interrupted'    // owning Core died mid-run (child may be orphaned)
  | 'not_started'    // backfill only: qwen dir with debug log but no chat file
  | 'unknown';       // backfill only: could not infer
export type HarnessTermination = 'exit' | 'timeout' | 'launch_error' | 'config_error' | 'spawn_throw' | 'core_restart';

export interface HarnessRunUsage {
  inputTokens: number; outputTokens: number;       // AS REPORTED by the harness response (opencode output already includes reasoning)
  reasoningTokens: number | null;                   // from enrichment; null = not reported
  cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number;
  reported: boolean;                                // false => zeros mean UNKNOWN (UI shows "—")
}

export interface HarnessRunRecord {
  v: 1;
  id: string;                    // === executionId for recorded runs and qwen backfill; 'oc-<ses_id>' for opencode backfill
  executionId: string | null;    // null for opencode backfill (the DB has no execId)
  runner: string;                // 'qwen' | 'opencode' | future pluggable id
  origin: 'recorded' | 'backfill';
  inferred: boolean;             // true for backfill
  core: 'dev' | 'prod' | 'unknown';
  corePid: number | null;
  coreStartTicks?: number;       // /proc/self/stat field 22 (Linux) at record time
  status: HarnessRunStatus;      // persisted; 'running' until settle. Served value is DERIVED (§3.4)
  termination?: HarnessTermination;
  background: boolean | null;
  promptPreview: string;         // <=300, redacted, trimmed
  promptChars: number;
  cwd: string | null;            // RESOLVED: request.cwd || process.cwd() (opencode: the --dir value)
  cwdDefaulted: boolean;         // caller omitted cwd => ran in Core's own cwd
  model: string | null;          // resolved (request.model || profile.model)
  providerProfile: string | null;// profile NAME only
  baseUrlHost: string | null;    // new URL(baseUrl).host only
  timeoutMs: number | null;
  maxTurns: number | null;
  maxTurnsEnforced: boolean | null; // qwen true, opencode false
  startedAt: number; spawnedAt?: number; firstOutputAt?: number; endedAt?: number; durationMs?: number;
  pid?: number; exitCode?: number | null; signal?: string | null; abortRequestedAt?: number;
  sessionId?: string;            // qwen chat uuid | opencode ses_* (sniffed early from stdout)
  cliVersion?: string;
  numTurns?: number; toolCalls?: number; toolErrors?: number;
  toolsByName?: Record<string, number>; // NATIVE names, <=30 entries
  usage?: HarnessRunUsage;
  costUsd: null;                 // capability cost='unavailable' => never 0
  resultPreview?: string;        // <=2000, redacted
  error?: string;                // <=2000, redacted
  filesTouched?: string[];       // <=50 absolute paths
  runDir: string | null;         // RELATIVE to getDataDir(): 'harness-runs-dev/<id>' | legacy 'harness-runs/<id>'; null for opencode backfill
  capture?: { bytes: number; lines: number; truncated: boolean };
  native?: { kind: 'qwen-chat' | 'opencode-db'; dbPath?: string }; // dbPath absolute, NEVER served
  updatedAt: number;
}

export type RunIndexLine =
  | { op: 'start'; at: number; rec: HarnessRunRecord }
  | { op: 'patch'; at: number; id: string; patch: Partial<HarnessRunRecord> }
  | { op: 'meta'; at: number; backfill: { qwen: number; opencode: number; warnings: string[] } };

export interface HarnessRunRow {
  id: string; executionId: string | null; runner: string; runnerDisplayName: string;
  origin: 'recorded' | 'backfill'; inferred: boolean;
  status: HarnessRunStatus; termination?: HarnessTermination; background: boolean | null;
  startedAt: number; endedAt?: number; durationMs?: number;
  promptPreview: string; cwd: string | null; cwdDefaulted: boolean;
  model: string | null; providerProfile: string | null; sessionId?: string;
  numTurns?: number; toolCalls?: number; toolErrors?: number; usage?: HarnessRunUsage;
  errorPreview?: string; live: boolean; hasTranscript: boolean;
}

export interface HarnessRunnerSummary {
  id: string; displayName: string; pluggable: boolean;
  recorded: boolean;                  // false for sdk/tmux
  capabilities: HarnessCapabilities;
  maxTurnsEnforced: boolean | null;   // static: qwen true, opencode false, builtins null
  isolation: string | null;           // qwen 'QWEN_HOME per run'; opencode 'shares ~/.config/opencode and ~/.local/share/opencode with the operator'
  profile: { name: string; model: string; baseUrlHost: string; hasKey: boolean } | null; // default profile via describeProviderConfig()
  note?: string;                      // sdk/tmux: 'Claude runner — its runs are Claude Code sessions (see /sessions)'
  stats: null | {
    windowDays: number; total: number; running: number;
    byStatus: Partial<Record<HarnessRunStatus, number>>;
    successRate: number | null;       // succeeded / (succeeded+failed+timed_out+aborted+launch_failed+interrupted); null if 0
    p50DurationMs: number | null; p95DurationMs: number | null;
    lastRunAt: number | null; lastStatus?: HarnessRunStatus;
    tokens: { input: number; output: number; reasoning: number; reportedRuns: number };
    toolCalls: number; toolErrors: number;
    topTools: Array<{ name: string; count: number }>;    // top 8, native names
    models: Array<{ model: string; count: number }>;
    profiles: Array<{ name: string; count: number }>;
    recentFailures: Array<{ id: string; at: number; status: HarnessRunStatus; error: string }>; // last 5, 160 chars
  };
}

// ─── Mirrored from core/src/harness/transcript/types.ts (§2.2) ────────────────

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

// ─── Route payloads (§5) ──────────────────────────────────────────────────────

export interface HarnessRunsCounts {
  shown: number; matched: number; total: number; running: number;
  byRunner: Record<string, number>;
  byStatus: Partial<Record<HarnessRunStatus, number>>;
}

/** GET /harness/runs */
export interface HarnessRunsListResponse {
  core: 'dev' | 'prod';
  runs: HarnessRunRow[]; // startedAt desc
  counts: HarnessRunsCounts;
  nextOffset: number | null;
  backfill: { done: boolean; at?: number; qwen: number; opencode: number; warnings?: string[] };
}

/** GET /harness/runners */
export interface HarnessRunnersResponse {
  generatedAt: number; windowDays: number; core: 'dev' | 'prod'; runners: HarnessRunnerSummary[];
}

/** GET /harness/runs/:id */
export interface HarnessRunDetail {
  run: Omit<HarnessRunRecord, 'native'> & { native?: { kind: 'qwen-chat' | 'opencode-db' } };
  status: HarnessRunStatus; // derived
  live: boolean;
  abortable: boolean;       // live && runner capability abortable && origin==='recorded'
  childAlive?: boolean | 'unknown'; // interrupted only
  sources: TranscriptSources;
}

/** GET /harness/runs/:id/transcript */
export interface HarnessTranscriptPage {
  id: string; runner: string; source: TranscriptSource; sources: TranscriptSources; version: string;
  unchanged?: true; // only when ifVersion===version; then events=[]
  events: HarnessEvent[]; total: number; offset: number; nextOffset: number | null; truncated: boolean;
  live: boolean; runStatus: HarnessRunStatus; filesTouched: string[];
  cliVersion?: string; title?: string; model?: string; warnings: string[];
}

/** GET /harness/runs/:id/debug (qwen only) */
export interface HarnessDebugTail { available: boolean; reason?: string; lines: string[]; totalLines: number; truncated: boolean }

/** The subset of GET /harness/status this page reads. Never polled: it shells out to every probe (~1.6 s). */
export interface HarnessStatusResponse {
  harnesses: Array<{ id: string; displayName?: string | null; capabilities: HarnessCapabilities; pluggable?: boolean; probe: HarnessProbe | null }>;
  providers: { defaultProfile?: string; profiles: Array<{ name: string; baseUrl: string; model: string; hasKey: boolean; note?: string }> };
  ready?: boolean;
  envFallback?: string;
}

/** One item of GET /agent/executions (the in-memory background map; lost on a Core restart). */
export interface AgentExecutionItem {
  executionId: string; sessionId?: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  isRunning: boolean; startedAt: string | number; endedAt?: string | number;
  runner?: string; cwd?: string; claudeSessionUrl?: string;
}

// ─── Status + runner labels ───────────────────────────────────────────────────

export const HARNESS_RUN_STATUSES: readonly HarnessRunStatus[] = [
  'running', 'succeeded', 'failed', 'timed_out', 'aborted',
  'refused', 'launch_failed', 'interrupted', 'not_started', 'unknown',
];

export interface StatusMeta { label: string; colorVar: string; pulse: boolean }

const STATUS_META: Record<HarnessRunStatus, StatusMeta> = {
  running: { label: 'running', colorVar: 'var(--color-status-blue)', pulse: true },
  succeeded: { label: 'succeeded', colorVar: 'var(--color-status-green)', pulse: false },
  failed: { label: 'failed', colorVar: 'var(--color-status-red)', pulse: false },
  launch_failed: { label: 'launch failed', colorVar: 'var(--color-status-red)', pulse: false },
  timed_out: { label: 'timed out', colorVar: 'var(--color-status-orange)', pulse: false },
  aborted: { label: 'aborted', colorVar: 'var(--color-status-yellow)', pulse: false },
  interrupted: { label: 'interrupted', colorVar: 'var(--color-status-purple)', pulse: false },
  refused: { label: 'refused', colorVar: 'var(--color-text-tertiary)', pulse: false },
  not_started: { label: 'not started', colorVar: 'var(--color-text-tertiary)', pulse: false },
  unknown: { label: 'unknown', colorVar: 'var(--color-text-tertiary)', pulse: false },
};

/** Dot/badge colour + label for a run status. A status this build does not know renders as
 *  'unknown' (a newer Core may add one) rather than borrowing another status's colour. */
export function statusMeta(status: string | null | undefined): StatusMeta {
  return STATUS_META[status as HarnessRunStatus] ?? { ...STATUS_META.unknown, label: status ? String(status) : 'unknown' };
}

const RUNNER_FALLBACK_NAMES: Record<string, string> = {
  qwen: 'Qwen Code', opencode: 'OpenCode', sdk: 'Claude SDK', tmux: 'Claude tmux',
};

/** Display name for a runner id. sdk/tmux serve with a null displayName, so fall back by id. */
export function runnerLabel(id: string | null | undefined, displayName?: string | null): string {
  const dn = (displayName || '').trim();
  if (dn) return dn;
  if (!id) return 'unknown';
  return RUNNER_FALLBACK_NAMES[id] ?? id;
}

/** Claude runners (sdk/tmux, or an item with no runner at all) — their runs are Claude Code sessions. */
export function isClaudeRunner(id: string | null | undefined): boolean {
  return !id || id === 'sdk' || id === 'tmux';
}

// ─── Tool-name canonicalization ───────────────────────────────────────────────

/**
 * Native harness tool names → the Claude names tool-summary.ts / smart-display.ts switch on.
 * qwen uses Gemini-style snake_case, OpenCode lowercase; the two sets do not collide on a
 * name that means different things, so one table serves both runners.
 */
const TOOL_NAME_MAP: Record<string, string> = {
  // qwen
  read_file: 'Read', write_file: 'Write', edit: 'Edit', replace: 'Edit',
  run_shell_command: 'Bash', grep_search: 'Grep', search_file_content: 'Grep',
  glob: 'Glob', list_directory: 'LS', web_fetch: 'WebFetch', web_search: 'WebSearch',
  todo_write: 'TodoWrite',
  // opencode
  read: 'Read', write: 'Write', patch: 'Edit', bash: 'Bash', grep: 'Grep',
  list: 'LS', webfetch: 'WebFetch', todowrite: 'TodoWrite', task: 'Task',
};

const INPUT_KEY_ALIASES: Array<[string[], string]> = [
  [['filePath', 'absolute_path', 'path'], 'file_path'],
  [['oldString'], 'old_string'],
  [['newString'], 'new_string'],
];

/**
 * Canonical {name, input} for display. Unknown names pass through. Input keys gain their
 * Claude alias (filePath → file_path, …) ALONGSIDE the originals, and the caller's object is
 * never mutated: the same event feeds the raw Input view, which must show what the harness sent.
 */
export function canonicalTool(name: string, input?: unknown): { name: string; input: unknown } {
  const canonName = TOOL_NAME_MAP[name] ?? name;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { name: canonName, input };
  const src = input as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const [from, to] of INPUT_KEY_ALIASES) {
    if (src[to] !== undefined) continue;
    const hit = from.find((k) => src[k] !== undefined);
    if (hit === undefined) continue;
    out = out ?? { ...src };
    out[to] = src[hit];
  }
  return { name: canonName, input: out ?? src };
}

function isTruncatedInput(input: unknown): boolean {
  return !!input && typeof input === 'object' && (input as { _truncated?: unknown })._truncated === true;
}

/** One-line tool label via the shared summarizer ("Created hello.txt +1 -0", "Ran npm test"). */
export function toolSummaryLabel(ev: Pick<ToolEvent, 'name' | 'input' | 'title'>): string {
  const c = canonicalTool(ev.name, ev.input);
  // A server-truncated input has no file_path/command left to summarize.
  if (isTruncatedInput(ev.input)) return `${c.name} (input truncated)${ev.title ? ` · ${ev.title}` : ''}`;
  return formatSummary(summarizeToolCall(c.name, c.input));
}

// ─── Transcript → TranscriptMessage ───────────────────────────────────────────

export interface HarnessChatToolCall { name: string; input?: unknown; result?: string; isError?: boolean }
export interface HarnessChatMessage {
  role: 'user' | 'assistant'; type: 'user' | 'assistant'; text: string;
  thinking?: string; toolCalls?: HarnessChatToolCall[];
}

function apiErrorLine(ev: ApiErrorEvent): string {
  const head = [ev.statusCode, ev.errorType].filter((x) => x !== undefined && x !== '').join(' ');
  return `**API error**${head ? ` ${head}` : ''}: ${ev.message}`;
}

/**
 * The shape components/shared/TranscriptMessage renders. Everything the harness produced
 * between two user events is ONE assistant message: reasoning joins into `thinking`, text
 * and API errors into `text`, tools into canonicalized `toolCalls`. Turn and lifecycle
 * events carry no conversational content and are dropped here (the Timeline shows them).
 */
export function eventsToMessages(events: HarnessEvent[]): HarnessChatMessage[] {
  const out: HarnessChatMessage[] = [];
  let thinking: string[] = [];
  let text: string[] = [];
  let tools: HarnessChatToolCall[] = [];
  const flush = () => {
    if (thinking.length || text.length || tools.length) {
      const m: HarnessChatMessage = { role: 'assistant', type: 'assistant', text: text.join('\n\n') };
      if (thinking.length) m.thinking = thinking.join('\n\n');
      if (tools.length) m.toolCalls = tools;
      out.push(m);
    }
    thinking = []; text = []; tools = [];
  };
  for (const ev of events) {
    switch (ev.kind) {
      case 'user':
        flush();
        out.push({ role: 'user', type: 'user', text: ev.text });
        break;
      case 'reasoning':
        if (ev.text) thinking.push(ev.text);
        break;
      case 'text':
        if (ev.text) text.push(ev.text);
        break;
      case 'api_error':
        text.push(apiErrorLine(ev));
        break;
      case 'tool': {
        const c = canonicalTool(ev.name, ev.input);
        tools.push({ name: c.name, input: c.input, result: ev.output ?? ev.error, isError: ev.status === 'error' });
        break;
      }
      default:
        break;
    }
  }
  flush();
  return out;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/** 950 → "950", 16102 → "16.1k", 10000 → "10k", 2_500_000 → "2.5M". */
export function compactNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const trim = (s: string) => s.replace(/\.0$/, '');
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) return `${trim((n / 1000).toFixed(1))}k`;
  return `${trim((n / 1_000_000).toFixed(1))}M`;
}

/** 850 → "850ms", 2500 → "2.5s", 185000 → "3m 5s", 7_500_000 → "2h 5m". Missing → "—". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalS = Math.floor(ms / 1000);
  if (ms < 3_600_000) return `${Math.floor(totalS / 60)}m ${totalS % 60}s`;
  return `${Math.floor(totalS / 3600)}h ${Math.floor((totalS % 3600) / 60)}m`;
}

/** A ticking live timer: "0:07", "12:03", "1:02:09". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * "16.1k in · 120 out · 57 reasoning". Reasoning stays a separate figure: qwen's thoughts
 * can exceed its output count and opencode's output already includes reasoning, so neither
 * sum is honest. `reported:false` means the zeros are unknown, not zero → "—".
 */
export function formatTokens(usage: HarnessRunUsage | null | undefined): string {
  if (!usage || !usage.reported) return '—';
  const parts = [`${compactNumber(usage.inputTokens)} in`, `${compactNumber(usage.outputTokens)} out`];
  if (usage.reasoningTokens != null) parts.push(`${compactNumber(usage.reasoningTokens)} reasoning`);
  return parts.join(' · ');
}

/** Harness cost is capability 'unavailable': a 0 on the wire means UNKNOWN, never free. */
export function formatCost(costUsd?: number | null): string {
  if (typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd > 0) return `$${costUsd.toFixed(4)}`;
  return 'unavailable';
}

/** Offset of an event from the run start: "+00:03.2", "+1:02:03". */
export function offsetLabel(at: number | null | undefined, startedAt: number | null | undefined): string {
  if (at == null || startedAt == null || !Number.isFinite(at) || !Number.isFinite(startedAt)) return '';
  const d = at - startedAt;
  const sign = d < 0 ? '-' : '+';
  const abs = Math.abs(d);
  const tenths = Math.floor((abs % 1000) / 100);
  const s = Math.floor(abs / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  if (h > 0) return `${sign}${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${sign}${String(m).padStart(2, '0')}:${ss}.${tenths}`;
}

export function successRateLabel(stats: Pick<NonNullable<HarnessRunnerSummary['stats']>, 'successRate'> | null | undefined): string {
  if (!stats || stats.successRate == null || !Number.isFinite(stats.successRate)) return '—';
  return `${Math.round(stats.successRate * 100)}%`;
}

/** Poll faster while something is running; a quiet list only needs to notice new runs. */
export function pollIntervalMs(counts: { running?: number } | null | undefined): number {
  return (counts?.running ?? 0) > 0 ? 5000 : 15000;
}

export function firstLine(text: string | null | undefined, max = 160): string {
  const line = String(text || '').trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function normPath(p: string): string {
  const s = String(p || '').replace(/\\/g, '/');
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

export function pathBasename(p: string | null | undefined): string {
  const s = normPath(p || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) || s : s;
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p);
}

/**
 * True when an ABSOLUTE path lies outside cwd. A plain string prefix is wrong: `/a/bc` is not
 * inside `/a/b`. Relative paths are relative to cwd, and with no cwd there is nothing to judge.
 */
export function isOutsideCwd(path: string | null | undefined, cwd: string | null | undefined): boolean {
  if (!path || !cwd) return false;
  const p = normPath(path);
  const c = normPath(cwd);
  if (!isAbsolutePath(p) || c === '/') return false;
  return !(p === c || p.startsWith(`${c}/`));
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

export interface RunDayGroup { key: string; label: string; rows: HarnessRunRow[] }

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Rows (already startedAt desc) grouped by LOCAL day: "Today" / "Yesterday" / a date. */
export function groupRunsByDay(rows: HarnessRunRow[], now: number): RunDayGroup[] {
  const today = localDayKey(now);
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const yesterday = localDayKey(y.getTime());
  const thisYear = new Date(now).getFullYear();
  const groups: RunDayGroup[] = [];
  const byKey = new Map<string, RunDayGroup>();
  for (const r of rows) {
    const key = localDayKey(r.startedAt);
    let g = byKey.get(key);
    if (!g) {
      const d = new Date(r.startedAt);
      const label = key === today ? 'Today'
        : key === yesterday ? 'Yesterday'
        : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() === thisYear ? {} : { year: 'numeric' }) });
      g = { key, label, rows: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.rows.push(r);
  }
  return groups;
}

/** Tabs shown for runners: the pluggable, recorded ones (qwen/opencode today). */
export function recordedRunnerTabs(runners: HarnessRunnerSummary[] | null | undefined): HarnessRunnerSummary[] {
  return (runners ?? []).filter((r) => r.pluggable && r.recorded);
}

export interface StatusSegment { status: HarnessRunStatus; count: number; pct: number }

/** Segments for the stacked status bar, in canonical status order, zero counts dropped. */
export function statusBarSegments(byStatus: Partial<Record<HarnessRunStatus, number>> | null | undefined): StatusSegment[] {
  const entries = HARNESS_RUN_STATUSES.map((s) => ({ status: s, count: Math.max(0, byStatus?.[s] ?? 0) })).filter((e) => e.count > 0);
  const total = entries.reduce((a, e) => a + e.count, 0);
  return entries.map((e) => ({ ...e, pct: total ? (e.count / total) * 100 : 0 }));
}

// ─── Query + deep link ────────────────────────────────────────────────────────

export type SinceOption = '24h' | '7d' | '30d' | 'all';
export const SINCE_OPTIONS: readonly SinceOption[] = ['24h', '7d', '30d', 'all'];

export interface RunsFilters {
  runner?: string | null;
  statuses?: HarnessRunStatus[];
  q?: string;
  since?: SinceOption;
  includeBackfill?: boolean;
  limit?: number;
  offset?: number;
}

/** The runners-summary window that matches a since filter, so the tab stats and the list agree. */
export function sinceToDays(since: SinceOption | undefined): number {
  switch (since) {
    case '24h': return 1;
    case '7d': return 7;
    case 'all': return 365;
    default: return 30;
  }
}

const Q_MAX = 100;

/** Query string for GET /harness/runs ('' when every filter is at its default). */
export function buildRunsQuery(f: RunsFilters): string {
  const p = new URLSearchParams();
  if (f.runner && f.runner !== 'all' && f.runner !== 'claude') p.set('runner', f.runner);
  const statuses = HARNESS_RUN_STATUSES.filter((s) => f.statuses?.includes(s));
  if (statuses.length) p.set('status', statuses.join(','));
  const q = (f.q || '').trim().slice(0, Q_MAX);
  if (q) p.set('q', q);
  if (f.since && f.since !== 'all') p.set('since', f.since);
  if (f.includeBackfill === false) p.set('includeBackfill', '0');
  if (f.limit != null && f.limit !== RUN_LIMITS.listDefault) p.set('limit', String(Math.min(RUN_LIMITS.listMax, Math.max(1, Math.floor(f.limit)))));
  if (f.offset) p.set('offset', String(Math.max(0, Math.floor(f.offset))));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Inverse of buildRunsQuery (unknown statuses and since values are dropped). */
export function parseRunsQuery(search: string): RunsFilters {
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const f: RunsFilters = {};
  const runner = p.get('runner');
  if (runner) f.runner = runner;
  const status = p.get('status');
  if (status) f.statuses = status.split(',').filter((s): s is HarnessRunStatus => (HARNESS_RUN_STATUSES as readonly string[]).includes(s));
  const q = p.get('q');
  if (q) f.q = q;
  const since = p.get('since');
  if (since && (SINCE_OPTIONS as readonly string[]).includes(since)) f.since = since as SinceOption;
  if (p.get('includeBackfill') === '0') f.includeBackfill = false;
  const limit = Number(p.get('limit'));
  if (p.has('limit') && Number.isFinite(limit)) f.limit = limit;
  const offset = Number(p.get('offset'));
  if (p.has('offset') && Number.isFinite(offset)) f.offset = offset;
  return f;
}

export type DetailTab = 'timeline' | 'chat' | 'prompt' | 'files' | 'debug';
export const DETAIL_TABS: readonly DetailTab[] = ['timeline', 'chat', 'prompt', 'files', 'debug'];

/** 'all' | a runner id | 'claude' (the sdk/tmux tab). */
export interface HarnessDeepLink { runner: string; run: string | null; tab: DetailTab }

const RUNNER_TAB_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function parseDeepLink(search: string): HarnessDeepLink {
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const runner = p.get('runner');
  const run = p.get('run');
  const tab = p.get('tab');
  return {
    runner: runner && RUNNER_TAB_RE.test(runner) ? runner : 'all',
    // Same rule the route enforces: anything else is a guaranteed 400, so do not ask.
    run: run && RUN_ID_RE.test(run) ? run : null,
    tab: tab && (DETAIL_TABS as readonly string[]).includes(tab) ? (tab as DetailTab) : 'timeline',
  };
}

/** Search string for the page URL. Defaults are omitted and params this page does not own are kept. */
export function buildDeepLink(link: HarnessDeepLink, currentSearch = ''): string {
  const p = new URLSearchParams(currentSearch.startsWith('?') ? currentSearch.slice(1) : currentSearch);
  for (const k of ['runner', 'run', 'tab']) p.delete(k);
  if (link.runner && link.runner !== 'all') p.set('runner', link.runner);
  if (link.run) p.set('run', link.run);
  if (link.run && link.tab !== 'timeline') p.set('tab', link.tab);
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ─── Transcript paging + timeline ─────────────────────────────────────────────

/**
 * Fold a transcript page into what is on screen, BY POSITION: seq is the event's index in
 * its source and the loaded list starts at 0 with no gaps, so a page replaces exactly the
 * seqs it covers and keeps the rest. A head re-read (offset 0) refreshes in place — a
 * pending tool becomes completed — without dropping what was loaded past it; a tail re-read
 * of a live run appends what is new; a page cut short by the server's size budget no longer
 * shrinks the list. An `unchanged` answer keeps the events but takes the fresh live/status
 * fields, and a page from ANOTHER source replaces everything.
 */
export function mergeTranscript(prev: HarnessTranscriptPage | null, page: HarnessTranscriptPage): HarnessTranscriptPage {
  if (page.unchanged && prev) return { ...prev, live: page.live, runStatus: page.runStatus };
  if (!prev || page.source !== prev.source) return page;
  const firstSeq = page.events.length ? page.events[0].seq : page.offset;
  const lastSeq = page.events.length ? page.events[page.events.length - 1].seq : page.offset - 1;
  const events = [
    ...prev.events.filter((e) => e.seq < firstSeq),
    ...page.events,
    ...prev.events.filter((e) => e.seq > lastSeq),
  ];
  return {
    ...page,
    offset: Math.min(prev.offset, page.offset),
    events,
    nextOffset: events.length < page.total ? events.length : null,
    truncated: prev.truncated || page.truncated,
  };
}

/**
 * Where a live re-read starts: just before the first tool still pending (it is about to be
 * re-normalized in place), and never later than 20 events before the end — the stream
 * parsers only append or mutate the tail, never insert mid-list.
 */
export function liveTailOffset(events: readonly HarnessEvent[]): number {
  const pending = events.find((e) => e.kind === 'tool' && (e.status === 'pending' || e.status === 'running'));
  return Math.max(0, Math.min(pending ? pending.seq : Number.POSITIVE_INFINITY, events.length - 20));
}

/**
 * Tab badges from a list response's `byRunner` FACET (every filter except the runner), which
 * any response carries — narrowed to one runner or not. A runner with no key has 0 matches;
 * the All badge is their sum (== counts.matched on the All tab).
 */
export function tabBadgeCounts(byRunner: Record<string, number> | null | undefined): { all: number; of: (id: string) => number } {
  const m = byRunner ?? {};
  return { all: Object.values(m).reduce((a, n) => a + n, 0), of: (id) => m[id] ?? 0 };
}

export type TimelineFilter = 'tools' | 'reasoning' | 'text' | 'errors' | 'turns';
export const TIMELINE_FILTERS: readonly TimelineFilter[] = ['tools', 'reasoning', 'text', 'errors', 'turns'];

/** An event is shown when ANY enabled chip claims it. Lifecycle markers ride with Turns. */
export function eventMatchesFilters(ev: HarnessEvent, enabled: ReadonlySet<TimelineFilter>): boolean {
  switch (ev.kind) {
    case 'tool': return enabled.has('tools') || (ev.status === 'error' && enabled.has('errors'));
    case 'reasoning': return enabled.has('reasoning');
    case 'text':
    case 'user': return enabled.has('text');
    case 'api_error': return enabled.has('errors');
    case 'turn':
    case 'lifecycle': return enabled.has('turns');
    default: return true;
  }
}

export function eventAt(ev: HarnessEvent): number | undefined {
  if (ev.at != null) return ev.at;
  if (ev.kind === 'tool') return ev.startedAt;
  return undefined;
}

export function eventDurationMs(ev: HarnessEvent): number | undefined {
  switch (ev.kind) {
    case 'tool':
      if (ev.durationMs != null) return ev.durationMs;
      if (ev.startedAt != null && ev.endedAt != null) return Math.max(0, ev.endedAt - ev.startedAt);
      return undefined;
    case 'reasoning': return ev.durationMs;
    case 'turn': return ev.latencyMs;
    case 'api_error': return ev.durationMs;
    default: return undefined;
  }
}

/**
 * Position of an event's duration bar as percentages of the run length. A turn's latency
 * ENDS at its timestamp (it is stamped when the response lands); everything else starts there.
 */
export function barGeometry(ev: HarnessEvent, startedAt: number, spanMs: number): { left: number; width: number } | null {
  const dur = eventDurationMs(ev);
  const at = eventAt(ev);
  if (dur == null || at == null || !(spanMs > 0)) return null;
  const start = ev.kind === 'turn' ? at - dur : at;
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  const left = clamp(((start - startedAt) / spanMs) * 100);
  const width = Math.min(100 - left, Math.max(0.5, (dur / spanMs) * 100));
  return { left, width };
}

/** "Turn 2 · model · 16.1k/120/57 · 2.5s · finish stop" — missing parts are omitted. */
export function turnLabel(ev: TurnEvent): string {
  const parts: string[] = [ev.turn != null ? `Turn ${ev.turn}` : 'Turn'];
  if (ev.model) parts.push(ev.model);
  if (ev.usage) {
    const u = [compactNumber(ev.usage.input), compactNumber(ev.usage.output)];
    if (ev.usage.reasoning != null) u.push(compactNumber(ev.usage.reasoning));
    parts.push(u.join('/'));
  }
  if (ev.latencyMs != null) parts.push(formatDuration(ev.latencyMs));
  if (ev.finish) parts.push(`finish ${ev.finish}`);
  return parts.join(' · ');
}

export function lifecycleLabel(ev: LifecycleEvent): string {
  switch (ev.phase) {
    case 'session': return `Session ${ev.detail ?? ''}`.trim();
    case 'killed_step': return 'Step ended without a finish (killed)';
    case 'shutdown': return 'Shutdown';
    case 'capture_truncated': return 'Capture truncated here (line over 1 MB, or the 8 MB capture cap)';
    default: return String((ev as { phase?: string }).phase ?? 'lifecycle');
  }
}

// ─── Empty/degraded transcript states (§7.7) ──────────────────────────────────

/** Operator-facing text for why the native transcript cannot be read. null = nothing to say. */
export function nativeReasonText(reason: NativeUnavailableReason | undefined, cliVersion?: string): string | null {
  switch (reason) {
    case 'SQLITE_UNAVAILABLE': return 'better-sqlite3 has no binding on this node (npm rebuild better-sqlite3) — showing captured stream';
    case 'UNSUPPORTED_SCHEMA': return `OpenCode ${cliVersion ?? ''} stores transcripts in a format this build does not read`.replace(/\s+/g, ' ');
    case 'SESSION_NOT_FOUND': return 'the session was deleted from OpenCode';
    case 'NO_SESSION_ID': return 'waiting for first output…';
    case 'NO_CHAT_FILE': return 'qwen wrote no chat transcript for this run';
    case 'OPENCODE_DB_MISSING': return "OpenCode's local database was not found on this node";
    case 'OPENCODE_DB_BUSY': return "OpenCode's database was busy — try again";
    case 'TOO_LARGE': return 'the native transcript is too large to read in full';
    default: return null;
  }
}

export interface TranscriptNotice { tone: 'info' | 'warn'; text: string }

/** The banner above a transcript: why nothing (or only the capture) is shown. */
export function transcriptNotice(
  t: Pick<HarnessTranscriptPage, 'source' | 'sources' | 'runStatus' | 'cliVersion'> | null,
  runner: string,
): TranscriptNotice | null {
  if (!t) return null;
  const reason = t.sources?.native?.available ? undefined : t.sources?.native?.reason;
  if (t.source === 'none') {
    if (runner === 'qwen' && t.runStatus === 'not_started') {
      return { tone: 'info', text: 'qwen started but never received the prompt — no chat transcript was written (see the Debug tab)' };
    }
    return { tone: reason === 'NO_SESSION_ID' ? 'info' : 'warn', text: nativeReasonText(reason, t.cliVersion) ?? 'Nothing readable was recorded for this run' };
  }
  if (t.source === 'captured' && reason && reason !== 'NOT_APPLICABLE') {
    const text = nativeReasonText(reason, t.cliVersion);
    return text ? { tone: 'info', text } : null;
  }
  return null;
}

// ─── Files tab ────────────────────────────────────────────────────────────────

export type FileOp = 'created' | 'edited' | 'read' | 'touched';
export interface RunFile { path: string; ops: FileOp[]; outsideCwd: boolean }

function resolveAgainst(cwd: string | null | undefined, p: string): string {
  const n = normPath(p);
  if (isAbsolutePath(n) || !cwd) return n;
  return `${normPath(cwd)}/${n.replace(/^\.\//, '')}`;
}

/**
 * filesTouched (what the harness reported writing) unioned with the paths its tool calls
 * named, deduped, each flagged when it lies outside cwd — opencode was measured writing
 * /tmp/hello.txt from a run whose cwd was elsewhere.
 */
export function collectRunFiles(filesTouched: string[] | null | undefined, events: HarnessEvent[], cwd: string | null | undefined): RunFile[] {
  const byPath = new Map<string, RunFile>();
  const add = (raw: unknown, op: FileOp) => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    const path = resolveAgainst(cwd, raw.trim());
    let f = byPath.get(path);
    if (!f) {
      f = { path, ops: [], outsideCwd: isOutsideCwd(path, cwd) };
      byPath.set(path, f);
    }
    if (!f.ops.includes(op)) f.ops.push(op);
  };
  for (const ev of events) {
    if (ev.kind !== 'tool') continue;
    const c = canonicalTool(ev.name, ev.input);
    const fp = (c.input && typeof c.input === 'object') ? (c.input as Record<string, unknown>).file_path : undefined;
    // A write or edit that FAILED changed nothing ('oldString not found', permission denied).
    if (ev.status === 'error' && (c.name === 'Write' || c.name === 'Edit' || c.name === 'MultiEdit')) continue;
    if (c.name === 'Write') add(fp ?? ev.diff?.file, 'created');
    else if (c.name === 'Edit' || c.name === 'MultiEdit') add(fp ?? ev.diff?.file, 'edited');
    else if (c.name === 'Read') add(fp, 'read');
  }
  for (const p of filesTouched ?? []) {
    const path = resolveAgainst(cwd, p);
    if (!byPath.has(path)) add(p, 'touched');
  }
  // Writes first: those are what an operator is checking this tab for.
  const rank = (f: RunFile) => (f.ops.some((o) => o !== 'read') ? 0 : 1);
  return [...byPath.values()].sort((a, b) => rank(a) - rank(b));
}

/**
 * Lines of a unified patch with their kind, for the coloured diff view.
 *
 * Header tests (---, +++, Index:, ===, diff) apply only OUTSIDE a hunk: inside one, a removed
 * `-- comment` line reads `--- comment` and an added `++i;` reads `+++i;`, and both are
 * content. Each `@@ -a,b +c,d @@` header says how many old/new lines it owns, so the header
 * of a following file in a multi-file patch is still meta.
 */
export function diffLines(patch: string): Array<{ kind: 'add' | 'del' | 'hunk' | 'meta' | 'ctx'; text: string }> {
  let oldLeft = 0;
  let newLeft = 0;
  return String(patch || '').split('\n').map((text) => {
    const h = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(text);
    if (h) {
      oldLeft = h[1] === undefined ? 1 : Number(h[1]);
      newLeft = h[2] === undefined ? 1 : Number(h[2]);
      return { kind: 'hunk' as const, text };
    }
    if (oldLeft > 0 || newLeft > 0) {
      if (text.startsWith('+')) { newLeft--; return { kind: 'add' as const, text }; }
      if (text.startsWith('-')) { oldLeft--; return { kind: 'del' as const, text }; }
      if (text.startsWith('\\')) return { kind: 'meta' as const, text }; // "\ No newline at end of file"
      oldLeft--; newLeft--;
      return { kind: 'ctx' as const, text };
    }
    if (/^(\+\+\+|---|Index:|===|diff )/.test(text)) return { kind: 'meta' as const, text };
    if (text.startsWith('@@')) return { kind: 'hunk' as const, text };
    if (text.startsWith('+')) return { kind: 'add' as const, text };
    if (text.startsWith('-')) return { kind: 'del' as const, text };
    return { kind: 'ctx' as const, text };
  });
}
