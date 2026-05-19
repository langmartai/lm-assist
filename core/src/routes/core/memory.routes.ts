/**
 * Memory Routes
 *
 * Endpoints under `/memory/*` and `/memory-cache/*` — read access to
 * Claude Code memory directories, both live auto-memory and the
 * in-repo per-host mirror.
 *
 * Companion route: GET /sessions/:id?includeMemory=true joins the
 * same memory payload onto a session response. See sessions.routes.ts.
 */

import type { RouteHandler, RouteContext } from '../index';
import { createMemoryApiImpl, MemoryApi, MemoryDetail } from '../../api/memory-api';
import type { MemorySource } from '../../memory-cache';
import type { Shareability } from '../../utils/memory-shareability';

let memoryApi: MemoryApi | null = null;
function getApi(): MemoryApi {
  if (!memoryApi) memoryApi = createMemoryApiImpl();
  return memoryApi;
}

function parseDetail(v: string | undefined): MemoryDetail {
  if (v === 'index' || v === 'list' || v === 'full' || v === 'relevant') return v;
  return 'list';
}

function parseShareabilityInclude(v: string | undefined): Shareability[] | undefined {
  if (!v) return undefined;
  const valid: Shareability[] = ['host-local', 'project-domain', 'ambiguous'];
  const out: Shareability[] = [];
  for (const tok of v.split(',').map(s => s.trim()).filter(Boolean)) {
    if ((valid as string[]).includes(tok)) out.push(tok as Shareability);
  }
  return out.length > 0 ? out : undefined;
}

function parseSources(v: string | undefined): 'all' | 'live' | 'repo' {
  if (v === 'live' || v === 'repo') return v;
  return 'all';
}

