/**
 * Health & Status Routes (lm-assist)
 *
 * Endpoints: /health, /status
 */

import type { RouteHandler, RouteContext } from '../index';

export function createHealthRoutes(ctx: RouteContext): RouteHandler[] {
  return [
    // GET /health - Health check
    {
      method: 'GET',
      pattern: /^\/health$/,
      handler: async (req, api) => api.monitor.getHealth(),
    },

    // GET /status - Status info
    {
      method: 'GET',
      pattern: /^\/status$/,
      handler: async (req, api) => api.monitor.getStatus(),
    },
  ];
}
