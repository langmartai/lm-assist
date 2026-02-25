/**
 * Generic Content Identifier
 *
 * Discovers and resolves knowledge-worthy assistant messages from sessions.
 * Uses heuristic scoring (scoreKnowledgeCandidate) to auto-detect significant
 * content: analysis, architecture, debugging findings, comparisons, etc.
 */

import type { KnowledgeIdentifier, IdentificationResult } from '../identifier-types';
import { getIdentificationStore } from '../identification-store';
import { scoreKnowledgeCandidate } from '../helpers';

export class GenericContentIdentifier implements KnowledgeIdentifier {
  readonly type = 'generic-content' as const;

  /**
   * Discover knowledge-worthy assistant messages from sessions.
   * Scans responses through heuristic scoring and identifies candidates
   * that score 'candidate' or 'auto-accept'.
   */
  async discover(project: string): Promise<IdentificationResult[]> {
    try {
      const { getSessionReader } = require('../../session-reader');
      const { getSessionCache } = require('../../session-cache');

      const reader = getSessionReader();
      const cache = getSessionCache();
      const idStore = getIdentificationStore();

      if (cache.isWarming()) {
        await cache.waitForWarming();
      }

      const sessions = reader.listSessions(project);
      const newResults: Omit<IdentificationResult, 'id'>[] = [];

      for (const session of sessions) {
        try {
          const filePath = reader.getSessionFilePath(session.sessionId, project);
          const data = await cache.getSessionData(filePath);
          if (!data?.responses?.length) continue;

          for (const response of data.responses) {
            if (!response.text || response.text.length < 500) continue;

            // Skip already identified
            if (idStore.hasIdentification('generic-content', session.sessionId, response.lineIndex)) {
              continue;
            }

            const scoreResult = scoreKnowledgeCandidate(response.text);

            // Only skip hard rejects — let LLM validate everything else
            if (scoreResult.classification === 'reject') {
              continue;
            }

            newResults.push({
              sessionId: session.sessionId,
              lineIndex: response.lineIndex,
              turnIndex: response.turnIndex,
              projectPath: project,
              timestamp: (response as any).timestamp || new Date().toISOString(),
              identifiedAt: new Date().toISOString(),
              identifierType: 'generic-content',
              score: scoreResult.score,
              classification: scoreResult.classification,
              status: 'candidate',
            });
          }
        } catch {
          // Skip sessions that fail to load
        }
      }

      return newResults.length > 0 ? idStore.add(newResults) : [];
    } catch (err) {
      console.error('[GenericContentIdentifier] Discovery failed:', err);
      return [];
    }
  }

  /**
   * Resolve a specific assistant message as a knowledge candidate.
   * Validates that the message exists and has enough content.
   */
  async resolve(
    project: string,
    sessionId: string,
    lineIndex: number,
    extra?: Record<string, any>,
  ): Promise<IdentificationResult | null> {
    const idStore = getIdentificationStore();

    // Check if already identified at this exact location
    if (idStore.hasIdentification('generic-content', sessionId, lineIndex)) {
      // Return existing
      const all = idStore.list({ identifierType: 'generic-content', sessionId });
      return all.find(r => r.lineIndex === lineIndex) || null;
    }

    // Load the message to validate it exists
    const content = await this.loadAssistantMessage(project, sessionId, lineIndex);
    if (!content) return null;

    // Must have enough content to be meaningful
    if (content.text.length < 100) return null;

    // Score the content (for manual resolve, we still accept even low-confidence)
    const scoreResult = scoreKnowledgeCandidate(content.text);

    const result: Omit<IdentificationResult, 'id'> = {
      sessionId,
      lineIndex,
      turnIndex: content.turnIndex,
      projectPath: project,
      timestamp: content.timestamp || new Date().toISOString(),
      identifiedAt: new Date().toISOString(),
      identifierType: 'generic-content',
      score: scoreResult.score,
      classification: scoreResult.classification,
      status: 'candidate',
    };

    const added = idStore.add([result]);
    return added[0] || null;
  }

  /**
   * Load an assistant message from a session by line index.
   * Uses the session cache which stores responses and userPrompts separately.
   */
  private async loadAssistantMessage(
    project: string,
    sessionId: string,
    lineIndex: number,
  ): Promise<{ text: string; turnIndex: number; timestamp?: string } | null> {
    try {
      const { getSessionReader } = require('../../session-reader');
      const { getSessionCache } = require('../../session-cache');

      const reader = getSessionReader();
      const cache = getSessionCache();

      if (cache.isWarming()) {
        await cache.waitForWarming();
      }

      const filePath = reader.getSessionFilePath(sessionId, project);
      const data = await cache.getSessionData(filePath);
      if (!data) return null;

      // Session cache stores assistant messages in `responses` and user messages in `userPrompts`
      // Both have { lineIndex, turnIndex, text } fields
      const allMessages = [
        ...(data.responses || []),
        ...(data.userPrompts || []),
      ];

      // Find by exact lineIndex match
      const targetMsg = allMessages.find(msg => msg.lineIndex === lineIndex);
      if (!targetMsg || !targetMsg.text) return null;

      return {
        text: targetMsg.text,
        turnIndex: targetMsg.turnIndex,
        timestamp: (targetMsg as any).timestamp,
      };
    } catch {
      return null;
    }
  }
}
