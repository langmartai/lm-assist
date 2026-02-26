/**
 * Knowledge Generator
 *
 * Discovers Explore-type subagent sessions and converts their research output
 * into structured knowledge documents via direct extraction (no LLM needed).
 *
 * Two-Phase Process:
 * 1. Use explore agent's prompt as knowledge title/summary
 * 2. Split the agent's last assistant message (result) on ## headings into parts
 *
 * Each ## heading in the result becomes a knowledge part. Content under each
 * heading is preserved as-is with all its original markdown formatting.
 */

import { getKnowledgeStore } from './store';
import type { Knowledge } from './types';
import type { IdentifierType, FormatResult } from './identifier-types';
import {
  deriveTitle,
  splitIntoParts,
  detectType,
  isJunkResult,
  MIN_RESULT_LENGTH,
} from './helpers';

const MAX_SESSIONS_TO_SCAN = Infinity;

// ─── Types ──────────────────────────────────────────────────

export interface ExploreCandidate {
  sessionId: string;
  agentId: string;
  type: string;
  prompt: string;
  resultPreview: string;
  description?: string;
  timestamp?: string;
}

export interface GenerateStatus {
  status: 'idle' | 'generating';
  currentSessionId?: string;
  currentAgentId?: string;
  processed?: number;
  total?: number;
  errors?: number;
}

// ─── Generator Class ──────────────────────────────────────────────────

export class KnowledgeGenerator {
  private currentStatus: GenerateStatus = { status: 'idle' };
  private stopRequested = false;

  getStatus(): GenerateStatus {
    return { ...this.currentStatus };
  }

  /**
   * Discover explore agent sessions that can be converted to knowledge.
   * Filters out already-generated agents via sourceAgentId dedup.
   */
  async discoverExploreSessions(project: string): Promise<ExploreCandidate[]> {
    const { getSessionReader } = require('../session-reader');
    const { getSessionCache } = require('../session-cache');

    const reader = getSessionReader();
    const cache = getSessionCache();
    const store = getKnowledgeStore();

    // Wait for background warming to finish so all sessions are available
    if (cache.isWarming()) {
      console.error('[KnowledgeGenerator] Waiting for session cache warming to complete...');
      await cache.waitForWarming();
      console.error('[KnowledgeGenerator] Warming complete, proceeding with discovery');
    }

    // Get sessions for this project (already sorted by most recent first)
    const allSessions = reader.listSessions(project);
    if (allSessions.length === 0) return [];

    // Limit scan to most recent sessions for performance
    const sessions = allSessions.slice(0, MAX_SESSIONS_TO_SCAN);

    // Get already-generated agent IDs and title+session keys for dedup
    const generatedIds = store.getGeneratedAgentIds();
    const generatedTitleKeys = store.getGeneratedTitleSessionKeys();

    const candidates: ExploreCandidate[] = [];

    for (const session of sessions) {
      try {
        const filePath = reader.getSessionFilePath(session.sessionId, project);
        const data = await cache.getSessionData(filePath);
        if (!data?.subagents?.length) continue;

        for (const agent of data.subagents) {
          // Must have a valid agentId
          if (!agent.agentId) continue;

          // Must be Explore type (case-insensitive) and completed
          if (!agent.type || agent.type.toLowerCase() !== 'explore') continue;
          if (agent.status !== 'completed') continue;

          // Must have substantial result that isn't junk
          if (!agent.result || agent.result.length < MIN_RESULT_LENGTH) continue;
          if (isJunkResult(agent.result.trim())) continue;

          // Skip if already generated (by agentId)
          if (generatedIds.has(agent.agentId)) continue;

          // Skip if title+session already generated (catches duplicates with different agentIds)
          const derivedTitle = deriveTitle(agent.prompt, agent.description);
          if (generatedTitleKeys.has(`${derivedTitle}\0${session.sessionId}`)) continue;

          candidates.push({
            sessionId: session.sessionId,
            agentId: agent.agentId,
            type: agent.type,
            prompt: agent.prompt,
            resultPreview: agent.result.slice(0, 300) + (agent.result.length > 300 ? '...' : ''),
            description: agent.description,
            timestamp: agent.completedAt || agent.startedAt,
          });
        }
      } catch {
        // Skip sessions that fail to load
      }
    }

    // Sort by timestamp descending (most recent first)
    candidates.sort((a, b) => {
      if (!a.timestamp && !b.timestamp) return 0;
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return b.timestamp.localeCompare(a.timestamp);
    });

    return candidates;
  }

