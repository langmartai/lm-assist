/**
 * Session Search Routes
 *
 * Session-level search across indexed sessions.
 *
 * Endpoints:
 *   POST /session-search          Session keyword search (sync, fast)
 *   POST /session-search/vector   Vectra semantic search (when vectors are indexed)
 */

import type { RouteHandler, RouteContext } from '../index';
import { getVectorStore } from '../../vector/vector-store';
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

// ─── Session Scoring ──────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s\-_.]/g, ' ').split(/\s+/).filter(t => t.length > 1);
}

function scoreField(
  text: string | undefined | null,
  queryTokens: string[],
  queryLower: string,
  weight: number,
): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let score = 0;

  if (lower.includes(queryLower)) {
    score += 10 * weight;
  }

  for (const token of queryTokens) {
    if (lower.includes(token)) {
      score += weight;
    }
  }

  return score;
}

// ─── Shared Search Logic ──────────────────────────────────────────────────

function sessionKeywordSearch(params: Record<string, string>) {
  const startTime = Date.now();

  if (!params.query || typeof params.query !== 'string') {
    return { success: false, error: { code: 'MISSING_QUERY', message: 'query is required' } };
  }

  const query = params.query.trim();
  if (!query) {
    return { success: false, error: { code: 'MISSING_QUERY', message: 'query is required' } };
  }
  const scope: Scope = params.scope && SCOPE_MS[params.scope as Scope] ? params.scope as Scope : 'all';
  const limit = params.limit ? parseInt(params.limit, 10) || 0 : 0;

  const cache = getSessionCache();
  const sessions = cache.getAllSessionsFromCache();

  const queryTokens = tokenize(query);
  const queryLower = query.toLowerCase();

  interface SessionSearchResult {
    sessionId: string;
    score: number;
    timestamp: string;
    project: string;
    numTurns: number;
  }

  const results: SessionSearchResult[] = [];
  let sessionsScanned = 0;

  for (const { sessionId, cacheData } of sessions) {
    const ts = cacheData.lastTimestamp;
    if (!isWithinScope(ts, scope)) continue;
    if (params.projectPath && cacheData.cwd !== params.projectPath) continue;

    sessionsScanned++;

    // Score against session metadata
    let score = 0;
    score += scoreField(cacheData.result, queryTokens, queryLower, 4);
    score += scoreField(cacheData.cwd, queryTokens, queryLower, 2);

    // Score user prompts
    for (const p of cacheData.userPrompts) {
      score += scoreField(p.text, queryTokens, queryLower, 3);
    }

    // Score tasks
    for (const t of cacheData.tasks) {
      score += scoreField(t.subject, queryTokens, queryLower, 3);
      score += scoreField(t.description, queryTokens, queryLower, 1);
    }

    if (score <= 0) continue;

    results.push({
      sessionId,
      score,
      timestamp: ts || '',
      project: cacheData.cwd || '',
      numTurns: cacheData.numTurns,
    });
  }

  results.sort((a, b) => b.score - a.score);

  return {
    success: true,
    data: {
      results: limit > 0 ? results.slice(0, limit) : results,
      total: results.length,
      query,
      scope,
      searchTimeMs: Date.now() - startTime,
      sessionsScanned,
    },
  };
}

// ─── Routes ──────────────────────────────────────────────────

export function createSessionSearchRoutes(ctx: RouteContext): RouteHandler[] {
  return [
    // GET /session-search/recent - Recent sessions
    {
      method: 'GET',
      pattern: /^\/session-search\/recent$/,
      handler: async (req) => {
        const cache = getSessionCache();
        let sessions = cache.getAllSessionsFromCache();

        // Optional project path filter
        const projectPath = req.query?.projectPath as string | undefined;
        if (projectPath) {
          sessions = sessions.filter(s => s.cacheData.cwd === projectPath);
        }

        const sorted = sessions
          .sort((a, b) => {
            const tsA = new Date(a.cacheData.lastTimestamp || '').getTime();
            const tsB = new Date(b.cacheData.lastTimestamp || '').getTime();
            return tsB - tsA;
          })
          .slice(0, 50);

        const results = sorted.map(s => ({
          sessionId: s.sessionId,
          timestamp: s.cacheData.lastTimestamp || '',
          project: s.cacheData.cwd || '',
          numTurns: s.cacheData.numTurns,
          score: 0,
        }));

        return {
          success: true,
          data: { results },
        };
      },
    },

    // GET|POST /session-search - Session keyword search (sync, fast)
    {
      method: 'GET',
      pattern: /^\/session-search$/,
      handler: async (req) => {
        return sessionKeywordSearch(req.query as Record<string, string>);
      },
    },
    {
      method: 'POST',
      pattern: /^\/session-search$/,
      handler: async (req) => {
        const body = req.body as Record<string, unknown>;
        const params: Record<string, string> = { ...req.query as Record<string, string> };
        if (body.query) params.query = String(body.query);
        if (body.scope) params.scope = String(body.scope);
        if (body.limit) params.limit = String(body.limit);
        if (body.projectPath) params.projectPath = String(body.projectPath);
        return sessionKeywordSearch(params);
      },
    },

    // POST /session-search/vector - Hybrid semantic search (vector + FTS)
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
        const limit = body.limit || 0;

        const vectorStore = getVectorStore();
        const stats = await vectorStore.getStats();

        if (!stats.isInitialized || stats.totalVectors === 0) {
          return {
            success: false,
            error: {
              code: 'VECTORS_NOT_READY',
              message: `Vector store has ${stats.totalVectors} vectors (initialized: ${stats.isInitialized}). Run knowledge indexing first.`,
            },
          };
        }

        // Hybrid search: vector + FTS with RRF merge
        const rawResults = await vectorStore.hybridSearch(query, limit * 3);

        // Filter by scope
        const merged: ScoredResult[] = rawResults
          .filter(r => isWithinScope(r.timestamp, scope))
          .map(r => ({
            type: r.type,
            id: r.sessionId,
            sessionId: r.sessionId,
            score: r.score,
            finalScore: r.score,
            timestamp: r.timestamp || '',
            phase: r.phase as 1 | 2 | undefined,
            projectPath: r.projectPath,
          }));

        const compositeOptions: CompositeScoreOptions = {};
        if (body.projectPath) {
          compositeOptions.currentProject = body.projectPath;
        }

        const ranked = compositeScore(merged, compositeOptions);

        const results = (limit > 0 ? ranked.slice(0, limit) : ranked).map(r => ({
          sessionId: r.sessionId,
          score: r.finalScore,
          timestamp: r.timestamp,
          projectPath: r.projectPath,
        }));

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
