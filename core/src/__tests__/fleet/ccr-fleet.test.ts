import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeCcrFleet, getCcrFleet, _resetCcrFleetCache, type CcrNodeSnapshot, type CcrFleetDeps } from '../../fleet/ccr-fleet';

const snap = (node: string, locals: unknown[] = []): CcrNodeSnapshot => ({
  node, remotes: [], rc: { controller: null, executors: [], accountRc: [] }, locals, collectedAt: 1,
});

test('mergeCcrFleet: self first, reachable peers appended, unreachable listed → partial', () => {
  const v = mergeCcrFleet(snap('gw-a'), [{ sid: 'cse_1' }], [
    { node: 'gw-b', snap: snap('gw-b') },
    { node: 'gw-c', snap: null },
  ], 'gw-a', 123);
  assert.equal(v.self, 'gw-a');
  assert.equal(v.generatedAt, 123);
  assert.deepEqual(v.nodes.map((n) => n.node), ['gw-a', 'gw-b']);
  assert.deepEqual(v.unreachable, ['gw-c']);
  assert.equal(v.partial, true);
  assert.equal(v.cloud.length, 1);
});

test('mergeCcrFleet: all reachable → not partial', () => {
  const v = mergeCcrFleet(snap('gw-a'), [], [{ node: 'gw-b', snap: snap('gw-b') }], 'gw-a', 5);
  assert.equal(v.partial, false);
  assert.deepEqual(v.unreachable, []);
});

function deps(over: Partial<CcrFleetDeps> = {}): CcrFleetDeps {
  let t = 1000;
  return {
    getLocal: async () => snap('gw-self', [{ sessionId: 's1' }]),
    getCloud: async () => [{ sid: 'cse_x' }],
    listOnline: async () => ['gw-self', 'gw-peer'],
    selfId: () => 'gw-self',
    proxyGet: async (_node, path) => {
      assert.equal(path, '/fleet/ccr/local');
      return { data: snap('gw-peer') };
    },
    now: () => (t += 1),
    ...over,
  };
}

test('getCcrFleet: composes self + peers, unwraps ApiResponse envelopes, skips self in peer list', async () => {
  _resetCcrFleetCache();
  const calls: string[] = [];
  const v = await getCcrFleet(deps({
    proxyGet: async (node, path) => { calls.push(`${node}${path}`); return { data: snap('gw-peer') }; },
  }));
  assert.deepEqual(calls, ['gw-peer/fleet/ccr/local']); // never proxies to itself
  assert.deepEqual(v.nodes.map((n) => n.node), ['gw-self', 'gw-peer']);
  assert.equal(v.partial, false);
  assert.deepEqual(v.cloud, [{ sid: 'cse_x' }]);
});

test('getCcrFleet: peer error → unreachable + partial, cloud error → empty cloud (never throws)', async () => {
  _resetCcrFleetCache();
  const v = await getCcrFleet(deps({
    getCloud: async () => { throw new Error('claude.ai down'); },
    proxyGet: async () => { throw new Error('peer down'); },
  }));
  assert.deepEqual(v.nodes.map((n) => n.node), ['gw-self']);
  assert.deepEqual(v.unreachable, ['gw-peer']);
  assert.equal(v.partial, true);
  assert.deepEqual(v.cloud, []);
});

test('getCcrFleet: a peer returning a shapeless payload counts as unreachable', async () => {
  _resetCcrFleetCache();
  const v = await getCcrFleet(deps({ proxyGet: async () => ({ data: { nope: true } }) }));
  assert.deepEqual(v.unreachable, ['gw-peer']);
});

test('getCcrFleet: cloud failure after a success serves the LAST-GOOD list + cloudError', async () => {
  _resetCcrFleetCache();
  let fail = false;
  let t = 1000;
  const d = deps({
    now: () => t,
    getCloud: async () => { if (fail) throw new Error('401 storm'); return [{ sid: 'cse_good' }]; },
  });
  const first = await getCcrFleet(d);
  assert.equal(first.cloud.length, 1);
  assert.equal(first.cloudError, undefined);
  fail = true; t = 10_000; // past the composed TTL → recompose with a failing cloud fetch
  const second = await getCcrFleet(d);
  assert.deepEqual(second.cloud, [{ sid: 'cse_good' }]); // stale-while-error, not empty
  assert.match(String(second.cloudError), /401 storm/);
  _resetCcrFleetCache();
});

test('getCcrFleet: composed result is cached within the TTL (one getLocal per window)', async () => {
  _resetCcrFleetCache();
  let localCalls = 0;
  const d = deps({ getLocal: async () => { localCalls += 1; return snap('gw-self'); }, now: () => 5000 });
  await getCcrFleet(d);
  await getCcrFleet(d);
  assert.equal(localCalls, 1);
  _resetCcrFleetCache();
});