  /**
   * Generate a knowledge document by directly extracting from explore agent output.
   *
   * Phase 1: Agent prompt → knowledge title
   * Phase 2: Agent result → split on ## headings into knowledge parts
   *
   * No LLM call needed — instant extraction.
   */
  async generateFromExplore(sessionId: string, agentId: string, project: string): Promise<Knowledge> {
    this.currentStatus = { status: 'generating', currentSessionId: sessionId, currentAgentId: agentId };

    try {
      // Dedup check: reject if this agentId was already generated
      const store = getKnowledgeStore();
      const generatedIds = store.getGeneratedAgentIds();
      if (generatedIds.has(agentId)) {
        const existingId = store.findByAgentId(agentId);
        throw new Error(`Agent ${agentId} already generated as ${existingId || 'unknown'} — skipping duplicate`);
      }

      // Load the subagent data (waits for warming if needed)
      const agentData = await this.loadSubagentData(sessionId, agentId, project);
      if (!agentData) {
        throw new Error(`Explore agent ${agentId} not found in session ${sessionId}`);
      }

      // Quality check: reject empty/failed explore results
      const trimmedResult = agentData.result.trim();
      if (trimmedResult.length < MIN_RESULT_LENGTH || isJunkResult(trimmedResult)) {
        throw new Error(`Explore agent ${agentId} has insufficient or junk content — skipping`);
      }

      // Phase 1: Derive title from prompt
      const title = deriveTitle(agentData.prompt, agentData.description);

      // Phase 2: Split result into parts
      const rawParts = splitIntoParts(agentData.result);
      if (rawParts.length === 0) {
        throw new Error('No sections found in explore agent output (expected ## headings)');
      }

      // Detect knowledge type from content
      const type = detectType(title, rawParts);

      // Create knowledge document
      const knowledge = store.createKnowledge({
        title,
        type,
        project,
        parts: rawParts,
        status: 'active',
        sourceSessionId: sessionId,
        sourceAgentId: agentId,
        sourceTimestamp: agentData.completedAt,
      });

      return knowledge;
    } finally {
      this.currentStatus = { status: 'idle' };
    }
  }

  /**
   * Regenerate knowledge by re-extracting from its original source.
   * Checks sourceIdentifier to pick the right formatter (defaults to explore-agent for backwards compat).
   */
  async regenerateKnowledge(knowledgeId: string): Promise<Knowledge> {
    const store = getKnowledgeStore();
    const existing = store.getKnowledge(knowledgeId);
    if (!existing) {
      throw new Error(`Knowledge ${knowledgeId} not found`);
    }

    const identifierType = (existing.sourceIdentifier || 'explore-agent') as IdentifierType;

    // For explore-agent, require sourceAgentId
    if (identifierType === 'explore-agent') {
      if (!existing.sourceSessionId || !existing.sourceAgentId) {
        throw new Error(`Knowledge ${knowledgeId} has no source tracking (not generated from explore)`);
      }
    }

    // For generic-content, require sourceSessionId and sourceLineIndex
    if (identifierType === 'generic-content') {
      if (!existing.sourceSessionId || existing.sourceLineIndex === undefined) {
        throw new Error(`Knowledge ${knowledgeId} has no source tracking (missing session or line index)`);
      }
    }

    this.currentStatus = {
      status: 'generating',
      currentSessionId: existing.sourceSessionId,
      currentAgentId: existing.sourceAgentId,
    };

    try {
      // Use the formatter for the identifier type
      const { getFormatter } = require('./formatters/index');
      const formatter = getFormatter(identifierType);

      // Build a minimal identification for the formatter
      const identification = {
        id: '',
        sessionId: existing.sourceSessionId!,
        lineIndex: existing.sourceLineIndex ?? 0,
        turnIndex: existing.sourceTurnIndex ?? 0,
        projectPath: existing.project,
        timestamp: existing.sourceTimestamp || '',
        identifiedAt: '',
        identifierType,
        agentId: existing.sourceAgentId,
        status: 'generated' as const,
      };

      const formatResult: FormatResult = await formatter.format(identification);

      // Re-number parts with existing knowledge ID
      const parts = formatResult.parts.map((p: any, i: number) => ({
        ...p,
        partId: `${knowledgeId}.${i + 1}`,
      }));

      const updated = store.updateKnowledge(knowledgeId, {
        title: formatResult.title,
        type: formatResult.type,
        parts,
        sourceTimestamp: formatResult.sourceTimestamp,
        sourceIdentifier: identifierType,
        sourceLineIndex: formatResult.sourceLineIndex,
        sourceTurnIndex: formatResult.sourceTurnIndex,
      });

      if (!updated) {
        throw new Error('Failed to update knowledge document');
      }

      return updated;
    } finally {
      this.currentStatus = { status: 'idle' };
    }
  }

  /**
   * Stop batch generation after current item finishes.
   */
  stop(): void {
    if (this.currentStatus.status === 'generating') {
      this.stopRequested = true;
    }
  }