function parseHostFilter(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

export function createMemoryRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // ─── Project listing ─────────────────────────────────────

    // GET /memory/projects — list all projects that have memory dirs
    {
      method: 'GET',
      pattern: /^\/memory\/projects$/,
      handler: async () => {
        return await getApi().listProjects();
      },
    },

    // ─── Per-project queries ─────────────────────────────────

    // GET /memory/by-project/:projectId
    // ?detail=index|list|full|relevant (default list)
    // ?sources=all|live|repo (default all)
    // ?hosts=<comma-sep> — restrict repo sources to these host-ids
    // ?q=<query>&limit=<N>  — required for detail=relevant
    {
      method: 'GET',
      pattern: /^\/memory\/by-project\/(?<projectId>[^/]+)$/,
      handler: async (req) => {
        const projectId = decodeURIComponent(req.params.projectId);
        return await getApi().getByProject(projectId, {
          detail: parseDetail(req.query.detail),
          sources: parseSources(req.query.sources),
          hostFilter: parseHostFilter(req.query.hosts),
          relevanceQuery: req.query.q,
          limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
        });
      },
    },

    // GET /memory/by-project/:projectId/cross-host
    // ?q=<query>&limit=<N>&hosts=<comma-sep>&include=project-domain,ambiguous,host-local
    {
      method: 'GET',
      pattern: /^\/memory\/by-project\/(?<projectId>[^/]+)\/cross-host$/,
      handler: async (req) => {
        const projectId = decodeURIComponent(req.params.projectId);
        return await getApi().crossHost(projectId, {
          query: req.query.q,
          limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
          hostFilter: parseHostFilter(req.query.hosts),
          include: parseShareabilityInclude(req.query.include),
        });
      },
    },

    // GET /memory/by-project/:projectId/index
    // ?source=live or repo:<host-id>
    {
      method: 'GET',
      pattern: /^\/memory\/by-project\/(?<projectId>[^/]+)\/index$/,
      handler: async (req) => {
        const projectId = decodeURIComponent(req.params.projectId);
        const source = req.query.source as 'live' | `repo:${string}` | undefined;
        return await getApi().getIndex(projectId, { source });
      },
    },

    // GET /memory/by-project/:projectId/file/:filename
    // ?source=live (default) or repo:<host-id>
    {
      method: 'GET',
      pattern: /^\/memory\/by-project\/(?<projectId>[^/]+)\/file\/(?<filename>.+)$/,
      handler: async (req) => {
        const projectId = decodeURIComponent(req.params.projectId);
        const filename = decodeURIComponent(req.params.filename);
        const source = (req.query.source || 'live') as MemorySource;
        return await getApi().getFile(projectId, source, filename);
      },
    },

    // GET /memory/by-project/:projectId/sources
    {
      method: 'GET',
      pattern: /^\/memory\/by-project\/(?<projectId>[^/]+)\/sources$/,
      handler: async (req) => {
        const projectId = decodeURIComponent(req.params.projectId);
        return await getApi().getSources(projectId);
      },
    },

    // GET /memory/by-project/:projectId/diff
    {
      method: 'GET',
      pattern: /^\/memory\/by-project\/(?<projectId>[^/]+)\/diff$/,
      handler: async (req) => {
        const projectId = decodeURIComponent(req.params.projectId);
        return await getApi().getDiff(projectId);
      },
    },

    // GET /memory/by-project/:projectId/has-update?sinceMs=<num>
    {
      method: 'GET',
      pattern: /^\/memory\/by-project\/(?<projectId>[^/]+)\/has-update$/,
      handler: async (req) => {
        const projectId = decodeURIComponent(req.params.projectId);
        const sinceMs = parseInt(req.query.sinceMs || '0', 10);
        return await getApi().hasUpdate(projectId, sinceMs);
      },
    },

    // ─── Session-side helpers ────────────────────────────────

    // GET /memory/by-session/:sessionId — sugar that resolves session → project
    {
      method: 'GET',
      pattern: /^\/memory\/by-session\/(?<sessionId>[a-f0-9-]+)$/,
      handler: async (req) => {
        const sessionId = req.params.sessionId;
        return await getApi().getForSession(sessionId, {
          detail: parseDetail(req.query.detail),
          sources: parseSources(req.query.sources),
          hostFilter: parseHostFilter(req.query.hosts),
          relevanceQuery: req.query.q,
          limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
        });
      },
    },

    // GET /memory/by-session/:sessionId/file/:filename
    {
      method: 'GET',
      pattern: /^\/memory\/by-session\/(?<sessionId>[a-f0-9-]+)\/file\/(?<filename>.+)$/,
      handler: async (req) => {
        const sessionId = req.params.sessionId;
        const filename = decodeURIComponent(req.params.filename);
        const source = (req.query.source || 'live') as MemorySource;
        const api = getApi();
        // Two-step: resolve session → project listing → file fetch by project id
        const listing = await api.getForSession(sessionId, { detail: 'index' });
        if (!listing.success || !listing.data) {
          return listing;
        }
        return await api.getFile(listing.data.projectId, source, filename);
      },
    },

    // ─── Batch + cache control ───────────────────────────────

    // POST /memory/batch-check
    {
      method: 'POST',
      pattern: /^\/memory\/batch-check$/,
      handler: async (req) => {
        const body = req.body || {};
        return await getApi().batchCheck({ projects: body.projects || [] });
      },
    },

    // ─── Sync helpers (read-only — Claude Code does the actual writes) ──

    // GET /memory/by-project/:projectId/sync/import-candidates
    // Returns memories from other hosts' folders that look worth importing —
    // project-domain shareability, not already present in the local live dir.
    // Claude Code calls this, decides what to keep, then uses its Write tool
    // to copy files into both the live dir and the local repo host folder.
    // ?q=<optional> — rank by relevance to a query
    // ?hosts=<comma-sep> — restrict source hosts
    {
      method: 'GET',
      pattern: /^\/memory\/by-project\/(?<projectId>[^/]+)\/sync\/import-candidates$/,
      handler: async (req) => {
        const projectId = decodeURIComponent(req.params.projectId);
        return await getApi().getImportCandidates(projectId, {
          query: req.query.q,
          hostFilter: parseHostFilter(req.query.hosts),
          limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
        });
      },
    },

    // POST /memory-cache/warm
    {
      method: 'POST',
      pattern: /^\/memory-cache\/warm$/,
      handler: async (req) => {
        const body = req.body || {};
        return await getApi().warm(body.projectIds);
      },
    },

    // POST /memory-cache/clear
    {
      method: 'POST',
      pattern: /^\/memory-cache\/clear$/,
      handler: async (req) => {
        const body = req.body || {};
        return await getApi().clear(body.projectId);
      },
    },
  ];
}
