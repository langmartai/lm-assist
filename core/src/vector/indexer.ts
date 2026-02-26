/**
 * Indexer Module
 *
 * Extracts embeddable content from Knowledge documents,
 * chunks into vectors with metadata for storage in VectorStore.
 *
 * Vector types:
 *
 * Knowledge vectors (curated implementation truth):
 *   - knowledge_part — title + summary per part (1 per part)
 */

import type { Knowledge } from '../knowledge/types';
import type { VectorMetadata } from './vector-store';

// ─── Types ──────────────────────────────────────────────────

export interface IndexableItem {
  text: string;
  metadata: VectorMetadata;
}

// ─── Knowledge Indexing ──────────────────────────────────────────────────

/**
 * Extract indexable items from a knowledge document.
 * Creates:
 *   - 1 vector per part (title + summary as embedding text)
 *
 * @param remoteOrigin When provided, marks vectors as remote with source machine metadata
 */
export function extractKnowledgeVectors(
  knowledge: Knowledge,
  projectPath?: string,
  remoteOrigin?: {
    machineId: string;
    machineHostname: string;
    machineOS: string;
  }
): IndexableItem[] {
  const items: IndexableItem[] = [];

  const baseMeta = {
    type: 'knowledge' as const,
    sessionId: knowledge.id,  // Use knowledgeId — knowledge is not session-bound but sessionId must be non-empty
    knowledgeId: knowledge.id,
    projectPath: projectPath || knowledge.project,
    timestamp: knowledge.updatedAt,
    origin: (remoteOrigin ? 'remote' : 'local') as 'local' | 'remote',
    machineId: remoteOrigin?.machineId || '',
    machineHostname: remoteOrigin?.machineHostname || '',
    machineOS: remoteOrigin?.machineOS || '',
  };

  // One vector per part — includes knowledge title for search context
  for (const part of knowledge.parts) {
    const partText = `${knowledge.title} [${knowledge.type}]: ${part.title} — ${part.summary}`;
    items.push({
      text: partText,
      metadata: {
        ...baseMeta,
        partId: part.partId,
        contentType: 'knowledge_part',
        text: partText,
      },
    });
  }

  return items;
}
