/**
 * Session Search Routes
 *
 * Milestone-based search across indexed session milestones.
 * Replaces the old text scorer (which matched against raw session blobs)
 * with structured milestone search (title, description, facts, concepts).
 *
 * Endpoints:
 *   POST /session-search          Milestone keyword search (sync, fast)
 *   POST /session-search/vector   Vectra semantic search (when vectors are indexed)
 */

import type { RouteHandler, RouteContext } from '../index';
import { getMilestoneStore, isProjectExcluded } from '../../milestone/store';
import type { Milestone } from '../../milestone/types';
import { getVectraStore } from '../../vector/vectra-store';
import { compositeScore, type ScoredResult, type CompositeScoreOptions } from '../../search/composite-scorer';
import { getSessionCache } from '../../session-cache';

// ─── Types ──────────────────────────────────────────────────

type Scope = '24h' | '3d' | '7d' | '30d' | 'all';

interface SearchRequest {
  query: string;
  projectPath?: string;
  directory?: string;
  scope?: Scope;
  limit?: number;
}

interface MilestoneSearchResult {
  milestoneId: string;
  sessionId: string;
  milestoneIndex: number;
  title: string | null;
  type: string | null;
  description: string | null;
  outcome: string | null;
  facts: string[];
  concepts: string[];
  startTurn: number;
  endTurn: number;
  score: number;
  phase: 1 | 2;
  timestamp: string;
  filesModified: string[];
  userPrompts: string[];
}

// ─── Scope Helpers ──────────────────────────────────────────────────

const SCOPE_MS: Record<Scope, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  'all': Infinity,
};

function isWithinScope(timestamp: string | undefined, scope: Scope): boolean {
  if (scope === 'all') return true;
  if (!timestamp) return false;
  const ts = new Date(timestamp).getTime();
  if (isNaN(ts)) return false;
  return Date.now() - ts <= SCOPE_MS[scope];
}

// ─── Milestone Scoring ──────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s\-_.]/g, ' ').split(/\s+/).filter(t => t.length > 1);
}

/**
 * Score a field and track which query tokens were matched.
 */
function scoreFieldTracked(
  text: string | undefined | null,
  queryTokens: string[],
  queryLower: string,
  weight: number,
  matched: Set<string>
): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let score = 0;

  if (lower.includes(queryLower)) {
    score += 10 * weight;
    for (const t of queryTokens) matched.add(t);
  }

  for (const token of queryTokens) {
    if (lower.includes(token)) {
      score += weight;
      matched.add(token);
    }
  }

  return score;
}

/**
 * Score best match from array, tracking which tokens were matched.
 */
function scoreBestOfTracked(
  items: string[] | null | undefined,
  queryTokens: string[],
  queryLower: string,
  weight: number,
  matched: Set<string>
): number {
  if (!items || items.length === 0) return 0;
  let best = 0;
  for (const item of items) {
    const s = scoreFieldTracked(item, queryTokens, queryLower, weight, matched);
    if (s > best) best = s;
  }
  return best;
}

function scoreMilestone(
  milestone: Milestone,
  queryTokens: string[],
  queryLower: string
): number {
  const matched = new Set<string>();
  let score = 0;

  // Title (highest signal for milestones)
  score += scoreFieldTracked(milestone.title, queryTokens, queryLower, 8, matched);

  // Description
  score += scoreFieldTracked(milestone.description, queryTokens, queryLower, 4, matched);

  // Outcome
  score += scoreFieldTracked(milestone.outcome, queryTokens, queryLower, 3, matched);

  // Facts — best match only (prevents 20-fact milestones from dominating)
  score += scoreBestOfTracked(milestone.facts, queryTokens, queryLower, 3, matched);

  // Concepts — best match only
  score += scoreBestOfTracked(milestone.concepts, queryTokens, queryLower, 2, matched);

  // Type (e.g. searching for "bugfix" matches type directly)
  score += scoreFieldTracked(milestone.type, queryTokens, queryLower, 2, matched);

  // User prompts — best match only
  score += scoreBestOfTracked(milestone.userPrompts, queryTokens, queryLower, 1, matched);

  // Files modified — best match only
  score += scoreBestOfTracked(milestone.filesModified, queryTokens, queryLower, 1, matched);

  // Query coverage multiplier: penalize partial matches
  if (queryTokens.length > 1) {
    const coverage = matched.size / queryTokens.length;
    score *= coverage * coverage;
  }

  return score;
}

