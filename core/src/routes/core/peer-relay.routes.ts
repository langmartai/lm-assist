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
 * Confinement: only the web features' surfaces are forwardable — memory/rules
 * (`/memory…`, `/rules…`) and the CCR page's per-session operations on a peer
 * (`/ccr…`, `/terminal/cc-sessions…`, `/sessions…` reads, `/mission/session…`
 * drive/answer, `/session-messages…`) — no traversal, and a request that
 * ITSELF arrived via the hub relay is refused (no relay chaining).
 */
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { getHubConfig } from '../../hub-client/hub-config';
import { proxyUrlPath } from '../../memory/mcp-transport';

const NODE_RE = /^[A-Za-z0-9._-]+$/;
// The relayable surface. memory/rules = the memory+rules web UI; the rest is the
// CCR page operating on a PEER's sessions from a LAN browser (list ops go through
// the /fleet/ccr aggregate — these are the per-session read/drive/bridge paths).
const PATH_RE = /^\/(memory|rules|ccr|terminal\/cc-sessions|sessions|mission\/session|session-messages)(\/|$)/;

/**
 * Pure: validate + canonicalize the forward target. Returns null when refused.
 *
 * The route matches against the raw (percent-encoded) pathname, so validating
 * the raw string would let an ENCODED traversal through — `/memory/%2e%2e/hub`
 * passes a naive `PATH_RE`/`includes('..')` check yet decodes to
 * `/memory/../hub`. We must never rely on a downstream (hub proxy / peer)
 * NOT decoding it. So: fully decode (iteratively, to defeat double-encoding),
 * validate the DECODED form, and forward THAT canonical form. Legitimate
 * memory/rules paths are unreserved-only (project slugs `[A-Za-z0-9._-]`,
 * `*.md` filenames) so the decoded form has nothing left to re-interpret.
 */
export function peerForwardPath(rest: string): string | null {
  if (!rest.startsWith('/')) rest = '/' + rest;
  let decoded = rest;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try { next = decodeURIComponent(decoded); } catch { return null; } // malformed %-escape
    if (next === decoded) break;
    decoded = next;
  }
  // Reject traversal, separators, and control/null bytes in the DECODED form.
  if (decoded.includes('..') || decoded.includes('\\') || /[\u0000-\u001f\u007f ]/.test(decoded)) return null;
  // Only /memory… and /rules… are relayable.
  if (!PATH_RE.test(decoded)) return null;
  return decoded;
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
    // peerForwardPath fully decodes + validates, returning the canonical
    // (unreserved-only) path we forward — so an ENCODED traversal cannot slip
    // past the allow-list on the strength of a downstream decode.
    const fwd = peerForwardPath(req.params.rest || '');
    if (!fwd) return wrapError('INVALID_INPUT', 'INVALID_INPUT: path is outside the relayable surface (memory/rules/ccr/cc-sessions/sessions/mission-session/session-messages)', start);

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
