/**
 * Memory Auto-Sync Routes — status surface for the Stream A cross-node sync daemon.
 *
 * Mirrors the memory-map.routes.ts style (wrapResponse/wrapError). Read-only:
 * exposes the daemon's mode, counts, and recent decision log so an operator can
 * see what it detected / would sync without enabling on-mode.
 *
 * See core/src/memory/autosync.ts and
 * docs/plans/2026-06-06-record-level-memory-map-and-sync.md (§4, §10).
 */
import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';

export function createMemoryAutoSyncRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /memory/autosync/status — mode, counts, recent decisions
    {
      method: 'GET',
      pattern: /^\/memory\/autosync\/status$/,
      handler: async () => {
        const start = Date.now();
        try {
          const { getAutoSyncDaemon } = require('../../memory/autosync');
          return wrapResponse(getAutoSyncDaemon().getStatus(), start);
        } catch (e) {
          return wrapError('MEMORY_AUTOSYNC_FAILED', String(e), start);
        }
      },
    },
  ];
}
