import type { NodeFootprint, ComposedFootprints } from './footprint-types';

const COMPOSED_TTL_MS = 5000;

export function mergeComposed(
  self: NodeFootprint,
  peers: Array<{ node: string; snap: NodeFootprint | null }>,
  scope: 'cluster' | 'fleet',
  now: number,
): ComposedFootprints {
  const nodes: NodeFootprint[] = [self];
  const unreachable: string[] = [];
  for (const p of peers) {
    if (p.snap) nodes.push(p.snap);
    else unreachable.push(p.node);
  }
  const partial = unreachable.length > 0 || nodes.some((n) => n.warming || n.stale || !n.reachable);
  return { generatedAt: now, scope, nodes, unreachable, partial };
}

export interface ComposeDeps {
  getLocal: () => NodeFootprint;
  listOnline: () => Promise<string[]>;
  clusterOf: () => Promise<Map<string, string>>;
  myCluster: () => string;
  selfId: () => string;
  proxyGet: (node: string, path: string) => Promise<unknown>;
  now: () => number;
}

let _cache: { at: number; scope: string; value: ComposedFootprints } | null = null;

export async function getComposed(scope: 'cluster' | 'fleet', deps: ComposeDeps): Promise<ComposedFootprints> {
  const t = deps.now();
  if (_cache && _cache.scope === scope && t - _cache.at < COMPOSED_TTL_MS) return _cache.value;

  const self = deps.getLocal();
  const [online, clusterMap] = await Promise.all([deps.listOnline().catch(() => [] as string[]), deps.clusterOf().catch(() => new Map<string, string>())]);
  const selfId = deps.selfId();
  const mine = deps.myCluster();
  const peerIds = online.filter((n) => n !== selfId).filter((n) => scope === 'fleet' || clusterMap.get(n) === mine);

  const peers = await Promise.all(peerIds.map(async (n) => {
    try {
      const res = (await deps.proxyGet(n, '/fleet/session-footprints/local')) as { data?: NodeFootprint } | NodeFootprint;
      const snap = (res as any)?.data ?? res;
      return { node: n, snap: snap && (snap as NodeFootprint).node ? (snap as NodeFootprint) : null };
    } catch {
      return { node: n, snap: null };
    }
  }));

  const value = mergeComposed(self, peers, scope, deps.now());
  _cache = { at: t, scope, value };
  return value;
}
