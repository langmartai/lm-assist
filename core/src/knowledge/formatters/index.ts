/**
 * Formatter Registry
 *
 * Central registry for all knowledge formatter implementations.
 */

import type { KnowledgeFormatter, IdentifierType } from '../identifier-types';
import { ExploreAgentFormatter } from './explore-agent';
import { GenericContentFormatter } from './generic-content';

const formatters = new Map<IdentifierType, KnowledgeFormatter>();

function ensureRegistered(): void {
  if (formatters.size > 0) return;
  const exploreAgent = new ExploreAgentFormatter();
  const genericContent = new GenericContentFormatter();
  formatters.set(exploreAgent.identifierType, exploreAgent);
  formatters.set(genericContent.identifierType, genericContent);
}

/**
 * Get a formatter for a specific identifier type.
 */
export function getFormatter(identifierType: IdentifierType): KnowledgeFormatter {
  ensureRegistered();
  const formatter = formatters.get(identifierType);
  if (!formatter) {
    throw new Error(`No formatter registered for identifier type: ${identifierType}`);
  }
  return formatter;
}

/**
 * Get all registered formatters.
 */
export function getAllFormatters(): KnowledgeFormatter[] {
  ensureRegistered();
  return Array.from(formatters.values());
}
