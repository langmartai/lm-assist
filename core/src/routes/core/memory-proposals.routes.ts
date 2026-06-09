/**
 * Memory Proposals Routes — read-only surface for the harvester proposals file.
 *
 * The harvester (core/scripts/memory-harvest.js) writes proposed memory records
 * to ~/.lm-assist/memory-proposals.jsonl. This route exposes those proposals
 * for review — it never triggers a write or confirms a proposal.
 *
 * PROPOSE-ONLY: no POST/PUT/DELETE. Confirmation is a human/agent step.
 *
 * See docs/plans/2026-06-06-record-level-memory-map-and-sync.md §10/§12/§13.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';

const PROPOSALS_FILE = path.join(os.homedir(), '.lm-assist', 'memory-proposals.jsonl');

function readProposals(): unknown[] {
  try {
    const content = fs.readFileSync(PROPOSALS_FILE, 'utf8');
    return content
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function createMemoryProposalsRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /memory/proposals[?status=pending|accepted|rejected&project=<slug>&limit=N]
    // Returns proposals from the harvester review file (read-only).
    {
      method: 'GET',
      pattern: /^\/memory\/proposals$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          let proposals = readProposals() as Array<Record<string, unknown>>;
          const { status, project, limit } = req.query as Record<string, string>;
          if (status) proposals = proposals.filter(p => p._proposalStatus === status);
          if (project) proposals = proposals.filter(p =>
            (p.suggestedProject && String(p.suggestedProject).includes(project)) ||
            (p._originProjectSlug && String(p._originProjectSlug).includes(project))
          );
          const limitN = parseInt(limit || '0', 10);
          if (limitN > 0) proposals = proposals.slice(0, limitN);
          return wrapResponse({ proposals, total: proposals.length, file: PROPOSALS_FILE }, start);
        } catch (e) {
          return wrapError('MEMORY_PROPOSALS_FAILED', String(e), start);
        }
      },
    },
  ];
}
