/**
 * Cross-node memory sync routes — direct-MCP transport (replaces the git mirror).
 *
 *   POST /memory/export  { project, sinceMs?, key? }            -> this node's syncable records
 *   POST /memory/ingest  { project, sourceHost, records[], key? } -> write a peer's records
 *
 * Both are POST so the access-key can travel in the BODY: when relayed through the hub
 * (`/api/tier-agent/machines/<id>/proxy`) the `x-lm-access-key` header is dropped, mirroring
 * the data-service cross-node calls (see core/src/data/peer-client.ts).
 *
 * Authorization (fleet-internal trust): a call is allowed when it is loopback-local OR it arrives
 * via the hub relay (`x-relay-source: hub`, which the relay sets server-side and strips from client
 * input — see api-relay-handler) carrying the node key in the body. Core's REST layer already gates
 * non-loopback requests on the worker api-token, so this is an additional semantic check, not the
 * only one. Memory shared here is the user's own project memory across their own fleet.
 */
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { extractRecords } from '../../memory/record-extract';
import { selectSyncable } from '../../memory/sync-select';
import { ingestRecords, IngestRecord } from '../../memory/ingest';
import { readMemorySyncConfig, writeMemorySyncConfig } from '../../memory/node-mode';
import { getAutoSyncDaemon } from '../../memory/autosync';
import { pullFromHome } from '../../memory/mcp-transport';
import { getHubConfig } from '../../hub-client/hub-config';
import { getProjectsDir, legacyEncodeProjectPath } from '../../utils/path-utils';
import { isLoopbackAddress } from '../../auth/enroll-exempt';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }

function relaySource(req: ParsedRequest): string | undefined {
  const v = req.headers?.['x-relay-source'];
  return Array.isArray(v) ? v[0] : v;
}

/** Loopback root, or a hub-relayed fleet peer carrying the node key in the body. */
function authorized(req: ParsedRequest, bodyKey: unknown): boolean {
  if (isLoopbackAddress(req.clientIp)) return true;
  return relaySource(req) === 'hub' && typeof bodyKey === 'string' && bodyKey.length > 0;
}

/** Pull the home node's `homeProject` memory and ingest it into the local `localProject`'s
 *  home-node mirror, so the local Claude Code session can see it. Returns the count written. */
async function doPull(homeNode: string, homeProject: string, localProject: string): Promise<number> {
  const key = getHubConfig().apiKey || '';
  if (!key) return 0;
  const records = await pullFromHome(homeNode, homeProject, 0, key);
  const projectDir = path.join(getProjectsDir(), localProject);
  return ingestRecords(projectDir, homeNode, records.map((r) => ({ file: r.file, content: r.content, contentHash: r.contentHash })));
}

export interface ExportedRecord {
  file: string;
  content: string;       // whole file (frontmatter + body) so the receiver re-extracts identically
  contentHash: string;   // sha256 of the whole file — the per-file dedup key
  recordId: string;
  recordedAtMs: number;
}

