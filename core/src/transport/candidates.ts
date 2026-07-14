/**
 * ICE-style candidate gathering + wire encoding for the hybrid transport.
 *
 * Each node advertises a PRIORITY-ORDERED list of UDP candidates inside the
 * single `udp` field the hub forwards verbatim on transport_offer/answer:
 *
 *   udp = { ip, port, cands: [{ip, port, kind}, ...] }
 *
 * Backward-compatible shape: the top-level `ip`/`port` remain the single BEST
 * candidate (highest priority) so an older peer that only reads `m.udp.ip` /
 * `m.udp.port` still gets a usable primary endpoint. New peers read `cands` for
 * the full ladder. If `cands` is absent (older peer), the parser synthesises a
 * single candidate from `{ip, port}`.
 *
 * Candidate kinds + priority (HIGH → LOW):
 *   host   — a non-internal IPv4 of this machine at the socket's bound port.
 *            Lets same-LAN peers (e.g. 192.0.2.17 ↔ 192.0.2.23) connect
 *            directly over the LAN with no NAT/hole-punch at all.
 *   static — a configured public endpoint (LM_ASSIST_PUBLIC_IP +
 *            LM_ASSIST_TRANSPORT_PORT). A cloud host with an open port.
 *   srflx  — server-reflexive: the STUN-discovered public NAT mapping. Reaching
 *            this requires the UDP hole punch, so it is the LOWEST priority.
 */

import * as os from 'os';
import type { UdpEndpoint } from './ws-deps';

export type CandidateKind = 'host' | 'static' | 'srflx';

export interface Candidate {
  ip: string;
  port: number;
  kind: CandidateKind;
}

/** The `udp` field carried on transport_offer/answer. */
export interface UdpAdvert {
  ip: string;
  port: number;
  cands?: Candidate[];
}

/** Numeric priority for ordering/comparison. Higher = preferred. */
export function candidatePriority(kind: CandidateKind): number {
  switch (kind) {
    case 'host': return 3;
    case 'static': return 2;
    case 'srflx': return 1;
    default: return 0;
  }
}

/** Stable sort, highest priority first. Does not mutate the input. */
export function sortCandidates(cands: Candidate[]): Candidate[] {
  return [...cands].sort((a, b) => candidatePriority(b.kind) - candidatePriority(a.kind));
}

/** Every non-internal IPv4 of this machine, at the given (bound local) port. */
export function gatherHostCandidates(localPort: number): Candidate[] {
  const out: Candidate[] = [];
  if (!localPort) return out;
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family !== 'IPv4' && info.family !== (4 as unknown as string)) continue;
      if (info.internal) continue;
      out.push({ ip: info.address, port: localPort, kind: 'host' });
    }
  }
  return out;
}

/** The configured static public endpoint, if both env vars are present. */
export function gatherStaticCandidate(): Candidate | null {
  const ip = process.env.LM_ASSIST_PUBLIC_IP;
  const port = Number(process.env.LM_ASSIST_TRANSPORT_PORT) || 0;
  if (ip && port) return { ip, port, kind: 'static' };
  return null;
}

/**
 * Build the full priority-ordered candidate list from the gathered pieces.
 * De-duplicates exact ip:port:kind repeats. Order: host(s) → static → srflx.
 */
export function buildCandidateList(
  hostCands: Candidate[],
  staticCand: Candidate | null,
  srflx: UdpEndpoint | null,
): Candidate[] {
  const all: Candidate[] = [];
  all.push(...hostCands);
  if (staticCand) all.push(staticCand);
  if (srflx) all.push({ ip: srflx.ip, port: srflx.port, kind: 'srflx' });
  const sorted = sortCandidates(all);
  const seen = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of sorted) {
    const key = `${c.ip}:${c.port}:${c.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  return deduped;
}

/**
 * Build the `udp` advert object to send on transport_open/answer. The top-level
 * ip/port mirror the single BEST candidate for backward compatibility; `cands`
 * carries the full ladder. Returns undefined when there are no candidates.
 */
export function buildUdpAdvert(cands: Candidate[]): UdpAdvert | undefined {
  if (cands.length === 0) return undefined;
  const best = cands[0];
  return { ip: best.ip, port: best.port, cands };
}

/**
 * Parse an inbound `udp` advert into a priority-ordered candidate list.
 *   - New peer: returns the advert's `cands` (re-sorted defensively).
 *   - Older peer (no `cands`, just `{ip, port}`): synthesises a single srflx
 *     candidate (the conservative assumption — a bare endpoint without a kind
 *     was the pre-ladder STUN/static mapping, reachable only by direct send).
 *   - Missing/empty: empty list.
 */
export function parseUdpAdvert(udp: unknown): Candidate[] {
  if (!udp || typeof udp !== 'object') return [];
  const u = udp as Partial<UdpAdvert>;
  if (Array.isArray(u.cands) && u.cands.length > 0) {
    const valid = u.cands.filter(
      (c): c is Candidate =>
        !!c && typeof c.ip === 'string' && typeof c.port === 'number' &&
        (c.kind === 'host' || c.kind === 'static' || c.kind === 'srflx'),
    );
    if (valid.length > 0) return sortCandidates(valid);
  }
  if (typeof u.ip === 'string' && typeof u.port === 'number') {
    return [{ ip: u.ip, port: u.port, kind: 'srflx' }];
  }
  return [];
}

/**
 * Classify a roamed/received peer source endpoint against the peer's advertised
 * candidate list, returning its kind. Used for `via()` reporting. If the source
 * matches no advertised candidate (e.g. a symmetric NAT translated the source to
 * an unexpected port), label it 'srflx' — it came through translation, the
 * lowest tier.
 */
export function classifyEndpoint(ep: UdpEndpoint, cands: Candidate[]): CandidateKind {
  for (const c of cands) {
    if (c.ip === ep.ip && c.port === ep.port) return c.kind;
  }
  return 'srflx';
}
