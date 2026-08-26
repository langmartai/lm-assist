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
import { tokenizeSessionQuery, containsWord } from '../../search/text-scorer';
import { getPromptIndex } from '../../search/prompt-index';
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

// Deliberately NOT a local tokenizer any more. This file used to carry its own copy of
// both the tokenizer and the scorer, which is why the match-all fix to the MCP `search`
// tool never reached the web UI: `and` survived tokenization and `lower.includes(token)`
// matched it inside command/understand/expands, so a query returned 6,914 of ~6,914
// sessions. The shared, fixed implementations live in search/text-scorer.ts.

/**
 * Whole-word field scoring for the FALLBACK scan. Reports which distinct terms it matched
 * so the caller can apply a majority floor — one shared word is not a match.
 */
function scoreField(
  text: string | undefined | null,
  queryTokens: string[],
  queryLower: string,
  weight: number,
  seen: Set<string>,
): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let score = 0;

  if (queryLower && lower.includes(queryLower)) {
    score += 10 * weight;
  }

  for (const token of queryTokens) {
    if (containsWord(lower, token)) {
      score += weight;
      seen.add(token);
    }
  }

  return score;
}

// ─── Shared Search Logic ──────────────────────────────────────────────────

async function sessionKeywordSearch(params: Record<string, string>) {
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

  const queryTokens = tokenizeSessionQuery(query);
  const queryLower = query.toLowerCase();

  interface SessionSearchResult {
    sessionId: string;
    score: number;
    timestamp: string;
    project: string;
    numTurns: number;
    /** Distinct query terms this session matched (bm25 path only). */
    terms?: number;
    /** The prompt that matched, for display. */
    snippet?: string;
  }

  const byId = new Map(sessions.map((x) => [x.sessionId, x.cacheData] as const));

  // ── Preferred: bm25 over the indexed user prompts, the same path the MCP `search`
  // tool uses. The scan below stays as a fallback for a node whose index has not built,
  // and the response says which one answered so a coarse result is never mistaken for a
  // ranked one.
  try {
    const index = getPromptIndex();
    await index.init();
    if (index.hasContent() && queryTokens.length > 0) {
      const since = scope === 'all' ? undefined : new Date(Date.now() - SCOPE_MS[scope]).toISOString();
      const need = limit > 0 ? limit : 50;
      const r = await index.search(query, { project: params.projectPath, since, need });
      if (r && r.sessions.length > 0) {
        const ranked: SessionSearchResult[] = r.sessions.map((sess, i) => {
          const cd = byId.get(sess.sessionId);
          return {
            sessionId: sess.sessionId,
            // Rank inverted into a descending score so existing consumers still sort right.
            score: r.sessions.length - i,
            timestamp: sess.ts || cd?.lastTimestamp || '',
            project: sess.project || cd?.cwd || '',
            numTurns: cd?.numTurns ?? 0,
            terms: sess.terms,
            snippet: sess.best.text.replace(/\s+/g, ' ').slice(0, 220),
          };
        });
        return {
          success: true,
          data: {
            results: limit > 0 ? ranked.slice(0, limit) : ranked,
            total: ranked.length,
            query,
            scope,
            searchTimeMs: Date.now() - startTime,
            sessionsScanned: ranked.length,
            path: 'prompt-index',
            mode: r.mode,
            queryTerms: r.queryTerms,
            truncated: r.truncated,
          },
        };
      }
      if (r) {
        // The index answered and found nothing. That is a real no-match, not a reason to
        // fall through to a coarser scan that would manufacture hits.
        return {
          success: true,
          data: {
            results: [], total: 0, query, scope,
            searchTimeMs: Date.now() - startTime, sessionsScanned: 0,
            path: 'prompt-index', mode: r.mode, queryTerms: r.queryTerms, truncated: false,
          },
        };
      }
    }
  } catch { /* index unavailable — fall through to the scan, which reports itself */ }

  const results: SessionSearchResult[] = [];
  let sessionsScanned = 0;

  for (const { sessionId, cacheData } of sessions) {
    const ts = cacheData.lastTimestamp;
    if (!isWithinScope(ts, scope)) continue;
    if (params.projectPath && cacheData.cwd !== params.projectPath) continue;

    sessionsScanned++;

    // Score against session metadata
    let score = 0;
    const seen = new Set<string>();
    score += scoreField(cacheData.result, queryTokens, queryLower, 4, seen);
    score += scoreField(cacheData.cwd, queryTokens, queryLower, 2, seen);

    // Score user prompts
    for (const p of cacheData.userPrompts) {
      score += scoreField(p.text, queryTokens, queryLower, 3, seen);
    }

    // Score tasks
    for (const t of cacheData.tasks) {
      score += scoreField(t.subject, queryTokens, queryLower, 3, seen);
      score += scoreField(t.description, queryTokens, queryLower, 1, seen);
    }

    if (score <= 0) continue;
    // A majority of the query's terms, or it is not a match. Without this floor a single
    // shared word returns the corpus.
    if (queryTokens.length > 1 && seen.size < Math.ceil(queryTokens.length / 2)) continue;
    // Damp by transcript size so sheer volume cannot substitute for relevance.
    score = score / (1 + Math.log10(1 + Math.max(cacheData.userPrompts.length, 1)));

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
      // Named so a coarse whole-transcript scan is never mistaken for the ranked path.
      path: 'text-scan',
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
        return await sessionKeywordSearch(req.query as Record<string, string>);
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
        return await sessionKeywordSearch(params);
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