function applyBoosts(score: number, milestone: Milestone): number {
  let multiplier = 1.0;

  // Phase 2 quality boost
  if (milestone.phase === 2) {
    multiplier *= 1.3;
  }

  // Recency boost
  const ts = milestone.endTimestamp || milestone.startTimestamp;
  if (ts) {
    const ageMs = Date.now() - new Date(ts).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours < 1) multiplier *= 2.0;
    else if (ageHours < 6) multiplier *= 1.5;
    else if (ageHours < 24) multiplier *= 1.3;
    else if (ageHours < 72) multiplier *= 1.1;
  }

  return score * multiplier;
}

function toSearchResult(milestone: Milestone, score: number): MilestoneSearchResult {
  return {
    milestoneId: milestone.id,
    sessionId: milestone.sessionId,
    milestoneIndex: milestone.index,
    title: milestone.title,
    type: milestone.type,
    description: milestone.description,
    outcome: milestone.outcome,
    facts: milestone.facts || [],
    concepts: milestone.concepts || [],
    startTurn: milestone.startTurn,
    endTurn: milestone.endTurn,
    score,
    phase: milestone.phase,
    timestamp: milestone.endTimestamp || milestone.startTimestamp,
    filesModified: milestone.filesModified,
    userPrompts: milestone.userPrompts.map(p =>
      p.length > 150 ? p.slice(0, 150) + '...' : p
    ).slice(0, 3),
  };
}

// ─── Milestone Cache ──────────────────────────────────────────────────

let cachedMilestones: Milestone[] | null = null;
let cacheTimestamp = 0;
let cacheIndexHash = '';
const CACHE_TTL_MS = 30_000; // 30s TTL

/**
 * Build a set of session IDs that belong to excluded projects.
 * Uses the session cache to map UUID session IDs → project paths (cwd/filePath).
 */
function buildExcludedSessionIds(): Set<string> {
  const excluded = new Set<string>();
  try {
    const cache = getSessionCache();
    for (const { sessionId, filePath, cacheData } of cache.getAllSessionsFromCache()) {
      if (isProjectExcluded(cacheData.cwd || '') || isProjectExcluded(filePath)) {
        excluded.add(sessionId);
      }
    }
  } catch {
    // Session cache may not be ready
  }
  return excluded;
}

function loadAllMilestones(): Milestone[] {
  const store = getMilestoneStore();
  const index = store.getIndex();

  // Quick staleness check: compare index lastUpdated + session count
  const indexHash = `${index.lastUpdated}:${Object.keys(index.sessions).length}`;
  const now = Date.now();

  if (cachedMilestones && (now - cacheTimestamp) < CACHE_TTL_MS && indexHash === cacheIndexHash) {
    return cachedMilestones;
  }

  const excludedSessions = buildExcludedSessionIds();

  const all: Milestone[] = [];
  for (const sessionId of Object.keys(index.sessions)) {
    if (excludedSessions.has(sessionId)) continue;
    const milestones = store.getMilestones(sessionId);
    all.push(...milestones);
  }

  cachedMilestones = all;
  cacheTimestamp = now;
  cacheIndexHash = indexHash;

  return all;
}

// ─── Directory Matching ──────────────────────────────────────────────────

/** Check if any file in the list matches the directory prefix (relative or absolute). */
function filesMatchDir(files: string[] | undefined, relPrefix: string, directory: string, absPrefix: string | null): boolean {
  if (!files || files.length === 0) return false;
  return files.some(f =>
    f === directory || f.startsWith(relPrefix) ||
    (absPrefix && (f === absPrefix.slice(0, -1) || f.startsWith(absPrefix)))
  );
}

// ─── Routes ──────────────────────────────────────────────────

