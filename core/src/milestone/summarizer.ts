import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Milestone, MilestoneType } from './types';
import { getMilestoneStore } from './store';
import { getVectraStore } from '../vector/vectra-store';
import { getMilestoneSettings, type Phase2Model } from './settings';

const PIPELINE_STATUS_FILE = path.join(os.homedir(), '.tier-agent', 'milestones', 'pipeline-status.json');

// ── Token Budget ──────────────────────────────────────────
// 200k context = system (~500) + input + output
// Input budget: generous, leave room for output
const MAX_INPUT_TOKENS = 150_000;
// Output budget per milestone: ~300 tokens (title, description, type, outcome, facts, concepts)
const OUTPUT_TOKENS_PER_MILESTONE = 300;
// Max output tokens to request from the API
const MAX_OUTPUT_TOKENS = 32_000;
// Practical batch limit: LLM reliability degrades beyond ~50 items even with token budget remaining.
const MAX_BATCH_SIZE = 50;
// Truncate individual user prompts to keep milestones compact
const MAX_PROMPT_CHARS = 400;
// Truncate file lists
const MAX_FILES = 20;
// Default API base URL
const DEFAULT_API_BASE_URL = 'http://localhost:3100';
// Default request timeout (3 minutes)
const DEFAULT_TIMEOUT = 180_000;

export interface PipelineStatus {
  status: 'idle' | 'processing' | 'stopping' | 'unavailable';
  queueSize: number;
  processed: number;
  errors: number;
  lastProcessedAt: string | null;
  startedAt: string | null;
  currentBatch: {
    batchNumber: number;
    milestoneCount: number;
    sessionIds: string[];
    startedAt: string;
  } | null;
  throughput: {
    milestonesPerMinute: number;
    batchesCompleted: number;
  } | null;
  vectorsIndexed: number;
  vectorErrors: number;
  mergesApplied: number;
  milestonesAbsorbed: number;
  currentModel: string | null;
}

interface SummaryResult {
  title: string;
  description: string;
  type: MilestoneType;
  outcome: string;
  facts: string[];
  concepts: string[];
  architectureRelevant: boolean;
  mergedFrom?: string[];
}

type QueueItem = { sessionId: string; milestoneIndex: number; projectPath?: string };

const SYSTEM_PROMPT = `You produce searchable milestone summaries for future semantic retrieval. Your output is indexed for vector search — every field must maximize findability.

Output ONLY valid JSON, no markdown, no explanation. When given multiple work units, output a JSON array.

## Type Definitions
- discovery: learned how something works, found root cause, investigated behavior
- implementation: built new feature, added capability, created component
- bugfix: fixed broken behavior, resolved error, corrected regression
- refactor: restructured code without changing behavior, improved architecture
- decision: chose between approaches, evaluated trade-offs, set direction
- configuration: changed settings, environment, dependencies, CI/CD, tooling

## Concept Vocabulary (use ONLY these)
how-it-works | what-changed | problem-solution | gotcha | pattern | trade-off | configuration

## Field Rules
- title: imperative, max 10 words (GOOD: "Fix tmux scrollback overflow on session reconnect" BAD: "Fixed an issue with tmux")
- description: one sentence, max 24 words, explain significance not just what happened
- outcome: what the system NOW DOES differently as a result — a concrete behavioral change
- facts: 3-8 self-contained statements. No pronouns ("it", "the system"). Include specifics: filenames, function names, values, paths, error messages. GOOD: "detectBoundaries() assigns strength 10 to user prompts in extractor.ts" BAD: "Updated the boundary detection"
- concepts: 2-5 from the vocabulary above, no free-form terms

## Examples

GOOD fact: "sessionCache.ts reads JSONL files with byte-offset seeking for incremental parsing"
GOOD fact: "MAX_BATCH_SIZE constant changed from 20 to 50 in summarizer.ts"
GOOD fact: "Race condition in WebSocket reconnect caused duplicate hub registrations"

BAD fact: "Code was updated"
BAD fact: "Session analysis completed"
BAD fact: "The system was improved"

## Architecture Relevance (architectureRelevant)
Set to true ONLY when the milestone changes the system's architecture — its services, connections, data stores, or deployment topology. This field controls whether an expensive architecture model regeneration is triggered.

TRUE when:
- New route file, controller, or API endpoint group added
- New service, worker, proxy, or microservice created
- Database migration or schema change (new table, altered column, new index)
- Docker/compose/infrastructure config changed (new container, port mapping, volume)
- New external service integration (cache, queue, third-party API)
- MCP server/tool added or restructured
- .env changes that add new service connections or ports
- Package.json dependency changes that introduce new frameworks (e.g., adding Redis, adding GraphQL)

FALSE when:
- Bug fixes within existing code paths
- UI/CSS/styling changes
- Documentation or comment updates
- Refactoring that preserves behavior and structure
- Test additions or modifications
- Minor config tweaks (log levels, timeouts, feature flags)
- Code within existing route handlers (logic changes, not structural)`;

export class MilestoneSummarizer {
  private queue: QueueItem[] = [];
  private processing = false;
  private stopped = false;
  private rateLimit = { rpm: 60, current: 0, resetTime: 0 };
  private onPhase2Complete?: (milestone: Milestone, projectPath?: string) => Promise<void>;
  private apiBaseUrl: string;
  private timeout: number;
  private batchNumber = 0;
  private batchesCompleted = 0;
  private vectorsIndexed = 0;
  private vectorErrors = 0;
  private pipelineStartedAt: number = 0;
  private concurrency = 10;
  private mergesApplied = 0;
  private milestonesAbsorbed = 0;
  private modelOverride: Phase2Model | null = null;
  private architectureUpdateProjects = new Set<string>();
  /** Debounce timer for enqueueMilestones auto-start */
  private enqueueDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Delay before auto-starting processQueue (allows milestones to accumulate) */
  private enqueueDebounceMs = 5_000;
  /** Callback fired when ALL processing is truly done (queue empty, no pending debounce) */
  private onPipelineComplete?: (projects: string[]) => Promise<void>;

