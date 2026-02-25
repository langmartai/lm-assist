/**
 * Explore Agent Formatter
 *
 * Transforms an explore-agent identification into a Knowledge document.
 * Loads the agent's prompt and result, derives title from prompt,
 * splits result on headings, detects type.
 */

import type { KnowledgeFormatter, IdentificationResult, FormatResult } from '../identifier-types';
import { deriveTitle, splitIntoParts, detectType, isJunkResult, MIN_RESULT_LENGTH } from '../helpers';

export class ExploreAgentFormatter implements KnowledgeFormatter {
  readonly identifierType = 'explore-agent' as const;

  /**
   * Format an explore-agent identification into knowledge parts.
   * Loads the original subagent data using sessionId + agentId.
   */
  async format(identification: IdentificationResult): Promise<FormatResult> {
    if (!identification.agentId) {
      throw new Error('Explore-agent identification missing agentId');
    }

    const agentData = await this.loadSubagentData(
      identification.sessionId,
      identification.agentId,
      identification.projectPath,
    );

    if (!agentData) {
      throw new Error(`Explore agent ${identification.agentId} not found in session ${identification.sessionId}`);
    }

    // Quality check
    const trimmedResult = agentData.result.trim();
    if (trimmedResult.length < MIN_RESULT_LENGTH || isJunkResult(trimmedResult)) {
      throw new Error(`Explore agent ${identification.agentId} has insufficient or junk content`);
    }

    // Phase 1: Derive title from prompt
    const title = deriveTitle(agentData.prompt, agentData.description);

    // Phase 2: Split result into parts
    const parts = splitIntoParts(agentData.result);
    if (parts.length === 0) {
      throw new Error('No sections found in explore agent output (expected ## headings)');
    }

    // Detect knowledge type
    const type = detectType(title, parts);

    return {
      title,
      type,
      parts,
      sourceTimestamp: agentData.completedAt,
      sourceLineIndex: agentData.lineIndex,
      sourceTurnIndex: agentData.turnIndex,
    };
  }

  /**
   * Load subagent data from session cache.
   */
  private async loadSubagentData(
    sessionId: string,
    agentId: string,
    project: string,
  ): Promise<{ prompt: string; result: string; description?: string; completedAt?: string; lineIndex?: number; turnIndex?: number } | null> {
    const { getSessionReader } = require('../../session-reader');
    const { getSessionCache } = require('../../session-cache');

    const reader = getSessionReader();
    const cache = getSessionCache();

    if (cache.isWarming()) {
      await cache.waitForWarming();
    }

    const filePath = reader.getSessionFilePath(sessionId, project);
    const data = await cache.getSessionData(filePath);

    if (data?.subagents?.length) {
      const agent = data.subagents.find((a: any) => a.agentId === agentId);
      if (agent?.result) {
        return {
          prompt: agent.prompt,
          result: agent.result,
          description: agent.description,
          completedAt: agent.completedAt || agent.startedAt,
          lineIndex: agent.lineIndex,
          turnIndex: agent.turnIndex,
        };
      }
    }

    return null;
  }
}