export function createMemorySyncRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'POST',
      pattern: /^\/memory\/export$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        const b = (req.body || {}) as { project?: string; sinceMs?: number; key?: string };
        if (!authorized(req, b.key)) return wrapError('FORBIDDEN', 'not authorized for memory sync', start);
        const project = typeof b.project === 'string' ? b.project : '';
        if (!project) return wrapError('INVALID_INPUT', 'project is required', start);
        const sinceMs = Number(b.sinceMs) || 0;

        const liveDir = path.join(getProjectsDir(), project, 'memory');
        const out: ExportedRecord[] = [];
        let names: string[] = [];
        try { names = fs.readdirSync(liveDir); } catch { names = []; }
        for (const name of names) {
          if (!name.endsWith('.md') || name.startsWith('.')) continue;
          const fp = path.join(liveDir, name);
          let st: fs.Stats;
          try { st = fs.statSync(fp); } catch { continue; }
          if (!st.isFile()) continue; // skip per-host mirror subdirs (memory/<host>/)
          let content: string;
          try { content = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
          const recs = extractRecords({ node: '', project, source: 'live', filename: name, content, mtimeMs: st.mtimeMs, size: st.size });
          const keep = selectSyncable(recs, sinceMs);
          if (!keep.length) continue;
          out.push({ file: name, content, contentHash: sha256(content), recordId: keep[0].recordId, recordedAtMs: keep[0].recordedAtMs });
        }
        return wrapResponse({ project, records: out }, start);
      },
    },
    {
      method: 'POST',
      pattern: /^\/memory\/ingest$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        const b = (req.body || {}) as { project?: string; sourceHost?: string; records?: IngestRecord[]; key?: string };
        if (!authorized(req, b.key)) return wrapError('FORBIDDEN', 'not authorized for memory sync', start);
        if (!b.project || !b.sourceHost || !Array.isArray(b.records)) {
          return wrapError('INVALID_INPUT', 'project, sourceHost, records[] required', start);
        }
        const projectDir = path.join(getProjectsDir(), b.project);
        const n = ingestRecords(projectDir, b.sourceHost, b.records);
        return wrapResponse({ ingested: n }, start);
      },
    },
    // GET /memory/sync/status — this node's memory-sync config + live autosync daemon state.
    {
      method: 'GET',
      pattern: /^\/memory\/sync\/status$/,
      handler: async () => {
        const start = Date.now();
        return wrapResponse({ config: readMemorySyncConfig(), daemon: getAutoSyncDaemon().getStatus() }, start);
      },
    },
    // POST /memory/sync/enable { homeNode, homeProject, project? } — loopback-only.
    // Marks this node ephemeral, records the home node + project slugs, and pulls the home's
    // persistent memory now. `project` is this node's LOCAL slug for the same repo (defaults to homeProject).
    {
      method: 'POST',
      pattern: /^\/memory\/sync\/enable$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        if (!isLoopbackAddress(req.clientIp)) return wrapError('FORBIDDEN', 'local-only endpoint', start);
        const b = (req.body || {}) as { homeNode?: string; homeProject?: string; project?: string; cwd?: string };
        if (!b.homeNode || !b.homeProject) return wrapError('INVALID_INPUT', 'homeNode and homeProject are required', start);
        // localProject = this node's slug for the repo: explicit `project`, else encode `cwd`, else fall back to homeProject.
        const localProject = (typeof b.project === 'string' && b.project) ? b.project
          : (typeof b.cwd === 'string' && b.cwd) ? legacyEncodeProjectPath(b.cwd)
          : b.homeProject;
        writeMemorySyncConfig({ nodeMode: 'ephemeral', homeNode: b.homeNode, homeProject: b.homeProject, project: localProject });
        const pulled = await doPull(b.homeNode, b.homeProject, localProject);
        return wrapResponse({ configured: true, nodeMode: 'ephemeral', homeNode: b.homeNode, homeProject: b.homeProject, project: localProject, pulled }, start);
      },
    },
    // POST /memory/pull — loopback-only; re-pull the home node's memory using the saved config.
    {
      method: 'POST',
      pattern: /^\/memory\/pull$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        if (!isLoopbackAddress(req.clientIp)) return wrapError('FORBIDDEN', 'local-only endpoint', start);
        const cfg = readMemorySyncConfig();
        if (cfg.nodeMode !== 'ephemeral' || !cfg.homeNode || !(cfg.homeProject || cfg.project)) {
          return wrapResponse({ pulled: 0, skipped: 'not an ephemeral node with a home + project configured' }, start);
        }
        const localProject = cfg.project || cfg.homeProject!;
        const homeProject = cfg.homeProject || cfg.project!;
        const pulled = await doPull(cfg.homeNode, homeProject, localProject);
        return wrapResponse({ pulled, homeNode: cfg.homeNode, homeProject, project: localProject }, start);
      },
    },
  ];
}
