/**
 * Memory Validate Routes -- read-only surface for the deep-validation plan file.
 *
 * The validator (core/scripts/memory-validate.js) writes deep-verify verdicts
 * to ~/.lm-assist/memory-validate-plan.jsonl. This route exposes those plan
 * items for review -- it never triggers a write, edit, or any mutation.
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

const PLAN_FILE = path.join(os.homedir(), '.lm-assist', 'memory-validate-plan.jsonl');

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

export function createMemoryValidateRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /memory/validate/plan[?validationTier=code-confirmed|session-confirmed|asserted|unvalidated
    //                            &validity=current|outdated|superseded|invalid
    //                            &status=proposed|applied|rejected
    //                            &project=<slug>
    //                            &limit=N]
    // Returns deep-validation plan items (read-only).
    {
      method: 'GET',
      pattern: /^\/memory\/validate\/plan$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          let items = readPlan() as Array<Record<string, unknown>>;
          const { validationTier, validity, status, project, limit } = req.query as Record<string, string>;
          if (validationTier) items = items.filter(p => p.validationTier === validationTier);
          if (validity)       items = items.filter(p => p.validity === validity);
          if (status)         items = items.filter(p => p._planStatus === status);
          if (project)        items = items.filter(p =>
            (p._recordProject && String(p._recordProject).includes(project)) ||
            (p.recordId && String(p.recordId).includes(project))
          );
          const limitN = parseInt(limit || '0', 10);
          if (limitN > 0) items = items.slice(0, limitN);
          return wrapResponse({ items, total: items.length, file: PLAN_FILE }, start);
        } catch (e) {
          return wrapError('MEMORY_VALIDATE_PLAN_FAILED', String(e), start);
        }
      },
    },
  ];
}