  constructor(apiBaseUrl?: string, timeout?: number) {
    this.apiBaseUrl = apiBaseUrl || DEFAULT_API_BASE_URL;
    this.timeout = timeout || DEFAULT_TIMEOUT;
  }

  /**
   * Get the current model for Phase 2 enrichment.
   * Priority: runtime override > settings file > default ('haiku')
   */
  private getModel(): Phase2Model {
    if (this.modelOverride) return this.modelOverride;
    return getMilestoneSettings().phase2Model;
  }

  /**
   * Override the model for the current processing run.
   * Cleared when processing completes. Invalid values are ignored.
   */
  setModel(model: string): void {
    if (model === 'haiku' || model === 'sonnet' || model === 'opus') {
      this.modelOverride = model;
    }
  }

  /**
   * Set callback for post-Phase-2 processing (e.g. Vectra embedding)
   */
  setOnPhase2Complete(cb: (milestone: Milestone, projectPath?: string) => Promise<void>): void {
    this.onPhase2Complete = cb;
  }

  /**
   * Set callback fired when ALL Phase 2 processing is truly done.
   * "Done" means: processQueue finished, queue is empty, no debounce timer pending, not stopped.
   * Receives the list of projects that had architecture-relevant milestones (auto-cleared).
   * This ensures architecture updates only trigger once after mass catch-up completes.
   */
  setOnPipelineComplete(cb: (projects: string[]) => Promise<void>): void {
    this.onPipelineComplete = cb;
  }

