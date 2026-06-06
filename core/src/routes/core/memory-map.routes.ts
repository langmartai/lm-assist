/**
 * Memory Map Routes — record-level, cross-project/node map (two-level brief/complete).
 *
 * Shells out to core/scripts/memory-map.js so the HTTP API, the CLI, and the
 * Haiku agent tier all share ONE deterministic engine (no duplicated scan logic).
 * See docs/plans/2026-06-06-record-level-memory-map-and-sync.md
 */
import { execFile } from 'child_process';
import * as path from 'path';
import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'memory-map.js');
const PORT = process.env.API_PORT || (__dirname.includes('node_modules') ? '3100' : '3200');

function runMap(flags: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile('node', [SCRIPT, ...flags, '--port', PORT, '--format', 'json'],
      { maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout || 'null')); } catch (e) { reject(e); }
      });
  });
}

const FILTER_KEYS = ['level', 'projects', 'nodes', 'types', 'category', 'q', 'since', 'limit'];
function qFlags(q: Record<string, string>): string[] {
  const f: string[] = [];
  for (const k of FILTER_KEYS) if (q[k]) f.push('--' + k, q[k]);
  return f;
}

export function createMemoryMapRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /memory/map?level=brief|complete&projects=&nodes=&types=&category=&q=&since=&limit=
    {
      method: 'GET',
      pattern: /^\/memory\/map$/,
      handler: async (req) => {
        const start = Date.now();
        try { return wrapResponse(await runMap(qFlags(req.query)), start); }
        catch (e) { return wrapError('MEMORY_MAP_FAILED', String(e), start); }
      },
    },
    // GET /memory/map/stats — counts per project/node/type/category/kind
    {
      method: 'GET',
      pattern: /^\/memory\/map\/stats$/,
      handler: async (req) => {
        const start = Date.now();
        try { return wrapResponse(await runMap(['--stats', ...qFlags(req.query)]), start); }
        catch (e) { return wrapError('MEMORY_MAP_FAILED', String(e), start); }
      },
    },
    // GET /memory/record/:recordId — one complete record
    {
      method: 'GET',
      pattern: /^\/memory\/record\/(?<recordId>.+)$/,
      handler: async (req) => {
        const start = Date.now();
        try { return wrapResponse(await runMap(['--record', decodeURIComponent(req.params.recordId)]), start); }
        catch (e) { return wrapError('MEMORY_RECORD_FAILED', String(e), start); }
      },
    },
  ];
}
