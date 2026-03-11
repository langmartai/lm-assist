/**
 * Explore Agent Identifier
 *
 * Scans sessions for completed Explore-type subagents and produces
 * IdentificationResult records. This is the V2 equivalent of
 * KnowledgeGenerator.discoverExploreSessions().
 */

import type { KnowledgeIdentifier, IdentificationResult } from '../identifier-types';
import { getIdentificationStore } from '../identification-store';
import { getKnowledgeStore } from '../store';
import { isJunkResult, MIN_RESULT_LENGTH, deriveTitle } from '../helpers';
import { normalizeTitle } from '../dedup';

export class ExploreAgentIdentifier implements KnowledgeIdentifier {
  readonly type = 'explore-agent' as const;

  /**
   * Discover completed explore subagents across all sessions for a project.
   * Stores new identification results and returns them.
   * Skips agents already identified or already generated into knowledge.
   */
  async discover(project: string): Promise<IdentificationResult[]> {
    const { getSessionReader } = require('../../session-reader');
    const { getSessionCache } = require('../../session-cache');

    const reader = getSessionReader();
    const cache = getSessionCache();
    const store = getKnowledgeStore();
    const idStore = getIdentificationStore();

    // Wait for background warming
    if (cache.isWarming()) {
      await cache.waitForWarming();
    }

    const allSessions = reader.listSessions(project);
    if (allSessions.length === 0) return [];

    // Get already-generated agent IDs for dedup
    const generatedAgentIds = store.getGeneratedAgentIds();
    const generatedTitleKeys = store.getGeneratedTitleSessionKeys();

    const newResults: Omit<IdentificationResult, 'id'>[] = [];
    // Within-batch dedup: track normalized titles, keep most complete per title
    const bestByTitle = new Map<string, { result: Omit<IdentificationResult, 'id'>; contentLength: number }>();

    for (const session of allSessions) {
      try {
        const filePath = reader.getSessionFilePath(session.sessionId, project);
        const data = await cache.getSessionData(filePath);
        if (!data?.subagents?.length) continue;

        for (const agent of data.subagents) {
          if (!agent.agentId) continue;
          const agentType = (agent.type || '').toLowerCase();
          if (agentType !== 'explore' && agentType !== 'general-purpose') continue;
          if (agent.status !== 'completed') continue;
          if (!agent.result || agent.result.length < MIN_RESULT_LENGTH) continue;
          if (isJunkResult(agent.result.trim())) continue;

          // Skip if already generated into knowledge (by agentId)
          if (generatedAgentIds.has(agent.agentId)) continue;

          // Skip if already identified
          if (idStore.findByAgentId(agent.agentId)) continue;

          // Skip if title+session already generated (V1 parity)
          const derivedTitle = deriveTitle(agent.prompt, agent.description);
          if (generatedTitleKeys.has(`${derivedTitle}\0${session.sessionId}`)) continue;

          // Determine lineIndex and turnIndex from subagent data
          const lineIndex = agent.lineIndex ?? 0;
          const turnIndex = agent.turnIndex ?? 0;
          const resultLength = agent.result?.length ?? 0;

          const candidate: Omit<IdentificationResult, 'id'> = {
            sessionId: session.sessionId,
            lineIndex,
            turnIndex,
            projectPath: project,
            timestamp: agent.completedAt || agent.startedAt || new Date().toISOString(),
            identifiedAt: new Date().toISOString(),
            identifierType: 'explore-agent',
            agentId: agent.agentId,
            status: 'candidate',
            metadata: {
              type: agent.type,
              prompt: agent.prompt,
              resultPreview: agent.result.slice(0, 300) + (agent.result.length > 300 ? '...' : ''),
              description: agent.description,
              resultLength,
            },
          };

          // Within-batch dedup: group by normalized title, keep most complete (longest result, newest on tie)
          const normalizedKey = normalizeTitle(derivedTitle);
          const existing = bestByTitle.get(normalizedKey);
          if (!existing || resultLength > existing.contentLength ||
              (resultLength === existing.contentLength && candidate.timestamp > existing.result.timestamp)) {
            bestByTitle.set(normalizedKey, { result: candidate, contentLength: resultLength });
          }
        }
      } catch {
        // Skip sessions that fail to load
      }
    }

    // Collect the best candidate per normalized title
    for (const { result } of bestByTitle.values()) {
      newResults.push(result);
    }

    if (newResults.length === 0) return [];

    // Store all new identifications
    return idStore.add(newResults);
  }

  /**
   * Resolve a specific explore agent by sessionId + lineIndex.
   * Creates an identification result if the content at that position is a valid explore agent.
   */
  async resolve(
    project: string,
    sessionId: string,
    lineIndex: number,
    extra?: Record<string, any>,
  ): Promise<IdentificationResult | null> {
    const agentId = extra?.agentId;
    if (!agentId) return null;

    const idStore = getIdentificationStore();

    // Check if already identified
    const existing = idStore.findByAgentId(agentId);
    if (existing) return existing;

    const result: Omit<IdentificationResult, 'id'> = {
      sessionId,
      lineIndex,
      turnIndex: extra?.turnIndex ?? 0,
      projectPath: project,
      timestamp: extra?.timestamp || new Date().toISOString(),
      identifiedAt: new Date().toISOString(),
      identifierType: 'explore-agent',
      agentId,
      status: 'candidate',
    };

    const added = idStore.add([result]);
    return added[0] || null;
  }
}
