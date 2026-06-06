/**
 * Memory Reconcile Routes -- read-only surface for the reconciliation plan file.
 *
 * The reconciler (core/scripts/memory-reconcile.js) writes proposed reconciliation
 * decisions to ~/.lm-assist/memory-reconcile-plan.jsonl. This route exposes those
 * plan items for review -- it never triggers a write, merge, or delete.
 *
 * PLAN-ONLY: no POST/PUT/DELETE. Execution is a human/agent step.
 *
 * See docs/plans/2026-06-06-record-level-memory-map-and-sync.md sec 9, 12, 13.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';

const PLAN_FILE = path.join(os.homedir(), '.lm-assist', 'memory-reconcile-plan.jsonl');

function readPlan(): unknown[] {
  try {
    const content = fs.readFileSync(PLAN_FILE, 'utf8');
    return content
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function createMemoryReconcileRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /memory/reconcile/plan[?planType=divergent-mirror|dependency-edge|outdated-record|summary
    //                             &status=proposed|applied|rejected
    //                             &limit=N]
    // Returns reconciliation plan items (read-only).
    {
      method: 'GET',
      pattern: /^\/memory\/reconcile\/plan$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          let items = readPlan() as Array<Record<string, unknown>>;
          const { planType, status, limit } = req.query as Record<string, string>;
          if (planType) items = items.filter(p => p.planType === planType);
          if (status)   items = items.filter(p => p._planStatus === status);
          const limitN = parseInt(limit || '0', 10);
          if (limitN > 0) items = items.slice(0, limitN);
          return wrapResponse({ items, total: items.length, file: PLAN_FILE }, start);
        } catch (e) {
          return wrapError('MEMORY_RECONCILE_PLAN_FAILED', String(e), start);
        }
      },
    },
  ];
}
