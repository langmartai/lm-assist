/**
 * Plans Routes
 *
 * Read-only access to Claude Code plan files from ~/.claude/plans/
 * Plans are created by EnterPlanMode/ExitPlanMode tool calls during sessions.
 *
 * Uses mtime-based caching to avoid re-reading unchanged files on every request.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';

const PLANS_DIR = path.join(os.homedir(), '.claude', 'plans');

// ─── Plan File Cache ───
interface CachedPlanFile {
  name: string;
  title: string;
  content: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
  mtimeMs: number;  // for invalidation
}

const planCache = new Map<string, CachedPlanFile>();
let listCacheDirMtimeMs = 0;

function getCachedPlan(name: string): CachedPlanFile | null {
  const filePath = path.join(PLANS_DIR, name);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    planCache.delete(name);
    return null;
  }

  const cached = planCache.get(name);
  if (cached && cached.mtimeMs === stats.mtimeMs) {
    return cached;
  }

  // Read and cache
  const content = fs.readFileSync(filePath, 'utf-8');
  const titleMatch = content.match(/^#\s+(.+)/m);
  const entry: CachedPlanFile = {
    name,
    title: titleMatch ? titleMatch[1].trim() : name.replace('.md', ''),
    content,
    size: stats.size,
    createdAt: stats.birthtime.toISOString(),
    modifiedAt: stats.mtime.toISOString(),
    mtimeMs: stats.mtimeMs,
  };
  planCache.set(name, entry);
  return entry;
}

export function createPlansRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /plans - List all plan files
    {
      method: 'GET',
      pattern: /^\/plans$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          if (!fs.existsSync(PLANS_DIR)) {
            return wrapResponse({ plans: [], total: 0 }, start);
          }

          // Check if directory has changed since last list
          let dirMtimeMs = 0;
          try {
            dirMtimeMs = fs.statSync(PLANS_DIR).mtimeMs;
          } catch {
            // ignore
          }

          const files = fs.readdirSync(PLANS_DIR)
            .filter(f => f.endsWith('.md'))
            .map(f => {
              const cached = getCachedPlan(f);
              if (!cached) return null;
              // Return without content for list endpoint
              return {
                name: cached.name,
                title: cached.title,
                size: cached.size,
                createdAt: cached.createdAt,
                modifiedAt: cached.modifiedAt,
              };
            })
            .filter(Boolean)
            .sort((a, b) => new Date(b!.modifiedAt).getTime() - new Date(a!.modifiedAt).getTime());

          // Prune cache entries for deleted files
          if (dirMtimeMs !== listCacheDirMtimeMs) {
            const fileSet = new Set(fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.md')));
            for (const key of planCache.keys()) {
              if (!fileSet.has(key)) planCache.delete(key);
            }
            listCacheDirMtimeMs = dirMtimeMs;
          }

          return wrapResponse({ plans: files, total: files.length }, start);
        } catch (e) {
          return wrapError('PLANS_LIST_ERROR', String(e), start);
        }
      },
    },

    // GET /plans/:name - Get a specific plan file content
    {
      method: 'GET',
      pattern: /^\/plans\/(?<name>[^/]+\.md)$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          const name = req.params.name;
          const filePath = path.resolve(PLANS_DIR, name);

          // Prevent path traversal
          if (!filePath.startsWith(PLANS_DIR + path.sep)) {
            return wrapError('PLAN_INVALID_NAME', `Invalid plan name: ${name}`, start);
          }

          const cached = getCachedPlan(name);
          if (!cached) {
            return wrapError('PLAN_NOT_FOUND', `Plan not found: ${name}`, start);
          }

          return wrapResponse({
            name: cached.name,
            title: cached.title,
            content: cached.content,
            size: cached.size,
            createdAt: cached.createdAt,
            modifiedAt: cached.modifiedAt,
          }, start);
        } catch (e) {
          return wrapError('PLAN_READ_ERROR', String(e), start);
        }
      },
    },
  ];
}
