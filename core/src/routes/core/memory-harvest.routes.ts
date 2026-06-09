/**
 * Memory Harvest Routes -- status surface for the periodic harvest daemon.
 *
 * Mirrors memory-autosync.routes.ts style (wrapResponse/wrapError). Read-only:
 * exposes the daemon enabled state, interval, and last-run metrics so an
 * operator can confirm the daemon is off (default) or check its last tick.
 *
 * See core/src/memory/harvest-daemon.ts and
 * docs/plans/2026-06-06-record-level-memory-map-and-sync.md
 */
import type { RouteHandler, RouteContext } from "../index";
import { wrapResponse, wrapError } from "../../api/helpers";

export function createMemoryHarvestRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /memory/harvest/status -- enabled, interval, lastRunMs, nextRunMs, running, lastProposalCount
    {
      method: "GET",
      pattern: /^\/memory\/harvest\/status$/,
      handler: async () => {
        const start = Date.now();
        try {
          const { getHarvestDaemon } = require("../../memory/harvest-daemon");
          return wrapResponse(getHarvestDaemon().getStatus(), start);
        } catch (e) {
          return wrapError("MEMORY_HARVEST_FAILED", String(e), start);
        }
      },
    },
  ];
}
