/**
 * Generic Content Identifier
 *
 * Resolves arbitrary assistant messages by sessionId + lineIndex.
 * Unlike explore-agent, this is manual-only (no auto-discovery) —
 * any assistant message could be knowledge, so we don't auto-scan.
 */

import type { KnowledgeIdentifier, IdentificationResult } from '../identifier-types';
import { getIdentificationStore } from '../identification-store';

export class GenericContentIdentifier implements KnowledgeIdentifier {
  readonly type = 'generic-content' as const;

  /**
   * Generic content has no auto-discovery — returns empty.
   * Knowledge from arbitrary messages is created manually via resolve().
   */
  async discover(_project: string): Promise<IdentificationResult[]> {
    return [];
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

    const result: Omit<IdentificationResult, 'id'> = {
      sessionId,
      lineIndex,
      turnIndex: content.turnIndex,
      projectPath: project,
      timestamp: content.timestamp || new Date().toISOString(),
      identifiedAt: new Date().toISOString(),
      identifierType: 'generic-content',
      status: 'candidate',
    };

    const added = idStore.add([result]);
    return added[0] || null;
  }

  /**
   * Load an assistant message from a session by line index.
   */
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
