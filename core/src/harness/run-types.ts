/**
 * Harness run records — the durable, per-run history of every qwen/opencode (and
 * future pluggable) execution, foreground or background.
 *
 * Mirrored verbatim in web/src/lib/harness-runs.ts. Change both or neither.
 */
import type { HarnessCapabilities } from './types';
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
