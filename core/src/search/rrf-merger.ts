/**
 * Reciprocal Rank Fusion (RRF) Merger
 *
 * Merges Vectra (semantic) and BM25 (lexical) result lists into a single
 * ranked list. Documents appearing in both lists get boosted; documents
 * in only one list still surface.
 *
 * RRF formula: score = vectraWeight/(k + rank_vectra) + bm25Weight/(k + rank_bm25)
 */

import type { ScoredResult } from './composite-scorer';
import type { BM25SearchResult } from './bm25-scorer';

export interface RRFOptions {
  k?: number;            // RRF constant (default: 60)
  vectraWeight?: number; // Weight for semantic signal (default: 1.0)
  bm25Weight?: number;   // Weight for lexical signal (default: 0.8)
}

export function reciprocalRankFusion(
  vectraResults: ScoredResult[],
  bm25Results: BM25SearchResult[],
  opts?: RRFOptions,
): ScoredResult[] {
  const k = opts?.k ?? 60;
  const vectraWeight = opts?.vectraWeight ?? 1.0;
  const bm25Weight = opts?.bm25Weight ?? 0.8;

  // Build 1-indexed rank maps
  const vectraRank = new Map<string, number>();
  for (let i = 0; i < vectraResults.length; i++) {
    vectraRank.set(vectraResults[i].id, i + 1);
  }

  const bm25Rank = new Map<string, number>();
  for (let i = 0; i < bm25Results.length; i++) {
    bm25Rank.set(bm25Results[i].id, i + 1);
  }

  // Index for quick lookup
  const vectraMap = new Map<string, ScoredResult>();
  for (const r of vectraResults) vectraMap.set(r.id, r);

  const bm25Map = new Map<string, BM25SearchResult>();
  for (const r of bm25Results) bm25Map.set(r.id, r);

  // Collect all unique IDs
  const allIds = new Set<string>([...vectraRank.keys(), ...bm25Rank.keys()]);

  const merged: ScoredResult[] = [];

  for (const id of allIds) {
    const vRank = vectraRank.get(id);
    const bRank = bm25Rank.get(id);

    let rrfScore = 0;
    if (vRank !== undefined) rrfScore += vectraWeight / (k + vRank);
    if (bRank !== undefined) rrfScore += bm25Weight / (k + bRank);

    // Use existing ScoredResult if from Vectra, otherwise create stub from BM25
    const existing = vectraMap.get(id);
    if (existing) {
      merged.push({ ...existing, score: rrfScore, finalScore: 0 });
    } else {
      const bm25 = bm25Map.get(id)!;
      merged.push({
        type: bm25.type,
        id,
        sessionId: bm25.sessionId,
        score: rrfScore,
        finalScore: 0,
        timestamp: bm25.timestamp,
        knowledgeId: bm25.knowledgeId,
        partId: bm25.partId,
        projectPath: bm25.projectPath,
        phase: bm25.phase as 1 | 2 | undefined,
      });
    }
  }

  merged.sort((a, b) => b.score - a.score);
  return merged;
}
