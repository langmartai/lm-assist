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

import * as fs from 'fs';
import * as os from 'os';
import type { RouteHandler, RouteContext } from '../index';
import { createMemoryApiImpl, MemoryApi, MemoryDetail } from '../../api/memory-api';
import type { MemorySource } from '../../memory-cache';
import type { Shareability } from '../../utils/memory-shareability';
import { wrapResponse } from '../../api/helpers';

let memoryApi: MemoryApi | null = null;
function getApi(): MemoryApi {
  if (!memoryApi) memoryApi = createMemoryApiImpl();
  return memoryApi;
}

// ─── Self-node identity (mirrors core/scripts/memory-map.js's `liveNode`) ──
//
// memory-map.js derives the node label attached to every LIVE-source memory
// record as:
//   process.env.LM_HOST_ID
//     || projects.map(p => resolveMyHostId(p.projectPath)).find(Boolean)
//     || os.hostname()
// where resolveMyHostId(projectPath) reads <projectPath>/memory/_hosts.md
// and returns the id from the first line that both (a) mentions one of this
// machine's local interface IPs and (b) yields an id token via a backtick
// `id` or a `| id |` table-row match.
//
// GET /memory/self-node exists so the web UI can tell which memory-map rows
// are "this machine". It must return the SAME value memory-map.js computed
// for those rows, or the UI's "this is you" highlighting silently points at
// the wrong node. selfHostId() (LM_HOST_ID > hub gatewayId > os.hostname())
// looked like a natural reuse candidate — it shares both outer boundaries of
// the chain above — but its middle term is the hub's gatewayId, not the
// _hosts.md-derived id, and the two are only coincidentally equal when a
// human happens to name the _hosts.md row the same as the gatewayId.
// Live-confirmed divergence on this node: LM_HOST_ID is unset, this node has
// no _hosts.md row matching its own IP in some project (falls through to
// os.hostname() = "ubuntu-Virtual-Machine")... but in
// /home/user/my-project/memory/_hosts.md the row `linux-117` matches
// this machine's LAN interface IP, so memory-map.js resolves
// liveNode = "linux-117" while selfHostId() resolves to the hub gatewayId
// (or hostname if the hub isn't connected) — divergent. So this handler
// re-implements memory-map.js's exact chain instead of delegating to
// selfHostId(), using the SAME in-process project list the sibling
// GET /memory/projects handler below uses (no loopback HTTP call needed —
// memory-map.js only goes over HTTP because it's an external script, not
// in-process code).

/**
 * Pure scanner: given the raw text of a `<projectPath>/memory/_hosts.md`
 * file and this machine's local interface IPs, return the id from the
 * first line that both mentions one of the given IPs and yields an id
 * token — via a backtick `` `id` `` or a `| id |` table-row match — else
 * null. Exact behavioral port of memory-map.js's `resolveMyHostId` inner
 * loop (and the equivalent private method in memory/autosync.ts), factored
 * out here as a pure function so it's unit-testable without _hosts.md
 * fixtures on disk.
 */
export function resolveHostIdFromHostsFile(hostsFileText: string, localIps: string[]): string | null {
  for (const line of hostsFileText.split('\n')) {
    const id = (line.match(/`([a-z0-9-]+)`/) || [])[1] || (line.match(/^\|\s*([a-z0-9-]+)\s*\|/) || [])[1];
    if (id && localIps.some(ip => line.includes(ip))) return id;
  }
  return null;
}

/** Read `<projectPath>/memory/_hosts.md` and scan it for this machine's id. Missing/unreadable file → null (matches memory-map.js's try/catch-and-skip). */
function resolveMyHostId(projectPath: string, localIps: string[]): string | null {
  const hostsFile = `${projectPath}/memory/_hosts.md`;
  let text: string;
  try {
    text = fs.readFileSync(hostsFile, 'utf8');
  } catch {
    return null;
  }
  return resolveHostIdFromHostsFile(text, localIps);
}

/** This node's identity as memory-map.js's `liveNode` computes it — see block comment above. */
async function resolveSelfNodeId(): Promise<string> {
  if (process.env.LM_HOST_ID) return process.env.LM_HOST_ID;

  const projectsResp = await getApi().listProjects();
  const projects = projectsResp.success && projectsResp.data ? projectsResp.data : [];
  const localIps = Object.values(os.networkInterfaces())
    .flat()
    .filter(Boolean)
    .map(n => (n as os.NetworkInterfaceInfo).address);
  for (const p of projects) {
    if (!p.projectPath) continue;
    const id = resolveMyHostId(p.projectPath, localIps);
    if (id) return id;
  }

  return os.hostname();
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

    // GET /memory/self-node — this node's identity, for the web UI's origin
    // hint on memory-map records. Returns the EXACT id memory-map.js's
    // `liveNode` computes for this machine's live-source records (see the
    // resolveSelfNodeId block comment above) — not selfHostId()'s hub
    // gatewayId, which is a different value on this node (live-confirmed:
    // "linux-117" via _hosts.md vs. the gatewayId/hostname selfHostId()
    // would have returned).
    {
      method: 'GET',
      pattern: /^\/memory\/self-node$/,
      handler: async () => {
        const start = Date.now();
        const node = await resolveSelfNodeId();
        return wrapResponse({ node, platform: os.platform() }, start);
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
