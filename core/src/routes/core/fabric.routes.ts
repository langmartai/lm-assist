/**
 * Fabric + general status routes (spec N4).
 *   GET /fabric/status  → this node's peer-link table + resolution counters
 *   GET /status/full    → StatusRegistry snapshot (?section=<name> filters)
 */
import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { getFabricStatus, fabricProbe } from '../../fabric';
import { getStatusSnapshot, registerCoreStatusProviders } from '../../status/status-registry';
import { getResolutionService } from '../../resolution';

export function createFabricRoutes(_ctx: RouteContext): RouteHandler[] {
  registerCoreStatusProviders(); // idempotent — first registration point at boot
  return [
    {
      method: 'GET',
      pattern: /^\/fabric\/status$/,
      handler: async () => {
        const start = Date.now();
        const status = getFabricStatus();
        return wrapResponse({ ...status, resolution: getResolutionService().counters() }, start);
      },
    },
    {
      method: 'GET',
      pattern: /^\/fabric\/probe$/,
      handler: async (req) => {
        const start = Date.now();
        const node = typeof req.query?.node === 'string' ? req.query.node.trim() : '';
        if (!node) return wrapError('BAD_REQUEST', 'node query param required', start);
        const result = await fabricProbe(node);
        return wrapResponse(result, start);
      },
    },
    {
      method: 'GET',
      pattern: /^\/status\/full$/,
      handler: async (req) => {
        const start = Date.now();
        const section = typeof req.query?.section === 'string' ? req.query.section : undefined;
        const sections = await getStatusSnapshot(section);
        return wrapResponse({ sections }, start);
      },
    },
  ];
}
