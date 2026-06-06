/**
 * Rule Map Routes — record-level, cross-project/node RULES map (two-level brief/complete).
 *
 * The sibling of memory-map.routes.ts, but for Claude Code RULES
 * (`.claude/rules/**.md`, USER + PROJECT scope). Shells out to
 * core/scripts/rule-map.js so the HTTP API, the CLI, and any agent tier all
 * share ONE deterministic engine (no duplicated scan logic).
 * See docs/plans/2026-06-06-rules-map-and-sync.md
 */
import { execFile } from 'child_process';
import * as path from 'path';
import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'rule-map.js');
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

const FILTER_KEYS = ['level', 'projects', 'nodes', 'category', 'scope', 'paths', 'q', 'limit'];
function qFlags(q: Record<string, string>): string[] {
  const f: string[] = [];
  for (const k of FILTER_KEYS) if (q[k]) f.push('--' + k, q[k]);
  if (q.always === '1' || q.always === 'true') f.push('--always');
  return f;
}

export function createRuleMapRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /rules/map?level=brief|complete&projects=&nodes=&category=&scope=&paths=&always=&q=&limit=
    {
      method: 'GET',
      pattern: /^\/rules\/map$/,
      handler: async (req) => {
        const start = Date.now();
        try { return wrapResponse(await runMap(qFlags(req.query)), start); }
        catch (e) { return wrapError('RULE_MAP_FAILED', String(e), start); }
      },
    },
    // GET /rules/map/stats — counts per project/node/scope/loadCondition/category
    {
      method: 'GET',
      pattern: /^\/rules\/map\/stats$/,
      handler: async (req) => {
        const start = Date.now();
        try { return wrapResponse(await runMap(['--stats', ...qFlags(req.query)]), start); }
        catch (e) { return wrapError('RULE_MAP_FAILED', String(e), start); }
      },
    },
    // GET /rules/rule/:id — one complete rule record
    {
      method: 'GET',
      pattern: /^\/rules\/rule\/(?<id>.+)$/,
      handler: async (req) => {
        const start = Date.now();
        try { return wrapResponse(await runMap(['--record', decodeURIComponent(req.params.id)]), start); }
        catch (e) { return wrapError('RULE_RECORD_FAILED', String(e), start); }
      },
    },
  ];
}
