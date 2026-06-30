import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mergeComposed, getComposed } from '../../fleet/footprint-compose';
import type { NodeFootprint } from '../../fleet/footprint-types';

const node = (over: Partial<NodeFootprint>): NodeFootprint => ({ node: 'x', cluster: 'prod', host: 'h', snapshotAgeSec: 0, reachable: true, warming: false, stale: false, sessions: [], ports: [], ...over });

test('mergeComposed — self + reachable peer; unreachable peer (no snap) → unreachable[] + partial', () => {
  const r = mergeComposed(node({ node: 'self' }), [{ node: 'p1', snap: node({ node: 'p1' }) }, { node: 'p2', snap: null }], 'cluster', 5);
  assert.equal(r.nodes.length, 2);
  assert.deepEqual(r.unreachable, ['p2']);
  assert.equal(r.partial, true);
  assert.equal(r.scope, 'cluster');
});

test('mergeComposed — a STALE-but-reachable peer (data present, SWR) is NOT partial', () => {
  // stale = cached snapshot past soft-TTL, refresh kicked — the data is COMPLETE, not missing.
  const r = mergeComposed(node({ node: 'self', stale: true, snapshotAgeSec: 14 }),
    [{ node: 'p1', snap: node({ node: 'p1', stale: true, snapshotAgeSec: 14 }) }], 'fleet', 5);
  assert.equal(r.partial, false);
  assert.deepEqual(r.unreachable, []);
});

test('mergeComposed — a WARMING peer (no data yet) IS partial', () => {
  const r = mergeComposed(node({ node: 'self' }),
    [{ node: 'p1', snap: node({ node: 'p1', warming: true }) }], 'fleet', 5);
  assert.equal(r.partial, true);
});

test('mergeComposed — all fresh & reachable → partial false', () => {
  const r = mergeComposed(node({ node: 'self' }), [{ node: 'p1', snap: node({ node: 'p1' }) }], 'fleet', 5);
  assert.equal(r.partial, false);
  assert.deepEqual(r.unreachable, []);
});

test('getComposed — scope=cluster filters peers to my cluster; self never fetched over relay', async () => {
  const fetched: string[] = [];
  const r = await getComposed('cluster', {
    getLocal: () => node({ node: 'self', cluster: 'prod' }),
    listOnline: async () => ['self', 'peerProd', 'peerStage'],
    clusterOf: async () => new Map([['self', 'prod'], ['peerProd', 'prod'], ['peerStage', 'stage']]),
    myCluster: () => 'prod',
    selfId: () => 'self',
    proxyGet: async (n) => { fetched.push(n); return { data: node({ node: n, cluster: 'prod' }) }; },
    now: () => 1000,
  });
  assert.deepEqual(fetched, ['peerProd']);                 // only in-cluster peer, not self, not peerStage
  assert.deepEqual(r.nodes.map((n) => n.node).sort(), ['peerProd', 'self']);
});

test('getComposed — a peer that throws → reachable:false, never rejects', async () => {
  const r = await getComposed('fleet', {
    getLocal: () => node({ node: 'self' }),
    listOnline: async () => ['self', 'bad'],
    clusterOf: async () => new Map([['self', 'prod'], ['bad', 'prod']]),
    myCluster: () => 'prod', selfId: () => 'self',
    proxyGet: async () => { throw new Error('relay down'); },
    now: () => 1,
  });
  assert.deepEqual(r.unreachable, ['bad']);
  assert.equal(r.partial, true);
});
