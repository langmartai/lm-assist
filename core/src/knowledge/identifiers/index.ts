/**
 * Identifier Registry
 *
 * Central registry for all knowledge identifier implementations.
 */

import type { KnowledgeIdentifier, IdentifierType } from '../identifier-types';
import { ExploreAgentIdentifier } from './explore-agent';
import { GenericContentIdentifier } from './generic-content';

const identifiers = new Map<IdentifierType, KnowledgeIdentifier>();

function ensureRegistered(): void {
  if (identifiers.size > 0) return;
  const exploreAgent = new ExploreAgentIdentifier();
  const genericContent = new GenericContentIdentifier();
  identifiers.set(exploreAgent.type, exploreAgent);
  identifiers.set(genericContent.type, genericContent);
}

/**
 * Get a specific identifier by type.
 */
export function getIdentifier(type: IdentifierType): KnowledgeIdentifier {
  ensureRegistered();
  const identifier = identifiers.get(type);
  if (!identifier) {
    throw new Error(`Unknown identifier type: ${type}`);
  }
  return identifier;
}

/**
 * Get all registered identifiers.
 */
export function getAllIdentifiers(): KnowledgeIdentifier[] {
  ensureRegistered();
  return Array.from(identifiers.values());
}
