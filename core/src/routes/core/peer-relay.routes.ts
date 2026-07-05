/**
 * Peer relay — lets the WEB UI operate on another node's memory/rules through
 * THIS node's Core, server-side, instead of the browser calling the hub
 * gateway directly (which is cross-origin from a LAN page and cloud-login
 * gated → TypeError: Failed to fetch).
 *
 *   ANY /peer-relay/:node/<memory-or-rules path>   →   hub machine-proxy → peer Core
 *
 * Transport mirrors memory/mcp-transport.ts: `<hub http base>/api/tier-agent/
 * machines/<node>/proxy<path>` with this node's own hub Bearer key; the peer's
 * relay handler injects the peer's worker token (same trust model as every
 * relayed mutation — approved in the memory+rules web UI spec).
 *
 * Confinement: only `/memory…` and `/rules…` paths are forwardable (exactly
 * the web feature's surface), no traversal, and a request that ITSELF arrived
 * via the hub relay is refused (no relay chaining).
 */
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { getHubConfig } from '../../hub-client/hub-config';
import { proxyUrlPath } from '../../memory/mcp-transport';

const NODE_RE = /^[A-Za-z0-9._-]+$/;
const PATH_RE = /^\/(memory|rules)(\/|$)/;

/** Pure: validate + normalize the forward target. Returns null when refused. */
export function peerForwardPath(rest: string): string | null {
  if (!rest.startsWith('/')) rest = '/' + rest;
  if (rest.includes('..') || rest.includes('\\')) return null;
  if (!PATH_RE.test(rest)) return null;
  return rest;
}

function relaySource(req: ParsedRequest): string | undefined {
  const v = req.headers?.['x-relay-source'];
  return Array.isArray(v) ? v[0] : v;
}

function hubHttpBase(): string {
  const cfg = getHubConfig();
  return (cfg.hubUrl || '').replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
}

export function createPeerRelayRoutes(_ctx: RouteContext): RouteHandler[] {
  const handler = async (req: ParsedRequest) => {
    const start = Date.now();
    if (relaySource(req) === 'hub') {
      return wrapError('PEER_RELAY_CHAIN', 'PEER_RELAY_CHAIN: refusing to relay a relayed request', start);
    }
    const node = decodeURIComponent(req.params.node || '');
    if (!NODE_RE.test(node)) return wrapError('INVALID_INPUT', `INVALID_INPUT: bad node id`, start);
    // rest is forwarded AS-RECEIVED (no decode) so any percent-encoding in
    // filenames survives intact to the peer.
    const fwd = peerForwardPath(req.params.rest || '');
    if (!fwd) return wrapError('INVALID_INPUT', 'INVALID_INPUT: only /memory and /rules paths are relayable', start);

    const cfg = getHubConfig();
    const base = hubHttpBase();
    if (!base || !cfg.apiKey) return wrapError('HUB_NOT_CONFIGURED', 'HUB_NOT_CONFIGURED: this node has no hub credentials', start);

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query || {})) if (v !== undefined) qs.set(k, String(v));
    const url = `${base}${proxyUrlPath(node, fwd)}${qs.toString() ? `?${qs.toString()}` : ''}`;

    try {
      const init: RequestInit = {
        method: req.method,
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      };
      if (req.body !== undefined && req.method !== 'GET') init.body = JSON.stringify(req.body ?? {});
      const res = await fetch(url, init);
      const text = await res.text();
      try {
        // Peer Cores answer with the standard ApiResponse envelope (success/data/error)
        // — pass it through so error codes like HASH_MISMATCH reach the web intact.
        return JSON.parse(text);
      } catch {
        return wrapError('PEER_UNREACHABLE', `PEER_UNREACHABLE: hub ${res.status} ${text.slice(0, 200)}`, start);
      }
    } catch (e) {
      return wrapError('PEER_UNREACHABLE', `PEER_UNREACHABLE: ${String(e).slice(0, 200)}`, start);
    }
  };

  const pattern = /^\/peer-relay\/(?<node>[^/]+)\/(?<rest>.+)$/;
  return ['GET', 'PUT', 'POST', 'DELETE'].map((method) => ({ method, pattern, handler }));
}
