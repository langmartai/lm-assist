/**
 * Knowledge Deduplication
 *
 * Provides content similarity detection for knowledge entries using:
 * 1. Normalized title matching — catches identical/near-identical explore prompts
 * 2. Embedding cosine similarity — catches summaries, rephrased content, partial overlaps
 *
 * Used by:
 * - Discovery phase: within-batch dedup (group candidates, pick most complete)
 * - Generation phase: cross-session dedup (mark old entries as outdated)
 */

import { getKnowledgeStore } from './store';
import type { Knowledge } from './types';

// ─── Title Normalization ──────────────────────────────────────────────────

/**
 * Normalize a title for comparison: lowercase, collapse whitespace, strip punctuation.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, '')  // strip punctuation
    .replace(/\s+/g, ' ')     // collapse whitespace
    .trim();
}

// ─── Cosine Similarity ──────────────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 * Assumes unit vectors (already L2-normalized by the embedder).
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Compute embedding-based similarity between two texts.
 * Returns a score between 0 and 1 (1 = identical).
 */
export async function computeSimilarity(text1: string, text2: string): Promise<number> {
  const { getEmbedder } = require('../vector/embedder');
  const embedder = getEmbedder();
  await embedder.load();

  const [vec1, vec2] = await embedder.embedBatch([
    text1.slice(0, 2000),
    text2.slice(0, 2000),
  ]);

  return cosineSimilarity(vec1, vec2);
}

// ─── Duplicate Detection ──────────────────────────────────────────────────

export interface DuplicateMatch {
  id: string;
  title: string;
  similarity: number;
  reason: 'title-match' | 'content-similar';
  sourceTimestamp?: string;
  sourceSessionId?: string;
}

// Thresholds
const CONTENT_SIMILARITY_THRESHOLD = 0.82;

/**
 * Find existing knowledge entries that are duplicates of the given content.
 * Uses normalized title matching + embedding similarity.
 *
 * @param title - Title of the new knowledge
 * @param content - Full text content of the new knowledge (used for embedding)
 * @param project - Project path to scope the search
 * @returns Array of duplicate matches, sorted by similarity (highest first)
 */
export async function findDuplicateKnowledge(
  title: string,
  content: string,
  project: string,
): Promise<DuplicateMatch[]> {
  const store = getKnowledgeStore();
  const matches: DuplicateMatch[] = [];
  const seenIds = new Set<string>();

  // Phase 1: Normalized title matching against index
  const normalizedNew = normalizeTitle(title);
  const index = store.getIndex();

  for (const [id, meta] of Object.entries(index.knowledges)) {
    if (meta.project !== project) continue;
    if (meta.origin === 'remote') continue;
    if (meta.status === 'outdated' || meta.status === 'archived') continue;
    // Only match against explore-agent entries (cross-session dedup doesn't apply to generic content)
    if (!meta.sourceAgentId) continue;

    if (normalizeTitle(meta.title) === normalizedNew) {
      matches.push({
        id,
        title: meta.title,
        similarity: 1.0,
        reason: 'title-match',
        sourceTimestamp: meta.sourceTimestamp,
        sourceSessionId: meta.sourceSessionId,
      });
      seenIds.add(id);
    }
  }

  // Phase 2: Embedding similarity search via vector store
  try {
    const { getVectorStore } = require('../vector/vector-store');
    const vectorStore = getVectorStore();

    if (vectorStore.isInitialized()) {
      // Combine title + content for embedding (matches how knowledge vectors are indexed)
      const queryText = `${title}: ${content}`.slice(0, 2000);
      const results = await vectorStore.search(queryText, 10, { type: 'knowledge' });

      for (const result of results) {
        const knowledgeId = result.metadata?.knowledgeId;
        if (!knowledgeId || seenIds.has(knowledgeId)) continue;

        // Verify it's in the same project, is active, and is an explore-agent entry
        const meta = index.knowledges[knowledgeId];
        if (!meta || meta.project !== project) continue;
        if (meta.origin === 'remote') continue;
        if (meta.status === 'outdated' || meta.status === 'archived') continue;
        if (!meta.sourceAgentId) continue;

        if (result.score >= CONTENT_SIMILARITY_THRESHOLD) {
          matches.push({
            id: knowledgeId,
            title: meta.title,
            similarity: result.score,
            reason: 'content-similar',
            sourceTimestamp: meta.sourceTimestamp,
            sourceSessionId: meta.sourceSessionId,
          });
          seenIds.add(knowledgeId);
        }
      }
    }
  } catch {
    // Vector store not available — title matching is still active
  }

  // Sort by similarity descending
  matches.sort((a, b) => b.similarity - a.similarity);
  return matches;
}

