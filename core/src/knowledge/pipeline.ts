/**
 * Knowledge Pipeline
 *
 * Orchestrates: identify → store identification → format → store knowledge.
 *
 * The pipeline is the V2 entry point for knowledge generation. It coordinates
 * identifiers (which discover/resolve content) with formatters (which transform
 * content into knowledge documents). The KnowledgeGenerator delegates to this
 * pipeline while maintaining its backwards-compatible API.
 */

import type { IdentificationResult, IdentifierType, FormatResult } from './identifier-types';
import { getIdentificationStore } from './identification-store';
import { getIdentifier, getAllIdentifiers } from './identifiers/index';
import { getFormatter } from './formatters/index';
import { getKnowledgeStore } from './store';
import type { Knowledge } from './types';
import { findDuplicateKnowledge, markDuplicatesAsOutdated, deduplicateBatch } from './dedup';
import { deriveTitle, isJunkResult, MIN_RESULT_LENGTH } from './helpers';

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

export class KnowledgePipeline {
  private currentStatus: GenerateStatus = { status: 'idle' };
  private stopRequested = false;

  /**
   * Discover candidates for a project using one or all identifier types.
   * Stores identification results and returns them.
   */
  async discover(
    project: string,
    identifierType?: IdentifierType,
  ): Promise<IdentificationResult[]> {
    if (identifierType) {
      const identifier = getIdentifier(identifierType);
      return identifier.discover(project);
    }

    // Run all identifiers
    const allResults: IdentificationResult[] = [];
    for (const identifier of getAllIdentifiers()) {
      try {
        const results = await identifier.discover(project);
        allResults.push(...results);
      } catch (err) {
        console.error(`[KnowledgePipeline] Identifier ${identifier.type} failed:`, err);
      }
    }
    return allResults;
  }

  /**
   * Generate knowledge from an existing identification result.
   * Loads the identification, formats it, stores the knowledge, and updates the identification status.
   */
  async generate(
    identificationId: string,
    project: string,
    options?: { title?: string },
  ): Promise<Knowledge> {
    const idStore = getIdentificationStore();
    const knowledgeStore = getKnowledgeStore();

    // Load identification
    const identification = idStore.get(identificationId);
    if (!identification) {
      throw new Error(`Identification ${identificationId} not found`);
    }

    if (identification.status === 'generated' && identification.knowledgeId) {
      throw new Error(`Identification ${identificationId} already generated as ${identification.knowledgeId}`);
    }

    // Format using the appropriate formatter
    const formatter = getFormatter(identification.identifierType);
    const formatResult = await formatter.format(identification);

    // Allow title override
    const title = options?.title || formatResult.title;

    // Embedding-based dedup: find similar existing knowledge (explore agents only)
    // and mark old entries as outdated before creating the new one
    if (identification.agentId) {
      try {
        const contentText = formatResult.parts.map(p => `${p.title}: ${p.summary}`).join('\n');
        const duplicates = await findDuplicateKnowledge(title, contentText, project);
        if (duplicates.length > 0) {
          const dupIds = duplicates.map(d => d.id);
          markDuplicatesAsOutdated(dupIds);
          console.log(`[KnowledgePipeline] Marked ${dupIds.length} older entries as outdated: ${dupIds.join(', ')}`);
        }
      } catch (err) {
        // Non-fatal — dedup is best-effort, creation proceeds
        console.warn('[KnowledgePipeline] Embedding dedup failed:', err);
      }
    }

    // Create knowledge document
    const knowledge = knowledgeStore.createKnowledge({
      title,
      type: formatResult.type,
      project,
      parts: formatResult.parts,
      status: 'active',
      sourceSessionId: identification.sessionId,
      sourceAgentId: identification.agentId,
      sourceTimestamp: formatResult.sourceTimestamp,
      sourceIdentifier: identification.identifierType,
      sourceLineIndex: identification.lineIndex,
      sourceTurnIndex: identification.turnIndex,
    });

    // Update identification status
    idStore.update(identificationId, {
      knowledgeId: knowledge.id,
      status: 'generated',
    });

    return knowledge;
  }

  /**
   * Generate knowledge from generic content (manual, no prior identification needed).
   * Identifies the content, then generates knowledge in one step.
   */
  async generateFromGenericContent(
    sessionId: string,
    lineIndex: number,
    project: string,
    title?: string,
  ): Promise<Knowledge> {
    const identifier = getIdentifier('generic-content');

    // Resolve (creates identification result)
    const identification = await identifier.resolve(project, sessionId, lineIndex);
    if (!identification) {
      throw new Error(`No valid content found at session ${sessionId} line ${lineIndex}`);
    }

    // Generate from the identification
    return this.generate(identification.id, project, { title });
  }