export function createSessionSearchRoutes(ctx: RouteContext): RouteHandler[] {
  return [
    // GET /session-search/recent - Recent phase-2 milestones (no query needed)
    {
      method: 'GET',
      pattern: /^\/session-search\/recent$/,
      handler: async (req) => {
        let allMilestones = loadAllMilestones();

        // Optional project path filter
        const projectPath = req.query?.projectPath as string | undefined;
        if (projectPath) {
          const cache = getSessionCache();
          const allowedSessions = new Set<string>();
          for (const { sessionId, cacheData } of cache.getAllSessionsFromCache()) {
            if (cacheData.cwd === projectPath) {
              allowedSessions.add(sessionId);
            }
          }
          allMilestones = allMilestones.filter(m => allowedSessions.has(m.sessionId));
        }

        // Optional directory filter: keep milestones whose filesModified OR filesRead
        // match the directory prefix. The architecture builder counts both, so we must too.
        const directory = req.query?.directory as string | undefined;
        if (directory) {
          const relPrefix = directory.endsWith('/') ? directory : directory + '/';
          const absPrefix = projectPath ? (projectPath.endsWith('/') ? projectPath : projectPath + '/') + relPrefix : null;
          allMilestones = allMilestones.filter(m =>
            filesMatchDir(m.filesModified, relPrefix, directory, absPrefix) ||
            filesMatchDir(m.filesRead, relPrefix, directory, absPrefix)
          );
        }

        // When browsing by directory, include all phases and raise the cap;
        // otherwise keep the default phase-2-only + 50 limit for the general recent view.
        // For the general view, cap per session to ensure diversity across sessions.
        const browsingByDir = !!directory;
        const MAX_PER_SESSION = browsingByDir ? Infinity : 5;
        const TOTAL_LIMIT = browsingByDir ? 200 : 50;

        const sorted = allMilestones
          .filter(m => browsingByDir || m.phase === 2)
          .sort((a, b) => {
            const tsA = new Date(a.endTimestamp || a.startTimestamp).getTime();
            const tsB = new Date(b.endTimestamp || b.startTimestamp).getTime();
            return tsB - tsA;
          });

        // Apply per-session cap for diversity
        const sessionCounts = new Map<string, number>();
        const recent: ReturnType<typeof toSearchResult>[] = [];
        for (const m of sorted) {
          if (recent.length >= TOTAL_LIMIT) break;
          const count = sessionCounts.get(m.sessionId) || 0;
          if (count >= MAX_PER_SESSION) continue;
          sessionCounts.set(m.sessionId, count + 1);
          recent.push(toSearchResult(m, 0));
        }

        return {
          success: true,
          data: { results: recent },
        };
      },
    },

    // POST /session-search - Milestone keyword search (sync, fast)
    {
      method: 'POST',
      pattern: /^\/session-search$/,
      handler: async (req) => {
        const startTime = Date.now();
        const body = req.body as SearchRequest;

        if (!body.query || typeof body.query !== 'string') {
          return { success: false, error: { code: 'MISSING_QUERY', message: 'query is required' } };
        }

        const query = body.query.trim();
        if (!query) {
          return { success: false, error: { code: 'MISSING_QUERY', message: 'query is required' } };
        }
        const scope: Scope = body.scope && SCOPE_MS[body.scope as Scope] ? body.scope as Scope : 'all';
        const limit = body.limit || 0; // 0 = no limit

        let allMilestones = loadAllMilestones();

        // Project path filter: restrict to milestones from matching sessions
        if (body.projectPath) {
          const cache = getSessionCache();
          const allowedSessions = new Set<string>();
          for (const { sessionId, cacheData } of cache.getAllSessionsFromCache()) {
            if (cacheData.cwd === body.projectPath) {
              allowedSessions.add(sessionId);
            }
          }
          allMilestones = allMilestones.filter(m => allowedSessions.has(m.sessionId));
        }

        // Directory filter: keep milestones whose filesModified OR filesRead
        // match the directory prefix. The architecture builder counts both, so we must too.
        if (body.directory) {
          const relPrefix = body.directory.endsWith('/') ? body.directory : body.directory + '/';
          const absPrefix = body.projectPath ? (body.projectPath.endsWith('/') ? body.projectPath : body.projectPath + '/') + relPrefix : null;
          allMilestones = allMilestones.filter(m =>
            filesMatchDir(m.filesModified, relPrefix, body.directory!, absPrefix) ||
            filesMatchDir(m.filesRead, relPrefix, body.directory!, absPrefix)
          );
        }

        const queryTokens = tokenize(query);
        const queryLower = query.toLowerCase();

        const results: MilestoneSearchResult[] = [];
        let milestonesScanned = 0;

        for (const milestone of allMilestones) {
          // Scope filter
          const ts = milestone.endTimestamp || milestone.startTimestamp;
          if (!isWithinScope(ts, scope)) continue;

          milestonesScanned++;

          const rawScore = scoreMilestone(milestone, queryTokens, queryLower);
          if (rawScore <= 0) continue;

          const boostedScore = applyBoosts(rawScore, milestone);
          results.push(toSearchResult(milestone, boostedScore));
        }

        // Sort by score descending
        results.sort((a, b) => b.score - a.score);

        return {
          success: true,
          data: {
            results: limit > 0 ? results.slice(0, limit) : results,
            total: results.length,
            query,
            scope,
            searchTimeMs: Date.now() - startTime,
            milestonesScanned,
          },
        };
      },
    },

    // POST /session-search/vector - Hybrid semantic search (Vectra + BM25)
    {
      method: 'POST',
      pattern: /^\/session-search\/vector$/,
      handler: async (req) => {
        const startTime = Date.now();
        const body = req.body as SearchRequest;

        if (!body.query || typeof body.query !== 'string') {
          return { success: false, error: { code: 'MISSING_QUERY', message: 'query is required' } };
        }

        const query = body.query.trim();
        if (!query) {
          return { success: false, error: { code: 'MISSING_QUERY', message: 'query is required' } };
        }
        const scope: Scope = body.scope && SCOPE_MS[body.scope as Scope] ? body.scope as Scope : 'all';
        const limit = body.limit || 0; // 0 = no limit

        const vectra = getVectraStore();
        const stats = await vectra.getStats();

        if (!stats.isInitialized || stats.totalVectors === 0) {
          return {
            success: false,
            error: {
              code: 'VECTORS_NOT_READY',
              message: `Vector store has ${stats.totalVectors} vectors (initialized: ${stats.isInitialized}). Run milestone pipeline first.`,
            },
          };
        }

        // Hybrid search: Vectra + BM25 in parallel
        const { getBM25Scorer } = require('../../search/bm25-scorer');
        const { reciprocalRankFusion } = require('../../search/rrf-merger');
        const bm25 = getBM25Scorer();

        const [rawResults, bm25Raw] = await Promise.all([
          vectra.search(query, limit * 3),
          Promise.resolve(bm25.search(query, limit * 3, 'milestone')),
        ]);

        // Filter by scope and excluded projects
        const excludedSessions = buildExcludedSessionIds();
        const scopeFiltered = rawResults.filter(r =>
          isWithinScope(r.timestamp, scope) && !excludedSessions.has(r.sessionId)
        );

        // Filter BM25 results by scope and excluded sessions
        const bm25Filtered = bm25Raw.filter((r: any) => {
          if (!isWithinScope(r.timestamp, scope)) return false;
          const sessionId = r.sessionId || r.id.split(':')[0];
          return !excludedSessions.has(sessionId);
        });

        // Deduplicate Vectra by unique milestone/session ID (keep highest score)
        const seen = new Map<string, typeof scopeFiltered[0]>();
        for (const r of scopeFiltered) {
          const id = r.type === 'milestone'
            ? `${r.sessionId}:${r.milestoneIndex}`
            : r.sessionId;
          const existing = seen.get(id);
          if (!existing || r.score > existing.score) {
            seen.set(id, r);
          }
        }

        // Convert Vectra results to ScoredResult for RRF
        const vectraScored: ScoredResult[] = Array.from(seen.values()).map(r => ({
          type: r.type,
          id: r.type === 'milestone' ? `${r.sessionId}:${r.milestoneIndex}` : r.sessionId,
          sessionId: r.sessionId,
          score: r.score,
          finalScore: r.score,
          timestamp: r.timestamp || '',
          phase: r.phase as 1 | 2 | undefined,
          projectPath: r.projectPath,
        }));

        // RRF merge Vectra + BM25
        const merged = reciprocalRankFusion(vectraScored, bm25Filtered);

        const compositeOptions: CompositeScoreOptions = {};
        if (body.projectPath) {
          compositeOptions.currentProject = body.projectPath;
        }

        const ranked = compositeScore(merged, compositeOptions);

        // Hydrate milestone results with full data from store
        const store = getMilestoneStore();
        const results: MilestoneSearchResult[] = [];

        for (const r of (limit > 0 ? ranked.slice(0, limit) : ranked)) {
          if (r.type === 'milestone') {
            const milestone = store.getMilestoneById(r.id);
            if (milestone) {
              results.push(toSearchResult(milestone, r.finalScore));
            }
          }
          // Skip raw session results — milestones are the atomic unit now
        }

        return {
          success: true,
          data: {
            results,
            total: results.length,
            query,
            scope,
            searchTimeMs: Date.now() - startTime,
            vectorCandidates: rawResults.length,
          },
        };
      },
    },
  ];
}
