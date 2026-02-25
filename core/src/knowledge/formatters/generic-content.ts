/**
 * Generic Content Formatter
 *
 * Transforms a generic-content identification into a Knowledge document.
 * Loads the assistant message, derives title from content headings or
 * first line, splits into parts, detects type.
 */

import type { KnowledgeFormatter, IdentificationResult, FormatResult } from '../identifier-types';
import { splitIntoParts, detectType, extractSummaryAndContent } from '../helpers';

export class GenericContentFormatter implements KnowledgeFormatter {
  readonly identifierType = 'generic-content' as const;

  /**
   * Format a generic-content identification into knowledge parts.
   * Loads the original assistant message using sessionId + lineIndex.
   *
   * @param identification The identification result
   */
  async format(identification: IdentificationResult): Promise<FormatResult> {
    const content = await this.loadContent(
      identification.projectPath,
      identification.sessionId,
      identification.lineIndex,
    );

    if (!content) {
      throw new Error(
        `Content not found at session ${identification.sessionId} line ${identification.lineIndex}`,
      );
    }

    if (content.text.length < 100) {
      throw new Error('Content too short to generate knowledge');
    }

    // Derive title from content
    const title = this.deriveTitleFromContent(content.text);

    // Split into parts using shared helper
    const parts = splitIntoParts(content.text);
    if (parts.length === 0) {
      // Fallback: treat entire content as a single part
      const { summary, content: body } = extractSummaryAndContent(content.text);
      parts.push({
        partId: 'TEMP.1',
        title: 'Overview',
        summary: summary || content.text.slice(0, 200).trim(),
        content: body,
      });
    }

    // Detect knowledge type
    const type = detectType(title, parts);

    return {
      title,
      type,
      parts,
      sourceTimestamp: content.timestamp,
    };
  }

  /**
   * Derive a title from the content itself.
   * Looks for:
   * 1. A # heading on the first non-empty line
   * 2. A ## heading early in the content
   * 3. Falls back to first line of text
   */
  private deriveTitleFromContent(text: string): string {
    const lines = text.split('\n');

    // Skip leading empty lines
    let firstLineIdx = 0;
    while (firstLineIdx < lines.length && lines[firstLineIdx].trim() === '') {
      firstLineIdx++;
    }

    if (firstLineIdx >= lines.length) return 'Untitled';

    const firstLine = lines[firstLineIdx].trim();

    // Check for # heading
    const h1Match = firstLine.match(/^#\s+(.+)$/);
    if (h1Match) {
      return this.cleanTitle(h1Match[1]);
    }

    // Check for ## heading in first few lines
    for (let i = firstLineIdx; i < Math.min(firstLineIdx + 5, lines.length); i++) {
      const h2Match = lines[i].trim().match(/^##\s+(.+)$/);
      if (h2Match) {
        return this.cleanTitle(h2Match[1]);
      }
    }

    // Fallback: use first line of text
    return this.cleanTitle(firstLine);
  }

  /**
   * Clean a title string — remove markdown formatting, truncate.
   */
  private cleanTitle(title: string): string {
    let cleaned = title
      .replace(/\*\*/g, '')       // Remove bold
      .replace(/`/g, '')          // Remove backticks
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // Convert links to text
      .trim();

    // Capitalize first letter
    if (cleaned.length > 0) {
      cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }

    // Truncate if too long
    if (cleaned.length > 120) {
      cleaned = cleaned.slice(0, 117) + '...';
    }

    // Remove trailing period
    if (cleaned.endsWith('.')) {
      cleaned = cleaned.slice(0, -1);
    }

    return cleaned || 'Untitled';
  }

  /**
   * Load the assistant message content from a session.
   * Searches both responses (assistant) and userPrompts arrays in the session cache.
   */
  private async loadContent(
    project: string,
    sessionId: string,
    lineIndex: number,
  ): Promise<{ text: string; timestamp?: string } | null> {
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
      // Search responses first (most common target), then userPrompts
      const allMessages = [
        ...(data.responses || []),
        ...(data.userPrompts || []),
      ];

      // Find by exact lineIndex match
      const targetMsg = allMessages.find(msg => msg.lineIndex === lineIndex);
      if (!targetMsg || !targetMsg.text) return null;

      return {
        text: targetMsg.text,
        timestamp: (targetMsg as any).timestamp,
      };
    } catch {
      return null;
    }
  }
}