  /**
   * Set number of concurrent batches to process in parallel.
   * Default is 1 (sequential). Higher values send multiple API calls simultaneously.
   */
  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.min(n, 20));
  }

  /**
   * Get and clear the set of projects that had architecture-relevant milestones.
   * Called after pipeline completes to trigger delta architecture updates.
   */
  getAndClearArchitectureUpdateProjects(): string[] {
    const projects = [...this.architectureUpdateProjects];
    this.architectureUpdateProjects.clear();
    return projects;
  }

  /**
   * Stop processing after current batch completes.
   * Already-processed milestones are saved to disk and preserved.
   */
  stop(): { stopped: boolean; remaining: number } {
    // Clear any pending debounce timer (prevents auto-start after stop)
    if (this.enqueueDebounceTimer) {
      clearTimeout(this.enqueueDebounceTimer);
      this.enqueueDebounceTimer = null;
    }
    if (!this.processing) {
      return { stopped: false, remaining: 0 };
    }
    this.stopped = true;
    return { stopped: true, remaining: this.queue.length };
  }

  isProcessing(): boolean {
    return this.processing;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Check if a milestone has enough content to warrant an API call for summarization.
   * Milestones with no meaningful work (no files, no tools, trivial prompts) are auto-promoted.
   */
  private isMilestoneSubstantive(m: Milestone): boolean {
    const hasFilesModified = m.filesModified.length > 0;
    const hasFilesRead = m.filesRead.length > 0;
    const toolCount = Object.values(m.toolUseSummary).reduce((sum, v) => sum + v, 0);
    const hasTools = toolCount > 1; // More than 1 tool call
    const hasTasks = m.taskCompletions.length > 0;
    const hasSubagents = m.subagentCount > 0;
    const promptChars = m.userPrompts.reduce((sum, p) => sum + p.length, 0);
    const hasSubstantivePrompts = promptChars > 50 && m.userPrompts.length > 0;
    const multiTurn = m.endTurn - m.startTurn >= 2;

    // Early exit: truly empty milestones — no files, no tools, no prompts, no subagents
    // (SDK warmup, brief confirmations, abandoned sessions)
    if (!hasFilesModified && !hasFilesRead && !hasTools && !hasSubagents && promptChars <= 20) return false;

    // Substantive if has file modifications, meaningful tool use, real tasks, or subagents
    return hasFilesModified || hasTasks || hasSubagents ||
           (hasFilesRead && hasTools) ||  // Research/exploration (reading + grep/search)
           (hasFilesRead && hasSubstantivePrompts) ||
           (hasTools && hasSubstantivePrompts) ||
           (multiTurn && hasSubstantivePrompts);
  }

  /**
   * Try to merge a thin milestone into an adjacent non-"Minimal" milestone.
   * Prefers the preceding milestone, falls back to the next one.
   * Returns true if merged (thin milestone was absorbed and removed).
   */
  private tryMergeIntoAdjacent(m: Milestone, allMilestones: Milestone[], store: ReturnType<typeof getMilestoneStore>): boolean {
    const idx = allMilestones.findIndex(ms => ms.index === m.index);
    if (idx === -1) return false;

    // Use the live version from allMilestones (not the stale input `m`)
    // — prior cascade merges in the same session may have updated it
    const source = allMilestones[idx];

    // Find adjacent candidate: prefer previous, then next.
    // Only merge into Phase 1 neighbors (not yet enriched) to avoid destroying good
    // Phase 2 enrichment. The LLM batch merge logic handles Phase 2 merging later.
    const candidates = [idx - 1, idx + 1]
      .filter(i => i >= 0 && i < allMilestones.length)
      .map(i => allMilestones[i])
      .filter(ms => ms.phase === 1);

    if (candidates.length === 0) return false;

    const neighbor = candidates[0];

    // Absorb thin milestone data into neighbor
    neighbor.startTurn = Math.min(neighbor.startTurn, source.startTurn);
    neighbor.endTurn = Math.max(neighbor.endTurn, source.endTurn);
    if (new Date(source.startTimestamp) < new Date(neighbor.startTimestamp)) {
      neighbor.startTimestamp = source.startTimestamp;
    }
    if (new Date(source.endTimestamp) > new Date(neighbor.endTimestamp)) {
      neighbor.endTimestamp = source.endTimestamp;
    }
    // Merge user prompts (deduplicate)
    const existingPrompts = new Set(neighbor.userPrompts);
    for (const p of source.userPrompts) {
      if (!existingPrompts.has(p)) neighbor.userPrompts.push(p);
    }
    // Merge files (deduplicate)
    const existingModified = new Set(neighbor.filesModified);
    for (const f of source.filesModified) {
      if (!existingModified.has(f)) neighbor.filesModified.push(f);
    }
    const existingRead = new Set(neighbor.filesRead);
    for (const f of source.filesRead) {
      if (!existingRead.has(f)) neighbor.filesRead.push(f);
    }
    // Merge tool use summary
    for (const [tool, count] of Object.entries(source.toolUseSummary)) {
      neighbor.toolUseSummary[tool] = (neighbor.toolUseSummary[tool] || 0) + count;
    }
    // Merge task completions
    const existingTasks = new Set(neighbor.taskCompletions);
    for (const t of source.taskCompletions) {
      if (!existingTasks.has(t)) neighbor.taskCompletions.push(t);
    }
    neighbor.subagentCount += source.subagentCount;

    // Remove the thin milestone and resequence
    allMilestones.splice(idx, 1);
    for (let i = 0; i < allMilestones.length; i++) {
      allMilestones[i].index = i;
      allMilestones[i].id = `${source.sessionId}:${i}`;
    }

    store.saveMilestones(source.sessionId, allMilestones);
    const p1 = allMilestones.filter(ms => ms.phase === 1).length;
    const p2 = allMilestones.filter(ms => ms.phase === 2).length;
    store.updateIndex(source.sessionId, p1 === 0 ? 2 : 1, allMilestones.length, p1, p2);

    return true;
  }

  /**
   * Handle a thin milestone: merge into an adjacent Phase 1 milestone, or delete it.
   * Returns 'merged' if absorbed into a neighbor, 'deleted' if removed, 'not_found' if already gone.
   */
  private handleThinMilestone(m: Milestone, allMilestones: Milestone[], store: ReturnType<typeof getMilestoneStore>): 'merged' | 'deleted' | 'not_found' {
    // Try to merge into an adjacent Phase 1 milestone first
    if (this.tryMergeIntoAdjacent(m, allMilestones, store)) {
      return 'merged';
    }

    // No suitable neighbor — delete it. Thin milestones without a merge target
    // are not worth keeping in the index (no meaningful search value).
    const targetIdx = allMilestones.findIndex(ms => ms.index === m.index);
    if (targetIdx === -1) return 'not_found';

    const sessionId = allMilestones[targetIdx].sessionId;
    allMilestones.splice(targetIdx, 1);

    // Resequence
    for (let i = 0; i < allMilestones.length; i++) {
      allMilestones[i].index = i;
      allMilestones[i].id = `${sessionId}:${i}`;
    }

    store.saveMilestones(sessionId, allMilestones);
    // saveMilestones handles empty array cleanup (file + index removal)
    if (allMilestones.length > 0) {
      const p1 = allMilestones.filter(ms => ms.phase === 1).length;
      const p2 = allMilestones.filter(ms => ms.phase === 2).length;
      store.updateIndex(sessionId, p1 === 0 ? 2 : 1, allMilestones.length, p1, p2);
    }
    return 'deleted';
  }

  /**
   * Add phase-1 milestones to the queue without triggering processing.
   * Use this when bulk-loading milestones, then call processQueue() explicitly.
   * Thin milestones (no files, no tools, trivial content) are merged into adjacent
   * milestones or auto-promoted to phase 2 with a placeholder.
   */
  addToQueue(milestones: Milestone[], projectPath?: string): number {
    const store = getMilestoneStore();
    let added = 0;
    let merged = 0;
    let deleted = 0;

    // Group milestones by session so we can handle merges safely
    const bySession = new Map<string, Milestone[]>();
    for (const m of milestones) {
      if (m.phase !== 1) continue;
      const arr = bySession.get(m.sessionId) || [];
      arr.push(m);
      bySession.set(m.sessionId, arr);
    }

    for (const [sessionId, sessionMilestones] of bySession) {
      // Classify: substantive vs thin
      const substantive: Milestone[] = [];
      const thin: Milestone[] = [];
      for (const m of sessionMilestones) {
        if (this.isMilestoneSubstantive(m)) {
          substantive.push(m);
        } else {
          thin.push(m);
        }
      }

      // Queue substantive milestones first
      for (const m of substantive) {
        this.queue.push({ sessionId: m.sessionId, milestoneIndex: m.index, projectPath });
        added++;
      }

      // Process thin milestones: try merge into adjacent, or delete
      // Process in reverse index order so earlier removals don't invalidate later indices
      thin.sort((a, b) => b.index - a.index);
      for (const m of thin) {
        const allMilestones = store.getMilestones(sessionId);
        const result = this.handleThinMilestone(m, allMilestones, store);
        if (result === 'merged' || result === 'deleted') {
          if (result === 'merged') merged++;
          else deleted++;
          // Resequencing happened — update queued milestone indices for this session
          // Queued entries referencing indices > removed index need to shift down
          for (const entry of this.queue) {
            if (entry.sessionId === sessionId && entry.milestoneIndex > m.index) {
              entry.milestoneIndex--;
            }
          }
        }
      }
    }

    if (deleted > 0 || merged > 0) {
      const parts: string[] = [];
      if (merged > 0) parts.push(`${merged} merged into adjacent`);
      if (deleted > 0) parts.push(`${deleted} deleted`);
      console.error(`[Summarizer] Thin milestones: ${parts.join(', ')}`);
    }
    return added;
  }

  /**
   * Enqueue phase-1 milestones and auto-start processing after a debounce delay.
   * The delay allows milestones from multiple session changes to accumulate before
   * processing starts, enabling proper batch formation instead of one-at-a-time processing.
   *
   * For immediate bulk processing, use addToQueue() + processQueue() instead.
   */
  async enqueueMilestones(milestones: Milestone[], projectPath?: string): Promise<void> {
    this.addToQueue(milestones, projectPath);

    if (this.processing) return; // Already running — while loop will pick up new items

    // Debounce: reset timer on each call so milestones accumulate
    if (this.enqueueDebounceTimer) {
      clearTimeout(this.enqueueDebounceTimer);
    }
    this.enqueueDebounceTimer = setTimeout(() => {
      this.enqueueDebounceTimer = null;
      if (!this.processing && this.queue.length > 0) {
        console.error(`[Summarizer] Auto-starting Phase 2 for ${this.queue.length} queued milestones`);
        this.processQueue().catch(() => {
          // Silently handle - milestones remain at phase 1
        });
      }
    }, this.enqueueDebounceMs);
  }

  async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    this.stopped = false;
    this.batchNumber = 0;
    this.batchesCompleted = 0;
    this.vectorsIndexed = 0;
    this.vectorErrors = 0;
    this.mergesApplied = 0;
    this.milestonesAbsorbed = 0;
    this.pipelineStartedAt = Date.now();

    const initialQueueSize = this.queue.length;
    let processed = 0;
    let errors = 0;

    try {
      console.error(`[Summarizer] Processing ${this.queue.length} milestones for Phase 2 summarization (batched)`);
      const startedAt = new Date().toISOString();
      this.writePipelineStatus(this.buildStatus('processing', initialQueueSize, processed, errors, null, startedAt));

      while (this.queue.length > 0 && !this.stopped) {
        // Take up to `concurrency` batches
        const batches: QueueItem[][] = [];
        for (let i = 0; i < this.concurrency && this.queue.length > 0; i++) {
          const batch = this.takeBatch();
          if (batch.length > 0) batches.push(batch);
        }
        if (batches.length === 0) continue;

        const totalInFlight = batches.reduce((sum, b) => sum + b.length, 0);
        this.batchNumber += batches.length;
        const allSessionIds = [...new Set(batches.flatMap(b => b.map(item => item.sessionId)))];

        this.writePipelineStatus(this.buildStatus('processing', initialQueueSize, processed, errors, new Date().toISOString(), startedAt, {
          batchNumber: this.batchNumber,
          milestoneCount: totalInFlight,
          sessionIds: allSessionIds,
          startedAt: new Date().toISOString(),
        }));

        await this.waitForRateLimit(batches.length);

        // Process batches in parallel
        const results = await Promise.all(batches.map(batch => this.processBatch(batch)));
        for (const result of results) {
          processed += result.processed;
          errors += result.errors;
          this.batchesCompleted++;
        }

        console.error(`[Summarizer] ${batches.length} batches done: ${results.reduce((s, r) => s + r.processed, 0)} processed, ${results.reduce((s, r) => s + r.errors, 0)} errors, ${this.queue.length} remaining`);
        this.writePipelineStatus(this.buildStatus('processing', initialQueueSize, processed, errors, new Date().toISOString(), startedAt));
      }

      if (this.stopped) {
        console.error(`[Summarizer] Stopped by request. ${processed} processed, ${this.queue.length} remaining in queue`);
        this.queue = []; // Clear queue — milestones on disk are still phase 1, re-scannable
        this.writePipelineStatus(this.buildStatus('idle', initialQueueSize, processed, errors, new Date().toISOString(), startedAt));
      } else {
        console.error(`[Summarizer] Phase 2 queue complete: ${processed} processed, ${errors} errors`);
        this.writePipelineStatus(this.buildStatus('idle', initialQueueSize, processed, errors, new Date().toISOString(), startedAt));
      }
    } finally {
      const wasStopped = this.stopped;
      this.processing = false;
      this.stopped = false;
      this.modelOverride = null;

      // If items were added during the final batch (after while loop exited but before
      // processing=false), they'd be orphaned. Schedule a debounced auto-start to pick them up.
      if (this.queue.length > 0 && !this.enqueueDebounceTimer) {
        this.enqueueDebounceTimer = setTimeout(() => {
          this.enqueueDebounceTimer = null;
          if (!this.processing && this.queue.length > 0) {
            console.error(`[Summarizer] Auto-starting Phase 2 for ${this.queue.length} late-arriving milestones`);
            this.processQueue().catch(() => {});
          }
        }, this.enqueueDebounceMs);
      }

      // Fire pipeline-complete callback when truly done:
      // queue empty, no debounce timer pending (no more items expected), not explicitly stopped.
      // This defers architecture updates until all catch-up processing finishes.
      if (this.queue.length === 0 && !this.enqueueDebounceTimer && !wasStopped && this.onPipelineComplete) {
        const projects = this.getAndClearArchitectureUpdateProjects();
        if (projects.length > 0) {
          this.onPipelineComplete(projects).catch(err => {
            console.error('[Summarizer] onPipelineComplete error:', err);
          });
        }
      }
    }
  }

  private buildStatus(
    status: PipelineStatus['status'],
    queueSize: number,
    processed: number,
    errors: number,
    lastProcessedAt: string | null,
    startedAt: string | null,
    currentBatch?: PipelineStatus['currentBatch'],
  ): PipelineStatus {
    const elapsedMinutes = this.pipelineStartedAt > 0 ? (Date.now() - this.pipelineStartedAt) / 60_000 : 0;
    return {
      status,
      queueSize,
      processed,
      errors,
      lastProcessedAt,
      startedAt,
      currentBatch: currentBatch || null,
      throughput: this.batchesCompleted > 0 ? {
        milestonesPerMinute: elapsedMinutes > 0 ? Math.round((processed / elapsedMinutes) * 10) / 10 : 0,
        batchesCompleted: this.batchesCompleted,
      } : null,
      vectorsIndexed: this.vectorsIndexed,
      vectorErrors: this.vectorErrors,
      mergesApplied: this.mergesApplied,
      milestonesAbsorbed: this.milestonesAbsorbed,
      currentModel: this.getModel(),
    };
  }

  // ── Batch Processing ──────────────────────────────────────

  /**
   * Pull items from queue into a batch, respecting token budget.
   * Groups milestones by session so the LLM sees all of a session's milestones
   * together, enabling merge decisions alongside summarization.
   */
  private takeBatch(): QueueItem[] {
    const store = getMilestoneStore();
    let totalInputTokens = 2500; // System prompt (~1800 tokens) + batch framing overhead
    const batch: QueueItem[] = [];

    // Group remaining queue items by sessionId (preserving order of first occurrence)
    const sessionOrder: string[] = [];
    const sessionGroups = new Map<string, number[]>(); // sessionId → queue indices
    for (let i = 0; i < this.queue.length; i++) {
      const sid = this.queue[i].sessionId;
      if (!sessionGroups.has(sid)) {
        sessionGroups.set(sid, []);
        sessionOrder.push(sid);
      }
      sessionGroups.get(sid)!.push(i);
    }

    // Pull entire sessions at a time (all milestones from one session before moving to next)
    const indicesToRemove = new Set<number>();

    for (const sessionId of sessionOrder) {
      if (batch.length >= MAX_BATCH_SIZE) break;

      const indices = sessionGroups.get(sessionId)!;
      const sessionItems: { item: QueueItem; queueIndex: number; tokens: number }[] = [];

      for (const qi of indices) {
        const item = this.queue[qi];
        const milestones = store.getMilestones(item.sessionId);
        const milestone = milestones.find(m => m.index === item.milestoneIndex);

        // Skip already-processed or missing milestones
        if (!milestone || milestone.phase === 2) {
          indicesToRemove.add(qi);
          continue;
        }

        const text = this.formatMilestoneForPrompt(milestone);
        const inputTokens = this.estimateTokens(text);
        sessionItems.push({ item, queueIndex: qi, tokens: inputTokens });
      }

      if (sessionItems.length === 0) continue;

      // Check if the entire session fits within budget
      const sessionTokens = sessionItems.reduce((sum, s) => sum + s.tokens, 0);
      if (totalInputTokens + sessionTokens > MAX_INPUT_TOKENS && batch.length > 0) {
        break; // Don't split a session across batches — stop here
      }
      if (batch.length + sessionItems.length > MAX_BATCH_SIZE && batch.length > 0) {
        break;
      }

      // Add all milestones from this session
      totalInputTokens += sessionTokens;
      for (const si of sessionItems) {
        batch.push(si.item);
        indicesToRemove.add(si.queueIndex);
      }
    }

    // Remove consumed items from queue (in reverse order to preserve indices)
    const sortedIndices = [...indicesToRemove].sort((a, b) => b - a);
    for (const idx of sortedIndices) {
      this.queue.splice(idx, 1);
    }

    return batch;
  }

  /**
   * Process a batch of milestones in a single API call.
   */
  private async processBatch(items: QueueItem[]): Promise<{ processed: number; errors: number }> {
    const store = getMilestoneStore();

    // Load milestone data for each item
    const milestoneData: Array<{
      item: QueueItem;
      milestone: Milestone;
      allMilestones: Milestone[];
    }> = [];

    for (const item of items) {
      const allMilestones = store.getMilestones(item.sessionId);
      const milestone = allMilestones.find(m => m.index === item.milestoneIndex);
      if (milestone && milestone.phase === 1) {
        milestoneData.push({ item, milestone, allMilestones });
      }
    }

    if (milestoneData.length === 0) return { processed: 0, errors: 0 };

    // Single milestone → single-object prompt (simpler, more reliable)
    if (milestoneData.length === 1) {
      const { item, milestone, allMilestones } = milestoneData[0];
      const prompt = this.buildSinglePrompt(milestone);
      const result = await this.callAgentApi(prompt);
      if (!result) return { processed: 0, errors: 1 };

      const parsed = this.parseSingleResponse(result);
      if (!parsed) {
        console.error(`[Summarizer] Parse failed for ${milestone.id}: ${result.slice(0, 200)}`);
        return { processed: 0, errors: 1 };
      }

      await this.applyResult(milestone, parsed, item, allMilestones, store);
      return { processed: 1, errors: 0 };
    }

    // Multiple milestones → batch array prompt
    const prompt = this.buildBatchPrompt(milestoneData.map(d => d.milestone));
    const result = await this.callAgentApi(prompt);

    if (!result) {
      console.error(`[Summarizer] API returned null for batch of ${milestoneData.length}`);
      return { processed: 0, errors: milestoneData.length };
    }

    const summaries = this.parseBatchResponse(result);
    if (!summaries || summaries.size === 0) {
      console.error(`[Summarizer] Batch parse failed (${milestoneData.length} milestones), falling back to individual processing`);
      // Fall back to individual processing in-place (not re-queuing, which causes infinite loops)
      let fbProcessed = 0;
      let fbErrors = 0;
      for (const { item, milestone, allMilestones } of milestoneData) {
        if (this.stopped) break;
        await this.waitForRateLimit();
        const singlePrompt = this.buildSinglePrompt(milestone);
        const singleResult = await this.callAgentApi(singlePrompt);
        if (!singleResult) { fbErrors++; continue; }
        const parsed = this.parseSingleResponse(singleResult);
        if (!parsed) {
          console.error(`[Summarizer] Individual parse also failed for ${milestone.id}: ${singleResult.slice(0, 200)}`);
          fbErrors++;
          continue;
        }
        await this.applyResult(milestone, parsed, item, allMilestones, store);
        fbProcessed++;
      }
      return { processed: fbProcessed, errors: fbErrors };
    }

    let processed = 0;
    let errors = 0;

    // Detect merge directives: summaries with mergedFrom arrays
    const mergeDirectives = new Map<string, SummaryResult>(); // surviving ID → summary with mergedFrom

    for (const [id, summary] of summaries) {
      if (summary.mergedFrom && summary.mergedFrom.length > 1) {
        mergeDirectives.set(id, summary);
      }
    }

    // Capture original IDs before merge processing (merges resequence indices, mutating milestone objects)
    const originalIds = new Map<Milestone, string>();
    for (const { milestone } of milestoneData) {
      originalIds.set(milestone, `${milestone.sessionId}:${milestone.index}`);
    }

    // Apply merges first (modifies allMilestones arrays in place)
    // Returns the set of IDs that were actually absorbed (not just planned)
    let actuallyAbsorbedIds = new Set<string>();
    let actuallyMergedSurvivorIds = new Set<string>();
    if (mergeDirectives.size > 0) {
      const mergeResult = await this.applyMerges(mergeDirectives, milestoneData, store);
      processed += mergeResult.processed;
      errors += mergeResult.errors;
      actuallyAbsorbedIds = mergeResult.absorbedIds;
      actuallyMergedSurvivorIds = mergeResult.survivorIds;
    }

    // Process non-merged milestones normally
    for (const { item, milestone, allMilestones } of milestoneData) {
      const originalId = originalIds.get(milestone)!;

      // Skip absorbed milestones (handled by applyMerges)
      if (actuallyAbsorbedIds.has(originalId)) continue;
      // Skip merged survivors (already handled by applyMerges)
      if (actuallyMergedSurvivorIds.has(originalId)) continue;

      const parsed = summaries.get(originalId);
      if (!parsed) {
        errors++;
        continue;
      }

      await this.applyResult(milestone, parsed, item, allMilestones, store);
      processed++;
    }

    return { processed, errors };
  }

  /**
   * Apply a parsed summary result to a milestone and save.
   */
  private async applyResult(
    milestone: Milestone,
    parsed: SummaryResult,
    item: QueueItem,
    allMilestones: Milestone[],
    store: ReturnType<typeof getMilestoneStore>,
  ): Promise<void> {
    milestone.title = parsed.title;
    milestone.description = parsed.description;
    milestone.type = parsed.type;
    milestone.outcome = parsed.outcome;
    milestone.facts = parsed.facts;
    milestone.concepts = parsed.concepts;
    milestone.architectureRelevant = parsed.architectureRelevant;
    milestone.phase = 2;
    milestone.generatedAt = Date.now();
    milestone.modelUsed = this.getModel();

    // Track projects with architecture-relevant milestones for delta updates
    if (parsed.architectureRelevant && item.projectPath) {
      this.architectureUpdateProjects.add(item.projectPath);
    }

    store.saveMilestones(item.sessionId, allMilestones);

    // Always update index with accurate phase counts
    const p1 = allMilestones.filter(m => m.phase === 1).length;
    const p2 = allMilestones.filter(m => m.phase === 2).length;
    const sessionPhase: 1 | 2 = p1 === 0 ? 2 : 1;
    store.updateIndex(item.sessionId, sessionPhase, allMilestones.length, p1, p2);

    // Post-Phase-2 callback (e.g. Vectra embedding) — awaited to serialize Vectra writes
    if (this.onPhase2Complete) {
      try {
        await this.onPhase2Complete(milestone, item.projectPath);
        this.vectorsIndexed++;
      } catch (err) {
        this.vectorErrors++;
        console.error(`[Summarizer] Post-Phase-2 callback error for ${milestone.id}:`, err);
      }
    }
  }

  /**
   * Apply merge directives from LLM response.
   * For each merge: validate adjacency, combine Phase 1 metadata on the surviving milestone,
   * apply LLM summary, remove absorbed milestones, resequence indices, delete vectors.
   */
  private async applyMerges(
    mergeDirectives: Map<string, SummaryResult>,
    milestoneData: Array<{ item: QueueItem; milestone: Milestone; allMilestones: Milestone[] }>,
    store: ReturnType<typeof getMilestoneStore>,
  ): Promise<{ processed: number; errors: number; absorbedIds: Set<string>; survivorIds: Set<string> }> {
    let processed = 0;
    let errors = 0;
    const absorbedIds = new Set<string>();
    const survivorIds = new Set<string>();

    // Group milestoneData by sessionId for efficient lookup
    const bySession = new Map<string, Array<{ item: QueueItem; milestone: Milestone; allMilestones: Milestone[] }>>();
    for (const md of milestoneData) {
      const sid = md.item.sessionId;
      if (!bySession.has(sid)) bySession.set(sid, []);
      bySession.get(sid)!.push(md);
    }

    // Track sessions that have already been merged in this batch.
    // After a merge + resequence, original IDs are invalidated, so only one merge per session per pass.
    const mergedSessions = new Set<string>();

    for (const [survivorId, summary] of mergeDirectives) {
      const sourceIds = summary.mergedFrom!;

      // Parse survivor session/index
      const colonIdx = survivorId.lastIndexOf(':');
      if (colonIdx === -1) { errors++; continue; }
      const sessionId = survivorId.substring(0, colonIdx);

      // Only one merge per session per pass — resequencing invalidates original IDs
      if (mergedSessions.has(sessionId)) continue;

      // Find the session's milestoneData entries
      const sessionEntries = bySession.get(sessionId);
      if (!sessionEntries || sessionEntries.length === 0) { errors++; continue; }

      // Use the allMilestones array from the first entry (they share the same reference)
      const allMilestones = sessionEntries[0].allMilestones;

      // Resolve source milestones by ID
      const sourceMilestones: Milestone[] = [];
      let valid = true;
      for (const srcId of sourceIds) {
        const m = allMilestones.find(ms => ms.id === srcId);
        if (!m) {
          console.error(`[Summarizer] Merge source ${srcId} not found in session ${sessionId}`);
          valid = false;
          break;
        }
        sourceMilestones.push(m);
      }
      if (!valid || sourceMilestones.length < 2) { errors++; continue; }

      // Sort by index to validate adjacency
      sourceMilestones.sort((a, b) => a.index - b.index);

      // Validate adjacency: indices must be consecutive
      let adjacent = true;
      for (let i = 1; i < sourceMilestones.length; i++) {
        if (sourceMilestones[i].index !== sourceMilestones[i - 1].index + 1) {
          adjacent = false;
          break;
        }
      }
      if (!adjacent) {
        console.error(`[Summarizer] Merge rejected: non-adjacent milestones ${sourceIds.join(', ')}`);
        errors++;
        continue;
      }

      // The surviving milestone is the first one
      const survivor = sourceMilestones[0];
      const absorbed = sourceMilestones.slice(1);

      // Combine Phase 1 metadata onto the survivor
      survivor.startTurn = Math.min(...sourceMilestones.map(m => m.startTurn));
      survivor.endTurn = Math.max(...sourceMilestones.map(m => m.endTurn));
      survivor.startTimestamp = sourceMilestones.reduce((earliest, m) =>
        m.startTimestamp < earliest ? m.startTimestamp : earliest, sourceMilestones[0].startTimestamp);
      survivor.endTimestamp = sourceMilestones.reduce((latest, m) =>
        m.endTimestamp > latest ? m.endTimestamp : latest, sourceMilestones[0].endTimestamp);
      survivor.userPrompts = sourceMilestones.flatMap(m => m.userPrompts);
      survivor.filesModified = [...new Set(sourceMilestones.flatMap(m => m.filesModified))];
      survivor.filesRead = [...new Set(sourceMilestones.flatMap(m => m.filesRead))];
      survivor.taskCompletions = sourceMilestones.flatMap(m => m.taskCompletions);
      survivor.subagentCount = sourceMilestones.reduce((sum, m) => sum + m.subagentCount, 0);

      // Merge tool use summaries (sum counts per tool)
      const mergedToolUse: Record<string, number> = {};
      for (const m of sourceMilestones) {
        for (const [tool, count] of Object.entries(m.toolUseSummary)) {
          mergedToolUse[tool] = (mergedToolUse[tool] || 0) + count;
        }
      }
      survivor.toolUseSummary = mergedToolUse;

      // Apply LLM summary fields
      survivor.title = summary.title;
      survivor.description = summary.description;
      survivor.type = summary.type;
      survivor.outcome = summary.outcome;
      survivor.facts = summary.facts;
      survivor.concepts = summary.concepts;
      survivor.architectureRelevant = summary.architectureRelevant;
      survivor.phase = 2;
      survivor.generatedAt = Date.now();
      survivor.modelUsed = this.getModel();
      survivor.mergedFrom = sourceIds;

      // Remove absorbed milestones from the session array
      // Capture original indices before resequencing (needed for vector deletion)
      const absorbedOriginalIndices = absorbed.map(m => m.index);
      const absorbedIndexSet = new Set(absorbedOriginalIndices);
      const remaining = allMilestones.filter(m => !absorbedIndexSet.has(m.index));

      // Resequence indices
      for (let i = 0; i < remaining.length; i++) {
        remaining[i].index = i;
        remaining[i].id = `${sessionId}:${i}`;
      }

      // Replace the allMilestones array contents (keeping same reference)
      allMilestones.length = 0;
      allMilestones.push(...remaining);

      // Save to disk
      const item = sessionEntries[0].item;
      store.saveMilestones(sessionId, allMilestones);

      // Update index
      const p1 = allMilestones.filter(m => m.phase === 1).length;
      const p2 = allMilestones.filter(m => m.phase === 2).length;
      const sessionPhase: 1 | 2 = p1 === 0 ? 2 : 1;
      store.updateIndex(sessionId, sessionPhase, allMilestones.length, p1, p2);

      // Delete vectors for absorbed milestones (using original indices captured before resequence)
      for (const origIndex of absorbedOriginalIndices) {
        try {
          const vectra = getVectraStore();
          await vectra.deleteMilestone(sessionId, origIndex);
        } catch {
          // Vectra may not be initialized — non-fatal
        }
      }

      // Track architecture-relevant merged milestones for delta updates
      if (summary.architectureRelevant && item.projectPath) {
        this.architectureUpdateProjects.add(item.projectPath);
      }

      // Trigger onPhase2Complete for the surviving merged milestone
      if (this.onPhase2Complete) {
        try {
          await this.onPhase2Complete(survivor, item.projectPath);
          this.vectorsIndexed++;
        } catch (err) {
          this.vectorErrors++;
          console.error(`[Summarizer] Post-Phase-2 callback error for merged ${survivor.id}:`, err);
        }
      }

      // Track which IDs were actually processed by this merge
      survivorIds.add(sourceIds[0]); // Original survivor ID (before resequence)
      for (const srcId of sourceIds) {
        if (srcId !== sourceIds[0]) absorbedIds.add(srcId);
      }

      this.mergesApplied++;
      this.milestonesAbsorbed += absorbed.length;
      mergedSessions.add(sessionId);
      processed++; // Count the merge as one processed unit
      console.error(`[Summarizer] Merged ${sourceIds.join(' + ')} → ${survivor.id} (absorbed ${absorbed.length})`);
    }

    return { processed, errors, absorbedIds, survivorIds };
  }

  // ── Prompt Building ──────────────────────────────────────

  private formatMilestoneForPrompt(m: Milestone): string {
    const prompts = m.userPrompts.map(p =>
      p.length > MAX_PROMPT_CHARS ? p.slice(0, MAX_PROMPT_CHARS) + '...' : p
    );
    const modified = m.filesModified.slice(0, MAX_FILES);
    const read = m.filesRead.slice(0, MAX_FILES);

    const lines = [
      `## ${m.sessionId}:${m.index}`,
      `Turns: ${m.startTurn}-${m.endTurn}`,
      '',
      `### User Requests`,
      ...prompts.map((p, i) => `${i + 1}. ${p}`),
    ];

    if (m.taskCompletions.length > 0) {
      lines.push('', `### Completed Tasks`);
      for (const task of m.taskCompletions) {
        lines.push(`- ${task}`);
      }
    }

    if (modified.length > 0) {
      lines.push('', `### Files Modified`, modified.join(', '));
    }
    if (read.length > 0) {
      lines.push('', `### Files Read`, read.join(', '));
    }

    const toolEntries = Object.entries(m.toolUseSummary).filter(([, v]) => v > 0);
    if (toolEntries.length > 0) {
      lines.push('', `### Tool Usage`, toolEntries.map(([k, v]) => `${k}: ${v}`).join(', '));
    }

    if (m.subagentCount && m.subagentCount > 0) {
      lines.push('', `### Subagents Spawned: ${m.subagentCount}`);
    }

    return lines.join('\n');
  }

  private buildSinglePrompt(m: Milestone): string {
    return [
      `Summarize this completed work unit:`,
      ``,
      this.formatMilestoneForPrompt(m),
      ``,
      `Respond with JSON:`,
      `{`,
      `  "title": "[imperative, max 10 words, e.g. 'Fix tmux scrollback overflow']",`,
      `  "description": "[one sentence, max 24 words, explaining significance]",`,
      `  "type": "[discovery|implementation|bugfix|refactor|decision|configuration]",`,
      `  "outcome": "[what the system NOW DOES differently]",`,
      `  "facts": ["[self-contained statement with filenames/functions/values]", "...3-8 total"],`,
      `  "concepts": ["[from: how-it-works, what-changed, problem-solution, gotcha, pattern, trade-off, configuration]"],`,
      `  "architectureRelevant": false`,
      `}`,
    ].join('\n');
  }

  private buildBatchPrompt(milestones: Milestone[]): string {
    const blocks = milestones.map(m => this.formatMilestoneForPrompt(m)).join('\n\n');

    // Detect sessions with multiple milestones for merge instructions
    const sessionCounts = new Map<string, number>();
    for (const m of milestones) {
      sessionCounts.set(m.sessionId, (sessionCounts.get(m.sessionId) || 0) + 1);
    }
    const hasMultiMilestoneSessions = [...sessionCounts.values()].some(c => c > 1);

    const mergeInstructions = hasMultiMilestoneSessions ? [
      ``,
      `## Merge Instructions`,
      `Some sessions have multiple milestones listed above. If ADJACENT milestones (contiguous turn ranges) from the SAME session clearly represent the same logical unit of work (e.g. debugging + fixing the same bug, iterating on the same feature), you MAY merge them.`,
      ``,
      `To merge: produce ONE summary object for the group. Set "id" to the FIRST milestone's ID. Add "mergedFrom": ["id1", "id2", ...] listing ALL original IDs (including the first). Do NOT produce separate objects for absorbed milestones.`,
      ``,
      `Rules:`,
      `- Only merge ADJACENT milestones (contiguous turns) from the SAME session`,
      `- Only merge when work is clearly the same logical unit`,
      `- When in doubt, keep separate (omit mergedFrom)`,
      `- Non-merged milestones must NOT have a mergedFrom field`,
    ].join('\n') : '';

    return [
      `Summarize each completed work unit. Output a JSON array with one object per milestone.`,
      `Each object MUST include "id" matching the ## header.`,
      mergeInstructions,
      ``,
      blocks,
      ``,
      `Respond with JSON array:`,
      `[{`,
      `  "id": "[sessionId:index from ## header]",`,
      `  "title": "[imperative, max 10 words]",`,
      `  "description": "[one sentence, max 24 words, explaining significance]",`,
      `  "type": "[discovery|implementation|bugfix|refactor|decision|configuration]",`,
      `  "outcome": "[what the system NOW DOES differently]",`,
      `  "facts": ["[self-contained with filenames/functions/values]", "...3-8 total"],`,
      `  "concepts": ["[from: how-it-works, what-changed, problem-solution, gotcha, pattern, trade-off, configuration]"],`,
      `  "architectureRelevant": false`,
      `}, ...]`,
    ].join('\n');
  }

  // ── Response Parsing ──────────────────────────────────────

  private parseSingleResponse(text: string): SummaryResult | null {
    try {
      const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
      const parsed = JSON.parse(cleaned);

      // Handle case where model returns an array with one element
      const obj = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!obj) return null;

      return this.validateSummary(obj);
    } catch {
      return null;
    }
  }

  private parseBatchResponse(text: string): Map<string, SummaryResult> | null {
    try {
      const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
      const parsed = JSON.parse(cleaned);

      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const results = new Map<string, SummaryResult>();

      for (const entry of arr) {
        if (!entry.id) continue;
        const summary = this.validateSummary(entry);
        if (summary) {
          results.set(entry.id, summary);
        }
      }

      return results.size > 0 ? results : null;
    } catch (err: any) {
      console.error(`[Summarizer] parseBatchResponse JSON error: ${err.message}`);
      console.error(`[Summarizer] Raw response (first 500 chars): ${text.slice(0, 500)}`);
      return null;
    }
  }

  private validateSummary(obj: any): SummaryResult | null {
    if (!obj || typeof obj !== 'object') return null;

    const validTypes: MilestoneType[] = ['discovery', 'implementation', 'bugfix', 'refactor', 'decision', 'configuration'];
    const type = validTypes.includes(obj.type) ? obj.type : 'implementation';

    const result: SummaryResult = {
      title: String(obj.title || ''),
      description: String(obj.description || ''),
      type,
      outcome: String(obj.outcome || ''),
      facts: Array.isArray(obj.facts) ? obj.facts.map(String) : [],
      concepts: Array.isArray(obj.concepts) ? obj.concepts.map(String) : [],
      architectureRelevant: obj.architectureRelevant === true,
    };

    // Propagate mergedFrom if present and valid
    if (Array.isArray(obj.mergedFrom) && obj.mergedFrom.length > 0) {
      result.mergedFrom = obj.mergedFrom.map(String);
    }

    return result;
  }

  // ── API & Utilities ──────────────────────────────────────

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private async waitForRateLimit(count = 1): Promise<void> {
    const now = Date.now();

    if (now >= this.rateLimit.resetTime) {
      this.rateLimit.current = 0;
      this.rateLimit.resetTime = now + 60_000;
    }

    if (this.rateLimit.current + count > this.rateLimit.rpm) {
      const waitMs = this.rateLimit.resetTime - now;
      if (waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
      this.rateLimit.current = 0;
      this.rateLimit.resetTime = Date.now() + 60_000;
    }

    this.rateLimit.current += count;
  }

  /**
   * Call agent execution API with a custom system prompt to avoid warmup subagents.
   * Uses maxTurns=1, disallowed tools, and empty settingSources for minimal overhead.
   */
  private async callAgentApi(prompt: string, maxTokens?: number): Promise<string | null> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/agent/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          systemPrompt: SYSTEM_PROMPT,
          model: this.getModel(),
          maxTurns: 1,
          permissionMode: 'bypassPermissions',
          disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'],
          settingSources: [],
        }),
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        console.error(`[Summarizer] Agent API error: ${response.status}`);
        return null;
      }

      const data = await response.json() as any;
      // API wraps response: { success, data: { success, result, error, ... } }
      const result = data.data || data;
      if (!result.success) {
        console.error(`[Summarizer] Agent execution failed: ${result.error}`);
        return null;
      }

      return result.result || null;
    } catch (error: any) {
      console.error('[Summarizer] Agent API call failed:', error.message || error);
      return null;
    }
  }

  private writePipelineStatus(status: PipelineStatus): void {
    try {
      const dir = path.dirname(PIPELINE_STATUS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(PIPELINE_STATUS_FILE, JSON.stringify(status, null, 2));
    } catch {
      // Best-effort status writing
    }
  }
}

let instance: MilestoneSummarizer | null = null;
export function getMilestoneSummarizer(): MilestoneSummarizer {
  if (!instance) instance = new MilestoneSummarizer();
  return instance;
}