  /**
   * Generate knowledge from all candidates for a project.
   * Processes sequentially, respects stop requests.
   */
  async generateAll(project: string): Promise<{ generated: number; errors: number; stopped: boolean }> {
    if (this.currentStatus.status === 'generating') {
      throw new Error('Generation already in progress');
    }

    this.stopRequested = false;
    const candidates = await this.discoverExploreSessions(project);
    const total = candidates.length;
    let generated = 0;
    let errors = 0;

    this.currentStatus = { status: 'generating', processed: 0, total, errors: 0 };

    try {
      for (const candidate of candidates) {
        if (this.stopRequested) break;

        try {
          await this.generateFromExplore(candidate.sessionId, candidate.agentId, project);
          generated++;
        } catch (err) {
          errors++;
          console.error(`[KnowledgeGenerator] Failed to generate from ${candidate.agentId}:`, err);
        }

        this.currentStatus = { status: 'generating', processed: generated + errors, total, errors };
      }
    } finally {
      const stopped = this.stopRequested;
      this.stopRequested = false;
      this.currentStatus = { status: 'idle' };

      // Async vector indexing — always schedule after generateAll runs,
      // even if this batch generated 0 (earlier batches may have generated docs)
      this.indexKnowledgeVectorsAsync();

      // Auto-trigger LLM review if enabled and we generated new entries
      if (generated > 0) {
        try {
          const { getKnowledgeSettings } = require('./settings');
          const { getKnowledgeLlmReviewer } = require('./llm-reviewer');
          const settings = getKnowledgeSettings();
          if (settings.autoReview) {
            const reviewer = getKnowledgeLlmReviewer();
            if (reviewer.getStatus().status === 'idle') {
              reviewer.review({ project, trigger: 'auto' }).catch((err: any) => {
                console.error('[KnowledgeGenerator] Auto LLM review failed:', err.message);
              });
            }
          }
        } catch (err: any) {
          console.error('[KnowledgeGenerator] Auto review trigger error:', err.message);
        }
      }

      return { generated, errors, stopped };
    }
  }

  private _vectorIndexTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Schedule async vector indexing of all knowledge docs.
   * Debounced (5s) so multiple generateAll batches consolidate into one indexing pass.
   */
  private indexKnowledgeVectorsAsync(): void {
    if (this._vectorIndexTimer) clearTimeout(this._vectorIndexTimer);
    this._vectorIndexTimer = setTimeout(() => {
      this._vectorIndexTimer = null;
      (async () => {
        try {
          const { getVectorStore } = require('../vector/vector-store');
          const { extractKnowledgeVectors } = require('../vector/indexer');
          const store = getKnowledgeStore();
          const vectra = getVectorStore();

          const allIds = store.getAllIds();
          const allVectors: Array<{ text: string; metadata: any }> = [];
          for (const id of allIds) {
            const knowledge = store.getKnowledge(id);
            if (!knowledge) continue;
            allVectors.push(...extractKnowledgeVectors(knowledge));
          }

          if (allVectors.length > 0) {
            // Delete existing knowledge vectors first to prevent unbounded growth
            await vectra.deleteLocalByType('knowledge');
            await vectra.addVectors(allVectors);
            await vectra.rebuildFtsIndex();
            console.log(`[KnowledgeGenerator] Indexed ${allVectors.length} vectors from ${allIds.length} knowledge docs`);
          }
        } catch (err) {
          console.warn('[KnowledgeGenerator] Async vector indexing failed:', err);
        }
      })();
    }, 5000);
  }

  /**
   * Load subagent data from session cache.
   * Waits for warming to complete if still running.
   */
  private async loadSubagentData(
    sessionId: string,
    agentId: string,
    project: string,
  ): Promise<{ prompt: string; result: string; description?: string; completedAt?: string } | null> {
    const { getSessionReader } = require('../session-reader');
    const { getSessionCache } = require('../session-cache');

    const reader = getSessionReader();
    const cache = getSessionCache();

    // Wait for warming if still running
    if (cache.isWarming()) {
      console.error('[KnowledgeGenerator] Waiting for session cache warming...');
      await cache.waitForWarming();
    }

    const filePath = reader.getSessionFilePath(sessionId, project);

    const data = await cache.getSessionData(filePath);

    if (data?.subagents?.length) {
      const agent = data.subagents.find((a: any) => a.agentId === agentId);
      if (agent?.result) {
        return { prompt: agent.prompt, result: agent.result, description: agent.description, completedAt: agent.completedAt || agent.startedAt };
      }
    }

    return null;
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let instance: KnowledgeGenerator | null = null;
export function getKnowledgeGenerator(): KnowledgeGenerator {
  if (!instance) instance = new KnowledgeGenerator();
  return instance;
}
