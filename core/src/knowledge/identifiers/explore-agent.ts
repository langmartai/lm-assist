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
import { isJunkResult, MIN_RESULT_LENGTH } from '../helpers';

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

    const newResults: Omit<IdentificationResult, 'id'>[] = [];

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

          // Skip if already generated into knowledge (by agentId)
          if (generatedAgentIds.has(agent.agentId)) continue;

          // Skip if already identified
          if (idStore.findByAgentId(agent.agentId)) continue;

          // Determine lineIndex and turnIndex from subagent data
          const lineIndex = agent.lineIndex ?? 0;
          const turnIndex = agent.turnIndex ?? 0;

          newResults.push({
            sessionId: session.sessionId,
            lineIndex,
            turnIndex,
            projectPath: project,
            timestamp: agent.completedAt || agent.startedAt || new Date().toISOString(),
            identifiedAt: new Date().toISOString(),
            identifierType: 'explore-agent',
            agentId: agent.agentId,
            status: 'candidate',
          });
        }
      } catch {
        // Skip sessions that fail to load
      }
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