// ─── Outdating ──────────────────────────────────────────────────

/**
 * Mark existing knowledge entries as outdated, replaced by a newer entry.
 * Returns the IDs that were marked outdated.
 */
export function markDuplicatesAsOutdated(
  duplicateIds: string[],
  replacedById?: string,
): string[] {
  const store = getKnowledgeStore();
  const marked: string[] = [];

  for (const id of duplicateIds) {
    try {
      const existing = store.getKnowledge(id);
      if (!existing || existing.status === 'outdated') continue;

      store.updateKnowledge(id, { status: 'outdated' });

      // Add a comment explaining why it was outdated
      if (replacedById) {
        store.addComment({
          knowledgeId: id,
          type: 'outdated',
          content: `Superseded by ${replacedById} (newer version of same content)`,
          source: 'llm',
        });
      }

      marked.push(id);
    } catch {
      // Best effort
    }
  }

  return marked;
}

// ─── Within-Batch Dedup ──────────────────────────────────────────────────

/**
 * Group candidates by normalized title, keeping only the most complete per group.
 * Returns the filtered array with duplicates removed.
 *
 * @param candidates - Array of items with a title and a content-length indicator
 * @param getTitle - Function to extract title from candidate
 * @param getContentLength - Function to get content length (for "most complete" selection)
 * @returns Filtered array with one candidate per normalized title group
 */
export function deduplicateBatch<T>(
  candidates: T[],
  getTitle: (item: T) => string,
  getContentLength: (item: T) => number,
): T[] {
  const groups = new Map<string, { best: T; bestLength: number }>();

  for (const candidate of candidates) {
    const normalized = normalizeTitle(getTitle(candidate));
    const length = getContentLength(candidate);

    const existing = groups.get(normalized);
    if (!existing || length > existing.bestLength) {
      groups.set(normalized, { best: candidate, bestLength: length });
    }
  }

  return Array.from(groups.values()).map(g => g.best);
}

// ─── Cleanup Existing Duplicates ──────────────────────────────────────────

export interface CleanupResult {
  groups: Array<{
    normalizedTitle: string;
    kept: string;
    outdated: string[];
    reason: 'title-match' | 'content-similar';
  }>;
  totalOutdated: number;
}

/**
 * Scan all existing knowledge and mark duplicates as outdated.
 * For each group of entries with the same normalized title (explore agents only),
 * keeps the most recent one and marks the rest as outdated.
 *
 * Also uses embedding similarity to find content-similar entries with different titles.
 *
 * @param project - If provided, only scan entries in this project
 * @param dryRun - If true, return what would be outdated without making changes
 */
