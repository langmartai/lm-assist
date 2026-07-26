/**
 * Which fleet nodes hold a WORKING claude.ai web cookie — and which account.
 *
 * Some lm-assist tools are REGISTERED on every node (every node runs Core) but
 * only FUNCTIONAL where a valid claude.ai cookie lives. "Advertised" and
 * "usable" are different things, and node selection had no credential dimension
 * before this: placement was purely cluster + liveness.
 *
 * ── Why this exists as a /fleet route rather than a claude.ai one ───────────
 * `/claude-ai` is deliberately NOT on the hub relay's ALLOWED_API_PREFIXES
 * (core/src/hub-client/api-relay-handler.ts) — that surface can send messages,
 * rename and DELETE conversations on the user's real account, so it stays
 * unreachable from the hub. The consequence, measured on prod 2026-07-26:
 *
 *     auth_status({allNodes:true}) probes peers with proxyGet('/claude-ai/healthz'),
 *     which the relay rejects, so EVERY remote node reports `cookie:?` — and a
 *     reader takes that to mean "no cookie" when it actually means "not asked".
 *
 * That is precisely the trap this mission's plan §0 documents: the sweep made it
 * look like the only cookie lived on an unreachable phantom node, when the sole
 * real row was SELF (whose display name carries a "(dev)" suffix). So this
 * module exposes a NARROW, READ-ONLY, secret-free credential report under
 * `/fleet` (already relayable) instead of widening the claude.ai boundary.
 *
 * ── A display name is not an identity ──────────────────────────────────────
 * That same live sweep returned 13 rows in which `vm` appeared 4x,
 * `ubuntu-Virtual-Machine` 3x and `DESKTOP-GDKLATG` 2x, and a dev-repo Core
 * appends " (dev)" to its hostname (hub-config.ts). Every record here is
 * therefore keyed by `hostId` (the gw4-… gatewayId); `displayName` is carried
 * for humans only and must never be used to route.
 */
import type { ClaudeAIProbeResult } from '../utils/claudeai-session';

/** Transport-level reason, kept distinct from claude.ai's own probe reasons.
 *  `network_error` means THE NODE could not reach claude.ai; `node_unreachable`
 *  means WE could not reach the node. Collapsing them hides an outage. */
export type CredentialReason = ClaudeAIProbeResult['reason'] | 'unprobed' | 'node_unreachable';

export interface NodeCredential {
  /** gatewayId (gw4-…). The ONLY id anything may route on. */
  hostId: string;
  /** hostname, may carry a " (dev)" suffix and may COLLIDE across nodes. */
  displayName: string;
  cluster: string;
  isSelf: boolean;
  cookie: {
    /** the session file exists */
    configured: boolean;
    /** a live probe returned 200 — the only signal that means "usable" */
    ok: boolean;
    reason: CredentialReason;
    hint?: string;
    /** Which claude.ai ACCOUNT this cookie belongs to. Node choice implicitly
     *  selects an account, so a fork must never land somewhere silently. */
    /** claude.ai org uuid — the ACCOUNT scope this cookie acts in. */
    accountUuid?: string;
    organizationName?: string;
    /** claude.ai user id, for telling two logins apart on one org. */
    userId?: string;
    sessionKeyExpiresAt?: number | null;
  };
}

export interface ComposedCredentials {
  generatedAt: number;
  scope: 'cluster' | 'fleet';
  nodes: NodeCredential[];
  /** Nodes we could not ask. NOT the same as "nodes without a cookie". */
  unreachable: string[];
  partial: boolean;
}

