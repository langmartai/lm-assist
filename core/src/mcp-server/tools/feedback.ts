/**
 * feedback tool — General-purpose context quality feedback
 *
 * Replaces knowledge_comment with a broader feedback mechanism that works
 * on any context source: knowledge parts, milestones, architecture, etc.
 *
 * Feedback drives a backend review process that converts comments into actions:
 *   - outdated: mark for review, flag in future results
 *   - wrong: suppress from suggestions until reviewed
 *   - irrelevant: reduce ranking weight for similar queries
 *   - needs_update: queue for update, show with annotation
 *   - useful: boost ranking weight for similar queries
 */

import { getKnowledgeStore } from '../../knowledge/store';
import type { KnowledgeCommentType } from '../../knowledge/types';

// ─── Tool Definition (canonical source: definitions.ts) ─────────────

export { feedbackToolDef } from './definitions';

// ─── Feedback Types ──────────────────────────────────────────────────

const FEEDBACK_TYPES = ['outdated', 'wrong', 'irrelevant', 'needs_update', 'useful'] as const;
type FeedbackType = typeof FEEDBACK_TYPES[number];

// Map feedback types to knowledge comment types where possible
const FEEDBACK_TO_COMMENT: Record<FeedbackType, KnowledgeCommentType> = {
  'outdated': 'outdated',
  'wrong': 'update',       // "wrong" maps to "update" (needs correction)
  'irrelevant': 'remove',  // "irrelevant" maps to "remove"
  'needs_update': 'update',
  'useful': 'general',     // positive feedback stored as general comment
};

// ─── ID Detection ──────────────────────────────────────────────────

function detectSourceType(id: string): 'knowledge_part' | 'knowledge_doc' | 'milestone' | 'unknown' {
  if (/^K\d+\.\d+$/.test(id)) return 'knowledge_part';
  if (/^K\d+$/.test(id)) return 'knowledge_doc';
  // milestone ID: sessionId:index (8+ hex chars with colon and number)
  if (/^[0-9a-f-]{8,}:\d+$/i.test(id)) return 'milestone';
  return 'unknown';
}

// ─── Handler ──────────────────────────────────────────────────

export async function handleFeedback(args: Record<string, unknown>): Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  const id = String(args.id || '').trim();
  const feedbackType = args.type as FeedbackType;
  const feedbackContent = String(args.content || '');

  if (!id) {
    return { content: [{ type: 'text', text: 'Error: id is required' }] };
  }
  if (!feedbackType || !FEEDBACK_TYPES.includes(feedbackType)) {
    return { content: [{ type: 'text', text: `Error: type must be one of: ${FEEDBACK_TYPES.join(', ')}` }] };
  }
  if (!feedbackContent) {
    return { content: [{ type: 'text', text: 'Error: content is required' }] };
  }

  const sourceType = detectSourceType(id);

  // Handle knowledge feedback via knowledge store
  if (sourceType === 'knowledge_part' || sourceType === 'knowledge_doc') {
    return handleKnowledgeFeedback(id, sourceType, feedbackType, feedbackContent);
  }

  // Handle milestone feedback
  if (sourceType === 'milestone') {
    return handleMilestoneFeedback(id, feedbackType, feedbackContent);
  }

  // Unknown source type — store as milestone-style feedback so it's not lost
  const store = getKnowledgeStore();
  const comment = store.addComment({
    knowledgeId: 'GENERAL_FEEDBACK',
    type: FEEDBACK_TO_COMMENT[feedbackType],
    content: `[${id}] ${feedbackContent}`,
    source: 'llm',
  });

  return {
    content: [{
      type: 'text',
      text: `Feedback recorded for ${id} (${feedbackType}, comment #${comment.id}).\n` +
        `Note: Source type could not be determined. Stored for manual review.`,
    }],
  };
}

// ─── Knowledge Feedback ──────────────────────────────────────────────────

function handleKnowledgeFeedback(
  id: string,
  sourceType: 'knowledge_part' | 'knowledge_doc',
  feedbackType: FeedbackType,
  feedbackContent: string,
): { content: Array<{ type: string; text: string }> } {
  const store = getKnowledgeStore();

  let knowledgeId: string;
  let partId: string | undefined;

  if (sourceType === 'knowledge_part') {
    // K001.2 → knowledgeId=K001, partId=K001.2
    const match = id.match(/^(K\d+)\.(\d+)$/);
    if (!match) {
      return { content: [{ type: 'text', text: `Invalid knowledge part ID: ${id}` }] };
    }
    knowledgeId = match[1];
    partId = id;
  } else {
    knowledgeId = id;
  }

  // Verify knowledge exists
  const knowledge = store.getKnowledge(knowledgeId);
  if (!knowledge) {
    return { content: [{ type: 'text', text: `Knowledge document ${knowledgeId} not found` }] };
  }

  // Verify part exists if specified
  if (partId) {
    const part = knowledge.parts.find(p => p.partId === partId);
    if (!part) {
      return { content: [{ type: 'text', text: `Part ${partId} not found in ${knowledgeId}` }] };
    }
  }

  const commentType = FEEDBACK_TO_COMMENT[feedbackType];
  const prefixedContent = feedbackType === 'useful'
    ? `[POSITIVE] ${feedbackContent}`
    : feedbackContent;

  const comment = store.addComment({
    knowledgeId,
    partId,
    type: commentType,
    content: prefixedContent,
    source: 'llm',
  });

  const partRef = partId ? ` on ${partId}` : '';
  return {
    content: [{
      type: 'text',
      text: `Feedback recorded on ${knowledgeId}${partRef} (${feedbackType} → ${commentType} comment #${comment.id}).\n` +
        `Your feedback will be reviewed and applied by the knowledge curation process.`,
    }],
  };
}

// ─── Milestone Feedback ──────────────────────────────────────────────────

function handleMilestoneFeedback(
  milestoneId: string,
  feedbackType: FeedbackType,
  feedbackContent: string,
): { content: Array<{ type: string; text: string }> } {
  // For milestones, we store feedback as a knowledge comment on a synthetic
  // "milestone-feedback" knowledge document. This leverages the existing
  // comment review infrastructure.
  //
  // In the future, milestone feedback could also adjust vector ranking weights.

  const store = getKnowledgeStore();

  // Try to find an existing milestone-feedback knowledge doc, or note that
  // milestone feedback is tracked separately
  const comment = store.addComment({
    knowledgeId: 'MILESTONE_FEEDBACK',
    type: FEEDBACK_TO_COMMENT[feedbackType],
    content: `[${milestoneId}] ${feedbackContent}`,
    source: 'llm',
  });

  return {
    content: [{
      type: 'text',
      text: `Feedback recorded for milestone ${milestoneId} (${feedbackType}, comment #${comment.id}).\n` +
        `Milestone feedback is tracked and reviewed by the curation process.`,
    }],
  };
}
