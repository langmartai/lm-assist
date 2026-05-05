/**
 * Annotation / Pivot Routes
 *
 * Full pipeline exposed as REST endpoints for runtime session curation.
 *
 *   Annotation (offline pipeline — once per turn, amortized):
 *     POST   /annotation/jobs                          Kick off annotation (async)
 *     GET    /annotation/jobs                          List jobs (optional ?sessionId=)
 *     GET    /annotation/jobs/:id                      One job's status + progress
 *     GET    /annotation/:sessionId                    Current annotations (compact or expanded)
 *     GET    /annotation/:sessionId/index              Consolidated index.json
 *     POST   /annotation/:sessionId/index              Force index rebuild
 *
 *   Pivot (hot-path — every prompt):
 *     POST   /pivot/match                              Haiku routes prompt -> topics (returns MatchResult)
 *     POST   /pivot/build                              Build curated JSONL from MatchResult
 *     POST   /pivot/execute                            match + build + optional tmux inject /resume
 */
import type { RouteHandler, RouteContext } from '../index';
import * as fs from 'fs';
import {
  resolveFromCwd, resolveFromSessionId,
  annotate, buildIndex, match, build,
  createJob, updateJob, getJob, listJobs,
  expand, detectSessionCacheState, type CompactAnnotation,
  type AnnotateOptions, type BuildOptions, type MatchResult,
} from '../../annotation';
import { getTerminalManager } from '../../terminal-manager';

function ok<T>(data: T) {
  return { success: true, data };
}
function fail(code: string, message: string) {
  return { success: false, error: { code, message } } as any;
}

/** Resolve session + project paths from req.body {sessionId, cwd?}. */
function resolvePaths(body: any): {
  sessionId: string;
  cwd: string;
  paths: ReturnType<typeof resolveFromCwd>;
} | null {
  const sessionId = body?.sessionId;
  if (!sessionId) return null;
  if (body.cwd) {
    return { sessionId, cwd: body.cwd, paths: resolveFromCwd(sessionId, body.cwd) };
  }
  const resolved = resolveFromSessionId(sessionId);
  if (!resolved) return null;
  return { sessionId, cwd: resolved.cwd, paths: resolved.paths };
}

