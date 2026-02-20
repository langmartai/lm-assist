/**
 * Composite Scorer
 *
 * Multi-signal re-ranking for search results that combines Vectra cosine
 * similarity with contextual signals (recency, quality, affinity).
 */

export interface ScoredResult {
  type: 'milestone' | 'session' | 'knowledge';
  id: string;           // milestoneId, sessionId, or knowledgeId/partId
  sessionId: string;
  score: number;        // raw Vectra cosine similarity (0-1)
  finalScore: number;   // after re-ranking
  timestamp: string;    // for recency
  phase?: 1 | 2;       // milestone phase (for quality signal)
  projectPath?: string; // for affinity
  knowledgeId?: string; // for knowledge results
  partId?: string;      // for knowledge part results
  machineId?: string;   // for remote knowledge results
}

export interface CompositeScoreOptions {
  currentProject?: string;    // current session's project for affinity boost
  parentSessionId?: string;   // parent session for parent/child affinity
}

export function compositeScore(results: ScoredResult[], options: CompositeScoreOptions = {}): ScoredResult[] {
  // Apply scoring adjustments
  for (const r of results) {
    let multiplier = 1.0;

    // 1. Milestone preference: 1.5x for milestone results, 1.4x for knowledge (curated)
    if (r.type === 'milestone') {
      multiplier *= 1.5;
    } else if (r.type === 'knowledge') {
      multiplier *= 1.4;
    }

    // 2. Recency boost
    const ts = new Date(r.timestamp).getTime();
    const ageMs = isNaN(ts) ? Infinity : Date.now() - ts;
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours < 1) multiplier *= 2.0;
    else if (ageHours < 6) multiplier *= 1.5;
    else if (ageHours < 24) multiplier *= 1.3;
    else if (ageHours < 72) multiplier *= 1.1;

    // 3. Quality: has LLM summary (phase 2) → 1.3x boost
    if (r.phase === 2) {
      multiplier *= 1.3;
    }

    // 4. Affinity: same project +20%, parent/child +40%
    if (options.currentProject && r.projectPath === options.currentProject) {
      multiplier *= 1.2;
    }
    if (options.parentSessionId && r.sessionId === options.parentSessionId) {
      multiplier *= 1.4;
    }

    r.finalScore = r.score * multiplier;
  }

  // Deduplication: if both a milestone and its parent session match, keep only the milestone
  const milestoneSessionIds = new Set<string>();
  for (const r of results) {
    if (r.type === 'milestone') {
      milestoneSessionIds.add(r.sessionId);
    }
  }
  const deduped = results.filter(r => {
    if (r.type === 'session' && milestoneSessionIds.has(r.sessionId)) {
      return false;  // Remove session result when milestone exists
    }
    return true;
  });

  // Sort by finalScore descending
  deduped.sort((a, b) => b.finalScore - a.finalScore);

  return deduped;
}