const PEER_TIMEOUT_MS = 4000;
const COMPOSED_TTL_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`peer timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Pure merge. An unreachable peer is recorded as such — never as "no cookie". */
export function mergeCredentials(
  self: NodeCredential,
  peers: Array<{ node: string; snap: NodeCredential | null }>,
  scope: 'cluster' | 'fleet',
  now: number,
): ComposedCredentials {
  const nodes: NodeCredential[] = [self];
  const unreachable: string[] = [];
  for (const p of peers) {
    if (p.snap && p.snap.hostId) nodes.push(p.snap);
    else unreachable.push(p.node);
  }
  return { generatedAt: now, scope, nodes, unreachable, partial: unreachable.length > 0 };
}

/**
 * Choose a node that can actually serve a claude.ai call.
 *
 * Pure so the policy is testable without a fleet. Preference order:
 *   1. an explicitly requested hostId, but ONLY if it is credential-OK
 *   2. self, when it holds a working cookie (no hop = no relay, no extra latency)
 *   3. any other cookie-OK node, stable-sorted by hostId for determinism
 *
 * Returns `null` when nothing is eligible; the caller must then produce an
 * actionable error rather than attempting the call and surfacing a raw 401.
 */
export function pickCredentialedNode(
  composed: ComposedCredentials,
  opts: { requested?: string; selfId?: string } = {},
): { node: NodeCredential | null; reason: 'requested' | 'self' | 'peer' | 'none' | 'requested-not-eligible' } {
  const eligible = composed.nodes.filter((n) => n.cookie.ok);
  const req = (opts.requested || '').trim();
  if (req) {
    const match = composed.nodes.find((n) => n.hostId === req || n.displayName === req);
    if (match && match.cookie.ok) return { node: match, reason: 'requested' };
    // An explicit request that cannot be honoured is NOT silently rerouted:
    // the caller asked for a specific account/host and must be told.
    return { node: null, reason: 'requested-not-eligible' };
  }
  const self = eligible.find((n) => n.isSelf || (opts.selfId && n.hostId === opts.selfId));
  if (self) return { node: self, reason: 'self' };
  const sorted = [...eligible].sort((a, b) => a.hostId.localeCompare(b.hostId));
  if (sorted.length) return { node: sorted[0], reason: 'peer' };
  return { node: null, reason: 'none' };
}

/**
 * Human-readable, ACTIONABLE refusal. Never a raw 401/HTML.
 * Names eligible hostIds, distinguishes "no cookie" from "could not ask", and
 * points at the remedy.
 */
export function describeNoCredential(
  composed: ComposedCredentials,
  requested?: string,
): string {
  const eligible = composed.nodes.filter((n) => n.cookie.ok);
  const lines: string[] = [];
  if (requested) {
    const match = composed.nodes.find((n) => n.hostId === requested || n.displayName === requested);
    if (!match) lines.push(`No node matches node="${requested}".`);
    else lines.push(`node="${requested}" (${match.hostId}) has no usable claude.ai cookie — ${match.cookie.reason}.`);
  } else {
    lines.push('No reachable node holds a usable claude.ai web cookie.');
  }
  if (eligible.length) {
    lines.push('');
    lines.push('Nodes that CAN serve this call (pass one as `node`):');
    for (const n of eligible) {
      const acct = n.cookie.organizationName
        ? ` — account: ${n.cookie.organizationName}`
        : n.cookie.accountUuid ? ` — account org: ${n.cookie.accountUuid}` : '';
      lines.push(`  • ${n.hostId}  (${n.displayName})${acct}`);
    }
  } else {
    lines.push('');
    lines.push('Per-node status:');
    for (const n of composed.nodes) {
      lines.push(`  • ${n.hostId}  (${n.displayName})  cookie: ${n.cookie.reason}`);
    }
    lines.push('');
    lines.push('Remedy: run `claudeai_login` on a node with a desktop browser. The cookie is');
    lines.push('IP-pinned to the host that captured it and cannot be copied between nodes.');
  }
  if (composed.unreachable.length) {
    lines.push('');
    lines.push(
      `Could NOT be checked (offline or relay-blocked — this is NOT "no cookie"): ${composed.unreachable.join(', ')}`,
    );
  }
  return lines.join('\n');
}

export interface CredentialDeps {
  getLocal: () => Promise<NodeCredential>;
  listOnline: () => Promise<string[]>;
  clusterMap: () => Promise<Map<string, string>>;
  myCluster: () => string;
  selfId: () => string;
  proxyGet: (node: string, path: string) => Promise<unknown>;
  now: () => number;
}

let _cache: { at: number; scope: string; value: ComposedCredentials } | null = null;

/** Reset the memo — tests only. */
export function _resetCredentialCache(): void {
  _cache = null;
}

export async function getCredentialFleet(
  scope: 'cluster' | 'fleet',
  deps: CredentialDeps,
): Promise<ComposedCredentials> {
  const t = deps.now();
  if (_cache && _cache.scope === scope && t - _cache.at < COMPOSED_TTL_MS) return _cache.value;

  const self = await deps.getLocal();
  const [online, clusterMap] = await Promise.all([
    deps.listOnline().catch(() => [] as string[]),
    deps.clusterMap().catch(() => new Map<string, string>()),
  ]);
  const selfId = deps.selfId();
  const mine = deps.myCluster();
  const peerIds = online
    .filter((n) => n && n !== selfId)
    .filter((n) => scope === 'fleet' || clusterMap.get(n) === mine);

  const peers = await Promise.all(
    peerIds.map(async (n) => {
      try {
        const res = (await withTimeout(deps.proxyGet(n, '/fleet/credentials/local'), PEER_TIMEOUT_MS)) as
          | { data?: NodeCredential }
          | NodeCredential;
        const snap = ((res as { data?: NodeCredential })?.data ?? res) as NodeCredential;
        return { node: n, snap: snap && snap.hostId ? snap : null };
      } catch {
        return { node: n, snap: null };
      }
    }),
  );

  const value = mergeCredentials(self, peers, scope, deps.now());
  _cache = { at: t, scope, value };
  return value;
}
