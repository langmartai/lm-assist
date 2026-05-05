/**
 * Annotation Pipeline — shared types
 *
 * Rationale for the dual schema:
 *   Compact is what the LLM emits (short keys, codes, omitted defaults). 44%
 *   smaller on disk and ~50% cheaper in output tokens than full.
 *   Full is what downstream stages read. Expander converts on ingest.
 *
 * All files live next to the session JSONL:
 *   <sid>.jsonl                       (existing session)
 *   <sid>.annotations.compact.jsonl   (annotator output; append-only)
 *   <sid>.index.json                  (consolidated for matcher)
 */

export type Role =
  | 'user-brief'
  | 'decision'
  | 'state-change'
  | 'reference'
  | 'reasoning'
  | 'tool-output'
  | 'imperative';

export type Stickyness = 'low' | 'medium' | 'high';

/** Full expanded annotation — downstream stages read this. */
export interface Annotation {
  uuid: string;
  topics: string[];
  entities: string[];
  role: Role;
  summary: string;
  referenced_uuids: string[];
  state_impact: string;
  stickyness: Stickyness;
  /**
   * Tool turns only. True = keep the raw tool_use/tool_result content in
   * curated sessions (the summary doesn't preserve enough of the value).
   * Default false → builder replaces the pair with a text turn from summary.
   */
  keep_raw: boolean;
}

/** Compact wire format (what the LLM emits). */
export interface CompactAnnotation {
  u: string;                     // uuid (full)
  t: string[];                   // topics
  r?: string;                    // role code: use|dec|sta|ref|rea|tol|imp
  s?: string;                    // summary
  e?: string[];                  // entities (omit if empty)
  k?: string;                    // stickyness: h|m (omit for l)
  i?: string;                    // state_impact (omit for 'none')
  ref?: string[];                // referenced_uuids (omit if empty)
  kr?: string;                   // keep_raw: "1" if true (omit for false / non-tool)
}

/** Consolidated index passed to matcher. Small — fits in one Haiku prompt. */
export interface SessionIndex {
  sessionId: string;
  lastIndexed: string;
  turn_count: number;
  topic_clusters: Record<string, {
    uuids: string[];
    turns_summary: string[];
    turn_count: number;
  }>;
  /** first user turn uuid + all imperative-role uuids; intentionally narrow */
  sticky_high: string[];
  imperatives: Array<{ uuid: string; summary: string }>;
  recent_3: string[];
  entity_map: Record<string, string[]>;
  referenced_by: Record<string, string[]>;
}

export interface MatchResult {
  relevant_topics: string[];
  include_recent: boolean;
  rationale: string;
  timing_ms?: number;
  cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

export interface BuildResult {
  newSessionId: string;
  file: string;
  lineCount: number;
  originalLines: number;
  reduction: string;           // e.g. "83%"
  matchTopics: string[];
  keptUuidsCount: number;
  /** Tool-pair processing stats (omitted when strategy='keep-all'). */
  tool_stats?: { kept_raw: number; summarized: number; dropped: number };
}

export interface AnnotatorJobStatus {
  id: string;
  sessionId: string;
  projectPath: string;
  scope: 'delta' | 'full';
  model: string;
  chunkSize: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  progress?: {
    chunksTotal: number;
    chunksCompleted: number;
    annotationsWritten: number;
  };
  result?: {
    annotated: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    runtimeMs: number;
    strategiesUsed: { isolated: number; forked: number };
  };
}

/** Options for a single BUILD invocation. */
export interface BuildOptions {
  /** Override the generated synthetic context-stub line. */
  skipContextStub?: boolean;
  /** Optional hard cap on curated line count. Sticky stub + first-user are
   *  protected; cap fills remaining slots with most-recent kept turns. */
  maxLines?: number;
  /**
   * Per-turn tool retention strategy:
   *   - 'per-annotation' (default): respect each annotation's keep_raw flag
   *   - 'keep-all': preserve full tool_use/tool_result pairs verbatim
   *   - 'summarize-all': replace every pair with a text turn from annotation.summary
   *   - 'drop-all': drop tool turns entirely (caller knows context is irrelevant)
   */
  tool_strategy?: 'per-annotation' | 'keep-all' | 'summarize-all' | 'drop-all';
}

/** Strategy for the annotator's per-chunk SDK call. */
export type AnnotateStrategy =
  /** Pick per-chunk: forked if main session's prompt cache likely hot; isolated else. */
  | 'auto'
  /** Always isolate — fresh stateless Haiku call. Cheapest input. No fork. */
  | 'isolated'
  /** Always fork from the main session. Best when cache is hot. */
  | 'forked';

/** Options for annotation. */
export interface AnnotateOptions {
  scope?: 'delta' | 'full';
  model?: string;
  chunkSize?: number;
  concurrency?: number;
  strategy?: AnnotateStrategy;
}

/** Project dir encoding helper contract. */
export interface ProjectPaths {
  sessionFile: string;
  compactAnnotationsFile: string;
  indexFile: string;
}
