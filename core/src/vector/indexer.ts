/**
 * Indexer Module
 *
 * Extracts embeddable content from Milestones and Knowledge documents,
 * chunks into vectors with metadata for storage in VectraStore.
 *
 * Vector types (no session vectors — milestones subsume sessions):
 *
 * Milestone vectors (primary search target):
 *   - Milestone title (1 per milestone)
 *   - Milestone facts (~3 per milestone)
 *   - User prompts in range (~1 per milestone)
 *
 * Knowledge vectors (curated implementation truth):
 *   - 1 vector per knowledge part (title + summary)
 */

import type { Milestone } from '../milestone/types';
import type { Knowledge } from '../knowledge/types';
import type { VectorMetadata } from './vectra-store';

// ─── Types ──────────────────────────────────────────────────

export interface IndexableItem {
  text: string;
  metadata: VectorMetadata;
}

// ─── Milestone Indexing ──────────────────────────────────────────────────

/**
 * Extract indexable items from a milestone
 */
export function extractMilestoneVectors(
  milestone: Milestone,
  projectPath?: string
): IndexableItem[] {
  const items: IndexableItem[] = [];

  const baseMeta = {
    type: 'milestone' as const,
    sessionId: milestone.sessionId,
    milestoneIndex: milestone.index,
    projectPath,
    timestamp: milestone.endTimestamp || milestone.startTimestamp,
    phase: milestone.phase,
  };

  // 1. Milestone title (highest value vector)
  if (milestone.title) {
    items.push({
      text: milestone.title,
      metadata: { ...baseMeta, contentType: 'title', text: milestone.title },
    });
  }

  // 2. Milestone facts (self-contained statements, great for search)
  if (milestone.facts && milestone.facts.length > 0) {
    for (const fact of milestone.facts) {
      items.push({
        text: fact,
        metadata: { ...baseMeta, contentType: 'fact', text: fact },
      });
    }
  }

  // 3. User prompts in range (combined into one vector)
  if (milestone.userPrompts.length > 0) {
    const promptText = milestone.userPrompts
      .map(p => p.length > 300 ? p.slice(0, 300) : p)
      .join(' | ');
    items.push({
      text: promptText,
      metadata: { ...baseMeta, contentType: 'prompt', text: promptText },
    });
  }

  // 4. If Phase 1 only (no title/facts), create a combined summary vector
  if (!milestone.title && !milestone.facts) {
    const parts: string[] = [];
    if (milestone.userPrompts.length > 0) {
      parts.push(milestone.userPrompts[0]);
    }
    if (milestone.filesModified.length > 0) {
      parts.push('Files: ' + milestone.filesModified.slice(0, 5).join(', '));
    }
    if (milestone.taskCompletions.length > 0) {
      parts.push('Tasks: ' + milestone.taskCompletions.join(', '));
    }
    if (parts.length > 0) {
      const summaryText = parts.join('. ');
      items.push({
        text: summaryText,
        metadata: { ...baseMeta, contentType: 'summary', text: summaryText },
      });
    }
  }

  return items;
}

// ─── Knowledge Indexing ──────────────────────────────────────────────────

/**
 * Extract indexable items from a knowledge document.
 * Creates:
 *   - 1 vector per part (title + summary as embedding text)
 */
export function extractKnowledgeVectors(
  knowledge: Knowledge,
  projectPath?: string
): IndexableItem[] {
  const items: IndexableItem[] = [];

  const baseMeta = {
    type: 'knowledge' as const,
    sessionId: knowledge.id,  // Use knowledgeId — knowledge is not session-bound but sessionId must be non-empty
    knowledgeId: knowledge.id,
    projectPath: projectPath || knowledge.project,
    timestamp: knowledge.updatedAt,
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
