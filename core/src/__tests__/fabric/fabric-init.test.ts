// core/src/__tests__/fabric/fabric-init.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { getFabricStatus, stopFabric, __initFabricForTest } from '../../fabric';

test('status before init reports disabled with empty peers', () => {
  stopFabric();
  const s = getFabricStatus();
  assert.equal(s.enabled, false);
  assert.deepEqual(s.peers, []);
});

test('init with injected deps exposes self + peers in status', async () => {
  __initFabricForTest({
    selfNode: 'gw4-self',
    cluster: 'default',
    listPeers: async () => [],
    makeLink: (peer) => ({ peer, core: { state: 'discovered', since: 0, attempts: 0, lastError: null }, open: async () => {}, adopt: () => {}, close: () => {}, markPeerOffline: () => {}, snapshot: () => ({ peer, state: 'connected', mode: 'bidi', via: 'host', rttMs: 2, pathInUse: 'direct', since: 0, lastError: null, attempts: 0, counters: { helloOk: 1, helloTimeouts: 0, inboundAdopted: 0 } }) }),
  });
  const s = getFabricStatus();
  assert.equal(s.enabled, true);
  assert.equal(s.self.node, 'gw4-self');
  stopFabric();
});