export function createAnnotationRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // --------- Annotation jobs -----------------------------------------

    // POST /annotation/jobs — start an async annotation run
    {
      method: 'POST',
      pattern: /^\/annotation\/jobs$/,
      handler: async (req) => {
        const body = req.body || {};
        const resolved = resolvePaths(body);
        if (!resolved) return fail('BAD_REQUEST', 'sessionId is required (and session must exist)');
        const { sessionId, cwd, paths } = resolved;
        if (!fs.existsSync(paths.sessionFile)) {
          return fail('NOT_FOUND', `session file missing: ${paths.sessionFile}`);
        }

        const opts: AnnotateOptions = {
          scope: body.scope === 'full' ? 'full' : 'delta',
          model: body.model,  // undefined → annotator picks (forked uses session model, isolated uses Haiku)
          chunkSize: body.chunkSize || 25,
          concurrency: body.concurrency || 3,
          strategy: body.strategy || 'auto',
        };

        const job = createJob({
          sessionId, projectPath: cwd,
          scope: opts.scope!, model: opts.model!, chunkSize: opts.chunkSize!,
        });

        // Fire-and-forget
        setImmediate(async () => {
          updateJob(job.id, { status: 'running', startedAt: new Date().toISOString() });
          try {
            const res = await annotate(
              paths.sessionFile,
              paths.compactAnnotationsFile,
              opts,
              (progress) => updateJob(job.id, { progress }),
            );
            // Auto-rebuild index after annotation completes
            try {
              buildIndex(paths.sessionFile, paths.compactAnnotationsFile, paths.indexFile);
            } catch (e: any) {
              // still mark job complete, note index failure in error
              updateJob(job.id, { error: `index rebuild failed: ${e?.message || e}` });
            }
            updateJob(job.id, {
              status: 'completed',
              completedAt: new Date().toISOString(),
              result: {
                annotated: res.annotated,
                cost_usd: res.cost_usd,
                input_tokens: res.input_tokens,
                output_tokens: res.output_tokens,
                cache_read_tokens: res.cache_read_tokens,
                cache_creation_tokens: res.cache_creation_tokens,
                runtimeMs: res.runtimeMs,
                strategiesUsed: res.strategiesUsed,
              },
            });
          } catch (e: any) {
            updateJob(job.id, {
              status: 'failed',
              completedAt: new Date().toISOString(),
              error: e?.message || String(e),
            });
          }
        });

        return ok({ jobId: job.id, sessionId, scope: opts.scope });
      },
    },

    // GET /annotation/jobs  (?sessionId=...&limit=50)
    {
      method: 'GET',
      pattern: /^\/annotation\/jobs$/,
      handler: async (req) => {
        const sid = req.query?.sessionId;
        const limit = req.query?.limit ? parseInt(req.query.limit, 10) : 50;
        return ok({ jobs: listJobs({ sessionId: sid, limit }) });
      },
    },

    // GET /annotation/jobs/:id
    {
      method: 'GET',
      pattern: /^\/annotation\/jobs\/(?<id>[^/]+)$/,
      handler: async (req) => {
        const job = getJob(req.params.id);
        if (!job) return fail('NOT_FOUND', 'job not found');
        return ok(job);
      },
    },

    // GET /annotation/:sessionId  — get annotations (compact default, ?format=full)
    {
      method: 'GET',
      pattern: /^\/annotation\/(?<sessionId>[^/]+)$/,
      handler: async (req) => {
        const cwd = req.query?.cwd;
        const resolved = cwd
          ? { sessionId: req.params.sessionId, cwd, paths: resolveFromCwd(req.params.sessionId, cwd) }
          : (() => {
              const r = resolveFromSessionId(req.params.sessionId);
              return r ? { sessionId: req.params.sessionId, cwd: r.cwd, paths: r.paths } : null;
            })();
        if (!resolved) return fail('NOT_FOUND', 'session not found');
        if (!fs.existsSync(resolved.paths.compactAnnotationsFile)) {
          return fail('NOT_FOUND', 'no annotations yet — run POST /annotation/jobs first');
        }
        const format = req.query?.format === 'full' ? 'full' : 'compact';
        const compacts: CompactAnnotation[] = fs
          .readFileSync(resolved.paths.compactAnnotationsFile, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => { try { return JSON.parse(l) as CompactAnnotation; } catch { return null; } })
          .filter((a): a is CompactAnnotation => !!a && !!a.u);
        if (format === 'full') {
          return ok({ count: compacts.length, annotations: compacts.map(expand) });
        }
        return ok({ count: compacts.length, annotations: compacts });
      },
    },

    // GET /annotation/:sessionId/index
    {
      method: 'GET',
      pattern: /^\/annotation\/(?<sessionId>[^/]+)\/index$/,
      handler: async (req) => {
        const cwd = req.query?.cwd;
        const resolved = cwd
          ? { paths: resolveFromCwd(req.params.sessionId, cwd) }
          : (() => { const r = resolveFromSessionId(req.params.sessionId); return r ? { paths: r.paths } : null; })();
        if (!resolved) return fail('NOT_FOUND', 'session not found');
        if (!fs.existsSync(resolved.paths.indexFile)) {
          return fail('NOT_FOUND', 'no index yet — annotate first, or POST /annotation/:sid/index');
        }
        return ok(JSON.parse(fs.readFileSync(resolved.paths.indexFile, 'utf-8')));
      },
    },

    // GET /annotation/:sessionId/cache-state — inspect cache hotness for fork decisions
    {
      method: 'GET',
      pattern: /^\/annotation\/(?<sessionId>[^/]+)\/cache-state$/,
      handler: async (req) => {
        const cwd = req.query?.cwd;
        const resolved = cwd
          ? { paths: resolveFromCwd(req.params.sessionId, cwd) }
          : (() => { const r = resolveFromSessionId(req.params.sessionId); return r ? { paths: r.paths } : null; })();
        if (!resolved) return fail('NOT_FOUND', 'session not found');
        return ok(detectSessionCacheState(resolved.paths.sessionFile));
      },
    },

    // POST /annotation/:sessionId/index — force rebuild
    {
      method: 'POST',
      pattern: /^\/annotation\/(?<sessionId>[^/]+)\/index$/,
      handler: async (req) => {
        const cwd = req.body?.cwd || req.query?.cwd;
        const resolved = cwd
          ? { paths: resolveFromCwd(req.params.sessionId, cwd) }
          : (() => { const r = resolveFromSessionId(req.params.sessionId); return r ? { paths: r.paths } : null; })();
        if (!resolved) return fail('NOT_FOUND', 'session not found');
        if (!fs.existsSync(resolved.paths.compactAnnotationsFile)) {
          return fail('NOT_FOUND', 'no annotations yet');
        }
        try {
          const idx = buildIndex(
            resolved.paths.sessionFile,
            resolved.paths.compactAnnotationsFile,
            resolved.paths.indexFile,
          );
          return ok({ rebuilt: true, turn_count: idx.turn_count,
                     topics: Object.keys(idx.topic_clusters).length });
        } catch (e: any) {
          return fail('BUILD_FAILED', e?.message || String(e));
        }
      },
    },

    // --------- Pivot (hot path) ----------------------------------------

    // POST /pivot/match — prompt -> {relevant_topics, include_recent, rationale, usage}
    {
      method: 'POST',
      pattern: /^\/pivot\/match$/,
      handler: async (req) => {
        const body = req.body || {};
        const resolved = resolvePaths(body);
        if (!resolved) return fail('BAD_REQUEST', 'sessionId + cwd required');
        if (!body.prompt) return fail('BAD_REQUEST', 'prompt is required');
        if (!fs.existsSync(resolved.paths.indexFile)) {
          return fail('NO_INDEX', 'no index yet; run annotation first');
        }
        try {
          const res = await match(resolved.paths.indexFile, String(body.prompt), body.model);
          return ok(res);
        } catch (e: any) {
          return fail('MATCH_FAILED', e?.message || String(e));
        }
      },
    },

    // POST /pivot/build — match + index -> curated JSONL
    {
      method: 'POST',
      pattern: /^\/pivot\/build$/,
      handler: async (req) => {
        const body = req.body || {};
        const resolved = resolvePaths(body);
        if (!resolved) return fail('BAD_REQUEST', 'sessionId + cwd required');
        const matchResult = body.match as MatchResult;
        if (!matchResult || !Array.isArray(matchResult.relevant_topics)) {
          return fail('BAD_REQUEST', 'match object required (use POST /pivot/match first)');
        }
        try {
          const res = build(
            resolved.paths.sessionFile,
            resolved.paths.indexFile,
            matchResult,
            (body.options || {}) as BuildOptions,
          );
          return ok(res);
        } catch (e: any) {
          return fail('BUILD_FAILED', e?.message || String(e));
        }
      },
    },

    // POST /pivot/execute — orchestrates match + build + (optional) tmux pivot
    // Body:  { sessionId, cwd?, prompt, tmuxSession?, model?, skipMatch?, match?, options? }
    //        tmuxSession   → if supplied, will /resume + re-inject via terminal-manager
    {
      method: 'POST',
      pattern: /^\/pivot\/execute$/,
      handler: async (req) => {
        const body = req.body || {};
        const resolved = resolvePaths(body);
        if (!resolved) return fail('BAD_REQUEST', 'sessionId + cwd required');
        if (!body.prompt) return fail('BAD_REQUEST', 'prompt is required');

        if (!fs.existsSync(resolved.paths.indexFile)) {
          return fail('NO_INDEX', 'no index yet; POST /annotation/jobs first');
        }

        // 1. Match (or accept supplied match)
        let matchResult: MatchResult;
        if (body.match) {
          matchResult = body.match as MatchResult;
        } else {
          try {
            matchResult = await match(resolved.paths.indexFile, String(body.prompt), body.model);
          } catch (e: any) {
            return fail('MATCH_FAILED', e?.message || String(e));
          }
        }

        // 2. Build
        let buildRes;
        try {
          buildRes = build(
            resolved.paths.sessionFile,
            resolved.paths.indexFile,
            matchResult,
            (body.options || {}) as BuildOptions,
          );
        } catch (e: any) {
          return fail('BUILD_FAILED', e?.message || String(e));
        }

        // 3. Optional tmux pivot
        let pivot: any = null;
        if (body.tmuxSession) {
          try {
            pivot = await getTerminalManager().ccPivot({
              tmuxSession: body.tmuxSession,
              newSessionId: buildRes.newSessionId,
              prompt: String(body.prompt),
              promptPattern: body.promptPattern,
              timeoutMs: body.pivotTimeoutMs,
            });
          } catch (e: any) {
            pivot = { pivoted: false, error: e?.message || String(e) };
          }
        }

        return ok({ match: matchResult, build: buildRes, pivot });
      },
    },
  ];
}