export async function cleanupExistingDuplicates(
  project?: string,
  dryRun = false,
): Promise<CleanupResult> {
  const store = getKnowledgeStore();
  const index = store.getIndex();
  const result: CleanupResult = { groups: [], totalOutdated: 0 };

  // Phase 1: Group by normalized title (explore agents only)
  const titleGroups = new Map<string, Array<{ id: string; title: string; sourceTimestamp?: string; partCount: number }>>();

  for (const [id, meta] of Object.entries(index.knowledges)) {
    if (project && meta.project !== project) continue;
    if (meta.origin === 'remote') continue;
    if (meta.status === 'outdated' || meta.status === 'archived') continue;
    // Only dedup explore-agent entries (have sourceAgentId)
    if (!meta.sourceAgentId) continue;

    const normalized = normalizeTitle(meta.title);
    const group = titleGroups.get(normalized) || [];
    group.push({
      id,
      title: meta.title,
      sourceTimestamp: meta.sourceTimestamp,
      partCount: meta.partCount,
    });
    titleGroups.set(normalized, group);
  }

  // For each group with > 1 entry, keep the best (newest timestamp, then most parts)
  for (const [normalizedTitle, entries] of titleGroups) {
    if (entries.length <= 1) continue;

    // Sort: newest first, then most parts
    entries.sort((a, b) => {
      // Prefer most recent timestamp
      const ta = a.sourceTimestamp || '';
      const tb = b.sourceTimestamp || '';
      if (ta !== tb) return tb.localeCompare(ta);
      // Tiebreak: most parts (most complete)
      return b.partCount - a.partCount;
    });

    const kept = entries[0];
    const toOutdate = entries.slice(1);

    if (!dryRun) {
      for (const entry of toOutdate) {
        store.updateKnowledge(entry.id, { status: 'outdated' });
        store.addComment({
          knowledgeId: entry.id,
          type: 'outdated',
          content: `Superseded by ${kept.id} (newer version of "${kept.title}")`,
          source: 'llm',
        });
      }
    }

    result.groups.push({
      normalizedTitle,
      kept: kept.id,
      outdated: toOutdate.map(e => e.id),
      reason: 'title-match',
    });
    result.totalOutdated += toOutdate.length;
  }

  // Phase 2: Embedding-based similarity for entries with different titles
  try {
    const { getVectorStore } = require('../vector/vector-store');
    const vectorStore = getVectorStore();

    if (vectorStore.isInitialized()) {
      // Get all remaining active explore-agent entries (not already outdated by Phase 1)
      const outdatedSet = new Set<string>();
      for (const group of result.groups) {
        for (const id of group.outdated) outdatedSet.add(id);
      }

      const activeEntries: Array<{ id: string; title: string; sourceTimestamp?: string; partCount: number; project: string }> = [];
      for (const [id, meta] of Object.entries(index.knowledges)) {
        if (project && meta.project !== project) continue;
        if (meta.origin === 'remote') continue;
        if (meta.status === 'outdated' || meta.status === 'archived') continue;
        if (!meta.sourceAgentId) continue;
        if (outdatedSet.has(id)) continue;
        activeEntries.push({
          id,
          title: meta.title,
          sourceTimestamp: meta.sourceTimestamp,
          partCount: meta.partCount,
          project: meta.project,
        });
      }

      // For each active entry, search for similar entries via vector store
      const processedPairs = new Set<string>();
      for (const entry of activeEntries) {
        if (outdatedSet.has(entry.id)) continue;

        const results = await vectorStore.search(`${entry.title}`, 5, { type: 'knowledge' });

        for (const hit of results) {
          const hitId = hit.metadata?.knowledgeId;
          if (!hitId || hitId === entry.id || outdatedSet.has(hitId)) continue;

          // Avoid processing same pair twice
          const pairKey = [entry.id, hitId].sort().join(':');
          if (processedPairs.has(pairKey)) continue;
          processedPairs.add(pairKey);

          // Must be in same project, must be explore-agent
          const hitMeta = index.knowledges[hitId];
          if (!hitMeta || hitMeta.project !== entry.project) continue;
          if (!hitMeta.sourceAgentId) continue;
          if (hitMeta.status === 'outdated' || hitMeta.status === 'archived') continue;

          // Must be similar enough
          if (hit.score < CONTENT_SIMILARITY_THRESHOLD) continue;

          // Don't match if titles are too different (avoid false positives)
          if (normalizeTitle(entry.title) === normalizeTitle(hitMeta.title)) continue; // already handled in Phase 1

          // Keep the newer one, outdate the older
          const entryTs = entry.sourceTimestamp || '';
          const hitTs = hitMeta.sourceTimestamp || '';
          const [keepEntry, outdateEntry] = entryTs >= hitTs
            ? [entry, { id: hitId, title: hitMeta.title }]
            : [{ id: hitId, title: hitMeta.title, sourceTimestamp: hitTs }, entry];

          if (!dryRun) {
            store.updateKnowledge(outdateEntry.id, { status: 'outdated' });
            store.addComment({
              knowledgeId: outdateEntry.id,
              type: 'outdated',
              content: `Superseded by ${keepEntry.id} (content similarity: ${(hit.score * 100).toFixed(0)}%)`,
              source: 'llm',
            });
          }

          outdatedSet.add(outdateEntry.id);
          result.groups.push({
            normalizedTitle: `${entry.title} ↔ ${hitMeta.title}`,
            kept: keepEntry.id,
            outdated: [outdateEntry.id],
            reason: 'content-similar',
          });
          result.totalOutdated++;
        }
      }
    }
  } catch (err) {
    console.warn('[dedup] Embedding-based cleanup failed:', err);
  }

  return result;
}
