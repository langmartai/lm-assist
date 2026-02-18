/**
 * Indexer Module
 *
 * Extracts embeddable content from Milestones and Knowledge documents,
 * chunks into vectors with metadata for storage in VectraStore.
 *
 * Vector types (no session vectors — milestones subsume sessions):
 *
 * Milestone vectors (primary search target):
 *   Phase 2 (enriched):
 *     - title       — LLM-generated milestone title (1 per milestone)
 *     - fact        — LLM-generated facts (~3 per milestone)
 *     - prompt      — user messages in range (noise-filtered)
 *   Phase 1 only (no LLM enrichment yet):
 *     - prompt      — user messages in range (noise-filtered)
 *     - summary     — first meaningful prompt + file basenames + task completions
 *     - assistant   — assistant response text from startTurn→endTurn (when cacheData provided)
 *     - thinking    — thinking block content from startTurn→endTurn (when cacheData provided)
 *
 * Knowledge vectors (curated implementation truth):
 *   - knowledge_part — title + summary per part (1 per part)
 */

import * as path from 'path';
import type { Milestone } from '../milestone/types';
import type { Knowledge } from '../knowledge/types';
import type { VectorMetadata } from './vectra-store';

// ─── Noise Filtering ──────────────────────────────────────────────────

/** Patterns that indicate a prompt is a structural milestone label, not useful content */
const NOISY_LINE_RE = /^(p[12]|milestone\s*#?\d*|#\d+[\s–\-]*#?\d*|\d+\s+tools?)$/i;

/**
 * Returns true if a user prompt is purely structural noise (milestone labels, ranges, tool counts).
 * These come from the milestone boundary markers, not from real user intent.
 */
function isNoisyPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < 15) return true; // Too short to carry meaning
  // Check if all non-empty lines are noisy structural tokens
  const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 0 && lines.every(l => NOISY_LINE_RE.test(l))) return true;
  return false;
}

/** Truncate a file path to just its basename for cleaner vector text */
function toBasename(filePath: string): string {
  return path.basename(filePath);
}

// ─── Types ──────────────────────────────────────────────────

export interface IndexableItem {
  text: string;
  metadata: VectorMetadata;
}

/**
 * Minimal session data needed to extract assistant/thinking content for a turn range.
 * Structurally compatible with SessionCacheData — no import needed.
 */
export interface TurnRangeData {
  responses: Array<{ turnIndex: number; text: string; isApiError?: boolean }>;
  thinkingBlocks: Array<{ turnIndex: number; thinking: string }>;
}

// ─── Milestone Indexing ──────────────────────────────────────────────────

/**
 * Extract indexable items from a milestone
 */
export function extractMilestoneVectors(
  milestone: Milestone,
  projectPath?: string,
  cacheData?: TurnRangeData | null,
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

  // 3. User prompts in range (combined into one vector, skip noisy structural labels)
  const cleanPrompts = milestone.userPrompts
    .filter(p => !isNoisyPrompt(p))
    .map(p => p.length > 300 ? p.slice(0, 300) : p);
  if (cleanPrompts.length > 0) {
    const promptText = cleanPrompts.join(' | ');
    items.push({
      text: promptText,
      metadata: { ...baseMeta, contentType: 'prompt', text: promptText },
    });
  }

  // 4. If Phase 1 only (no title/facts), create enriched vectors from turn range content.
  // Uses basenames for files, filters noisy content, and pulls assistant/thinking from session cache.
  if (!milestone.title && !milestone.facts) {
    const parts: string[] = [];

    // First meaningful (non-noisy) prompt
    const firstMeaningful = milestone.userPrompts.find(p => !isNoisyPrompt(p));
    if (firstMeaningful) {
      parts.push(firstMeaningful.length > 200 ? firstMeaningful.slice(0, 200) : firstMeaningful);
    }

    // File basenames (avoid noisy full paths, skip common noise filenames)
    if (milestone.filesModified.length > 0) {
      const basenames = milestone.filesModified
        .slice(0, 8)
        .map(toBasename)
        .filter(b => b.length > 0);
      if (basenames.length > 0) {
        parts.push('Files: ' + basenames.join(', '));
      }
    }

    // Task completions (skip very short or purely numeric entries)
    if (milestone.taskCompletions.length > 0) {
      const tasks = milestone.taskCompletions
        .filter(t => t.trim().length > 5 && !/^\d+$/.test(t.trim()));
      if (tasks.length > 0) {
        parts.push('Tasks: ' + tasks.join(', '));
      }
    }

    if (parts.length > 0) {
      const summaryText = parts.join('. ');
      items.push({
        text: summaryText,
        metadata: { ...baseMeta, contentType: 'summary', text: summaryText },
      });
    }

    // Assistant responses in turn range — richer semantic content for Phase 1 search
    if (cacheData) {
      const MAX_CONTENT = 600;
      const { startTurn, endTurn } = milestone;

      const assistantParts = cacheData.responses
        .filter(r => r.turnIndex >= startTurn && r.turnIndex <= endTurn && !r.isApiError)
        .map(r => r.text.trim())
        .filter(t => t.length > 20);
      if (assistantParts.length > 0) {
        const assistantText = assistantParts.join(' ').slice(0, MAX_CONTENT);
        items.push({
          text: assistantText,
          metadata: { ...baseMeta, contentType: 'assistant', text: assistantText },
        });
      }

      const thinkingParts = cacheData.thinkingBlocks
        .filter(t => t.turnIndex >= startTurn && t.turnIndex <= endTurn)
        .map(t => t.thinking.trim())
        .filter(t => t.length > 20);
      if (thinkingParts.length > 0) {
        const thinkingText = thinkingParts.join(' ').slice(0, MAX_CONTENT);
        items.push({
          text: thinkingText,
          metadata: { ...baseMeta, contentType: 'thinking', text: thinkingText },
        });
      }
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