  /**
   * Generate knowledge from all validated identifications for a project.
   * Processes sequentially. Uses LLM-suggested title when available.
   */
  async generateValidated(
    project: string,
    identifierType?: IdentifierType,
  ): Promise<{ generated: number; errors: number; skipped: number; results: Array<{ id: string; knowledgeId?: string; error?: string }> }> {
    const idStore = getIdentificationStore();
    const filters: any = { status: 'validated' as const };
    if (identifierType) filters.identifierType = identifierType;

    const validated = idStore.list(filters);
    if (validated.length === 0) {
      return { generated: 0, errors: 0, skipped: 0, results: [] };
    }

    let generated = 0;
    let errors = 0;
    let skipped = 0;
    const results: Array<{ id: string; knowledgeId?: string; error?: string }> = [];

    for (const identification of validated) {
      try {
        // Use LLM-suggested title if available
        const title = identification.suggestedTitle || undefined;
        const knowledge = await this.generate(identification.id, project, { title });
        generated++;
        results.push({ id: identification.id, knowledgeId: knowledge.id });
      } catch (err: any) {
        const msg = err.message || String(err);
        // Skip already-generated (not an error)
        if (msg.includes('already generated')) {
          skipped++;
          results.push({ id: identification.id, error: 'already generated' });
        } else {
          errors++;
          results.push({ id: identification.id, error: msg });
          console.error(`[KnowledgePipeline] Failed to generate ${identification.id}:`, msg);
        }
      }
    }

    // Schedule async vector indexing
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
              console.error('[KnowledgePipeline] Auto LLM review failed:', err.message);
            });
          }
        }
      } catch (err: any) {
        console.error('[KnowledgePipeline] Auto review trigger error:', err.message);
      }
    }

    return { generated, errors, skipped, results };
  }

  /**
   * Schedule async vector indexing after batch generation.
   */
  private _vectorIndexTimer: ReturnType<typeof setTimeout> | null = null;
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
            await vectra.deleteLocalByType('knowledge');
            await vectra.addVectors(allVectors);
            await vectra.rebuildFtsIndex();
            console.log(`[KnowledgePipeline] Indexed ${allVectors.length} vectors from ${allIds.length} knowledge docs`);
          }
        } catch (err) {
          console.warn('[KnowledgePipeline] Async vector indexing failed:', err);
        }
      })();
    }, 5_000);
  }

  // ─── V1 feature parity methods ──────────────────────────────────────

  getStatus(): GenerateStatus {
    return { ...this.currentStatus };
  }

  stop(): void {
    if (this.currentStatus.status === 'generating') {
      this.stopRequested = true;
    }
  }

  /**
   * Discover explore agent candidates for knowledge generation.
   * Returns ExploreCandidate[] matching V1's discoverExploreSessions() shape.
   */
  async discoverExploreCandidates(project: string): Promise<ExploreCandidate[]> {
    const { getSessionReader } = require('../session-reader');
    const { getSessionCache } = require('../session-cache');

    const reader = getSessionReader();
    const cache = getSessionCache();
    const store = getKnowledgeStore();

    // Wait for background warming to finish so all sessions are available
    if (cache.isWarming()) {
      await cache.waitForWarming();
    }

    const allSessions = reader.listSessions(project);
    if (allSessions.length === 0) return [];

    // Get already-generated agent IDs for dedup
    const generatedIds = store.getGeneratedAgentIds();
    const generatedTitleKeys = store.getGeneratedTitleSessionKeys();

    const rawCandidates: (ExploreCandidate & { resultLength: number })[] = [];

    for (const session of allSessions) {
      try {
        const filePath = reader.getSessionFilePath(session.sessionId, project);
        const data = await cache.getSessionData(filePath);
        if (!data?.subagents?.length) continue;

        for (const agent of data.subagents) {
          if (!agent.agentId) continue;
          if (!agent.type || agent.type.toLowerCase() !== 'explore') continue;
          if (agent.status !== 'completed') continue;
          if (!agent.result || agent.result.length < MIN_RESULT_LENGTH) continue;
          if (isJunkResult(agent.result.trim())) continue;

          // Skip if already generated (by agentId)
          if (generatedIds.has(agent.agentId)) continue;

          // Skip if title+session already generated
          const derivedTitle = deriveTitle(agent.prompt, agent.description);
          if (generatedTitleKeys.has(`${derivedTitle}\0${session.sessionId}`)) continue;

          rawCandidates.push({
            sessionId: session.sessionId,
            agentId: agent.agentId,
            type: agent.type,
            prompt: agent.prompt,
            resultPreview: agent.result.slice(0, 300) + (agent.result.length > 300 ? '...' : ''),
            description: agent.description,
            timestamp: agent.completedAt || agent.startedAt,
            resultLength: agent.result.length,
          });
        }
      } catch {
        // Skip sessions that fail to load
      }
    }

    // Sort by timestamp descending (most recent first) BEFORE dedup
    rawCandidates.sort((a, b) => {
      if (!a.timestamp && !b.timestamp) return 0;
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return b.timestamp.localeCompare(a.timestamp);
    });

    // Within-batch dedup: group by normalized title, keep most complete
    const dedupedCandidates = deduplicateBatch(
      rawCandidates,
      (c) => deriveTitle(c.prompt, c.description),
      (c) => c.resultLength,
    );

    // Strip internal field
    return dedupedCandidates.map(({ resultLength, ...rest }) => rest);
  }

  /**
   * Generate knowledge from a specific explore agent.
   * Uses V2 identifier.resolve() + pipeline.generate() internally.
   */
  async generateFromExploreAgent(
    sessionId: string,
    agentId: string,
    project: string,
    options?: { skipStatusTracking?: boolean },
  ): Promise<Knowledge> {
    if (!options?.skipStatusTracking) {
      this.currentStatus = { status: 'generating', currentSessionId: sessionId, currentAgentId: agentId };
    }

    try {
      // Pre-check: reject if agentId already generated
      const store = getKnowledgeStore();
      const generatedIds = store.getGeneratedAgentIds();
      if (generatedIds.has(agentId)) {
        const existingId = store.findByAgentId(agentId);
        throw new Error(`Agent ${agentId} already generated as ${existingId || 'unknown'} — skipping duplicate`);
      }

      // Use V2 identifier to resolve/create identification
      const identifier = getIdentifier('explore-agent');
      const identification = await identifier.resolve(project, sessionId, 0, { agentId });
      if (!identification) {
        throw new Error(`Explore agent ${agentId} not found in session ${sessionId}`);
      }

      // Generate via the standard pipeline path
      return await this.generate(identification.id, project);
    } finally {
      if (!options?.skipStatusTracking) {
        this.currentStatus = { status: 'idle' };
      }
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
    const candidates = await this.discoverExploreCandidates(project);
    const total = candidates.length;
    let generated = 0;
    let errors = 0;

    this.currentStatus = { status: 'generating', processed: 0, total, errors: 0 };

    try {
      for (const candidate of candidates) {
        if (this.stopRequested) break;

        try {
          await this.generateFromExploreAgent(candidate.sessionId, candidate.agentId, project, { skipStatusTracking: true });
          generated++;
        } catch (err) {
          errors++;
          console.error(`[KnowledgePipeline] Failed to generate from ${candidate.agentId}:`, err);
        }

        this.currentStatus = { status: 'generating', processed: generated + errors, total, errors };
      }
    } finally {
      const stopped = this.stopRequested;
      this.stopRequested = false;
      this.currentStatus = { status: 'idle' };

      // Async vector indexing
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
                console.error('[KnowledgePipeline] Auto LLM review failed:', err.message);
              });
            }
          }
        } catch (err: any) {
          console.error('[KnowledgePipeline] Auto review trigger error:', err.message);
        }
      }

      return { generated, errors, stopped };
    }
  }

  /**
   * Regenerate knowledge by re-extracting from its original source.
   */
  async regenerateKnowledge(knowledgeId: string): Promise<Knowledge> {
    const store = getKnowledgeStore();
    const existing = store.getKnowledge(knowledgeId);
    if (!existing) {
      throw new Error(`Knowledge ${knowledgeId} not found`);
    }

    const identifierType = (existing.sourceIdentifier || 'explore-agent') as IdentifierType;

    if (identifierType === 'explore-agent') {
      if (!existing.sourceSessionId || !existing.sourceAgentId) {
        throw new Error(`Knowledge ${knowledgeId} has no source tracking (not generated from explore)`);
      }
    }

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
   * Preview what knowledge would look like from generic content.
   * Read-only — does not create identifications or knowledge documents.
   */
  async previewGenericContent(
    sessionId: string,
    lineIndex: number,
    project: string,
    title?: string,
  ): Promise<{ title: string; type: string; parts: any[]; sourceTimestamp?: string }> {
    // Build a temporary identification for the formatter (not stored)
    const tempIdentification: IdentificationResult = {
      id: '',
      sessionId,
      lineIndex,
      turnIndex: 0,
      projectPath: project,
      timestamp: new Date().toISOString(),
      identifiedAt: new Date().toISOString(),
      identifierType: 'generic-content',
      status: 'candidate',
    };

    const formatter = getFormatter('generic-content');
    try {
      const result = await formatter.format(tempIdentification);
      return {
        title: title || result.title,
        type: result.type,
        parts: result.parts,
        sourceTimestamp: result.sourceTimestamp,
      };
    } catch {
      throw new Error(`No valid content found at session ${sessionId} line ${lineIndex}`);
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let instance: KnowledgePipeline | null = null;
export function getKnowledgePipeline(): KnowledgePipeline {
  if (!instance) instance = new KnowledgePipeline();
  return instance;
}
