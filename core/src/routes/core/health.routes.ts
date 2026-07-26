/**
 * Health & Status Routes (lm-assist)
 *
 * Endpoints: /health, /status, /auth/is-local
 */

import { networkInterfaces } from 'os';
import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse } from '../../api/helpers';
import { getEventLoopMonitor } from '../../diagnostics/event-loop-monitor';

/** Get all local IPv4 addresses (loopback + LAN) */
function getLocalAddresses(): Set<string> {
  const addrs = new Set<string>(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces || []) {
      addrs.add(iface.address);
      if (iface.family === 'IPv4') {
        addrs.add(`::ffff:${iface.address}`);
      }
    }
  }
  return addrs;
}

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

    // GET /diagnostics/event-loop - Full event-loop lag picture + top blockers.
    // Core is single-threaded: this is how you tell "the server is slow" apart from
    // "the loop was blocked before the handler ever ran".
    {
      method: 'GET',
      pattern: /^\/diagnostics\/event-loop$/,
      handler: async () => {
        const start = Date.now();
        return wrapResponse(getEventLoopMonitor().snapshot(), start);
      },
    },

    // POST /diagnostics/event-loop/reset - Start a fresh measurement window,
    // so a before/after comparison isn't diluted by history.
    {
      method: 'POST',
      pattern: /^\/diagnostics\/event-loop\/reset$/,
      handler: async () => {
        const start = Date.now();
        getEventLoopMonitor().reset();
        return wrapResponse({ reset: true }, start);
      },
    },

    // GET /auth/is-local - Check if request originates from this machine
    {
      method: 'GET',
      pattern: /^\/auth\/is-local$/,
      handler: async (req) => {
        const start = Date.now();
        const clientIp = req.clientIp || '';
        const localAddrs = getLocalAddresses();
        const isLocal = localAddrs.has(clientIp);
        return wrapResponse({ isLocal }, start);
      },
    },
  ];
}
