// core/src/__tests__/fabric/peer-manager.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PeerManager } from '../../fabric/peer-manager';
import type { LinkCore } from '../../fabric/link-state';

function fakeLink(peer: string) {
  const calls: string[] = [];
  const core: LinkCore = { state: 'discovered', since: 0, attempts: 0, lastError: null };
  return {
    peer, core, calls,
    open: async () => { calls.push('open'); core.state = 'connected'; },
    adopt: () => { calls.push('adopt'); core.state = 'connected'; },
    close: () => { calls.push('close'); core.state = 'idle'; },
    markPeerOffline: () => { calls.push('offline'); core.state = 'idle'; },
    snapshot: () => ({ peer, state: core.state, mode: null, via: null, rttMs: null, pathInUse: null, since: 0, lastError: core.lastError, attempts: core.attempts, counters: { helloOk: 0, helloTimeouts: 0, inboundAdopted: 0 } }),
  };
}

test('reconcile opens links to new online peers and retires offline ones', async () => {
  const links = new Map<string, ReturnType<typeof fakeLink>>();
  let online = ['gw4-b', 'gw4-c'];
  const pm = new PeerManager({
    listPeers: async () => online,
    makeLink: (p) => { const l = fakeLink(p); links.set(p, l); return l; },
    now: () => 1000,
  });
  await pm.reconcile();
  assert.deepEqual([...links.keys()].sort(), ['gw4-b', 'gw4-c']);
  assert.deepEqual(links.get('gw4-b')!.calls, ['open']);

  online = ['gw4-b'];                    // c went offline
  await pm.reconcile();
  assert.ok(links.get('gw4-c')!.calls.includes('offline'));
  assert.equal(links.get('gw4-b')!.calls.filter((c) => c === 'open').length, 1); // not reopened
});

test('failed link retries only after backoff elapses', async () => {
  let now = 0;
  const l = fakeLink('gw4-b');
  l.open = async () => { l.calls.push('open'); l.core.state = 'failed'; l.core.attempts += 1; l.core.since = now; };
  const pm = new PeerManager({ listPeers: async () => ['gw4-b'], makeLink: () => l, now: () => now });
  await pm.reconcile();                  // first open → failed, attempts=1 (backoff 30s)
  assert.equal(l.calls.filter((c) => c === 'open').length, 1);
  now = 10_000; await pm.reconcile();    // 10s < 30s → no retry
  assert.equal(l.calls.filter((c) => c === 'open').length, 1);
  now = 31_000; await pm.reconcile();    // backoff elapsed → retry
  assert.equal(l.calls.filter((c) => c === 'open').length, 2);
});

test('acceptInbound adopts on the peer link (creating it if unknown)', async () => {
  const links = new Map<string, ReturnType<typeof fakeLink>>();
  const pm = new PeerManager({ listPeers: async () => [], makeLink: (p) => { const l = fakeLink(p); links.set(p, l); return l; }, now: () => 0 });
  pm.acceptInbound({ peerGatewayId: 'gw4-z' } as never);
  assert.deepEqual(links.get('gw4-z')!.calls, ['adopt']);
  assert.equal(pm.snapshot().length, 1);
});

test('reconcile with enabled:false closes existing links, clears the map, and skips listPeers/open', async () => {
  const links = new Map<string, ReturnType<typeof fakeLink>>();
  let listPeersCalls = 0;
  let enabled = true;
  const pm = new PeerManager({
    listPeers: async () => { listPeersCalls++; return ['gw4-b']; },
    makeLink: (p) => { const l = fakeLink(p); links.set(p, l); return l; },
    now: () => 0,
    enabled: () => enabled,
  });
  await pm.reconcile();                    // enabled=true → establishes gw4-b normally
  assert.equal(pm.snapshot().length, 1);
  assert.equal(links.get('gw4-b')!.calls.filter((c) => c === 'open').length, 1);
  listPeersCalls = 0;                       // isolate the flip

  enabled = false;
  await pm.reconcile();
  assert.ok(links.get('gw4-b')!.calls.includes('close'));
  assert.equal(pm.snapshot().length, 0);
  assert.equal(listPeersCalls, 0);          // roster not consulted on the disabled path
  assert.equal(links.get('gw4-b')!.calls.filter((c) => c === 'open').length, 1); // not reopened
});

test('retryFailedNow resets a failed link and re-opens immediately despite fresh (un-elapsed) backoff', async () => {
  const now = 700_000; // fixed "wall clock" past the 600s backoff cap, well past the 30s base
  const l = fakeLink('gw4-b');
  l.open = async () => { l.calls.push('open'); l.core.state = 'failed'; l.core.attempts += 1; l.core.since = now; };
  (l as unknown as { resetRetry: () => void }).resetRetry = () => {
    if (l.core.state === 'failed') { l.core.attempts = 0; l.core.since = 0; }
  };
  const pm = new PeerManager({ listPeers: async () => ['gw4-b'], makeLink: () => l, now: () => now });

  await pm.reconcile();                     // new peer → open() unconditionally → failed, attempts=1, since=now (fresh)
  assert.equal(l.calls.filter((c) => c === 'open').length, 1);

  await pm.reconcile();                     // same `now` → backoff not elapsed → NOT retried
  assert.equal(l.calls.filter((c) => c === 'open').length, 1);

  pm.retryFailedNow();                      // resets attempts/since (since→0), then kicks reconcile
  await new Promise((r) => setImmediate(r));
  assert.equal(l.calls.filter((c) => c === 'open').length, 2);
});

test('stop() closes all links and clears the map', async () => {
  const links = new Map<string, ReturnType<typeof fakeLink>>();
  const pm = new PeerManager({
    listPeers: async () => ['gw4-b', 'gw4-c'],
    makeLink: (p) => { const l = fakeLink(p); links.set(p, l); return l; },
    now: () => 0,
  });
  await pm.reconcile();
  assert.equal(pm.snapshot().length, 2);

  pm.stop();
  assert.ok(links.get('gw4-b')!.calls.includes('close'));
  assert.ok(links.get('gw4-c')!.calls.includes('close'));
  assert.equal(pm.snapshot().length, 0);
});

test('roster failure keeps current state', async () => {
  const links = new Map<string, ReturnType<typeof fakeLink>>();
  let fail = false;
  const pm = new PeerManager({
    listPeers: async () => { if (fail) throw new Error('roster unavailable'); return ['gw4-b']; },
    makeLink: (p) => { const l = fakeLink(p); links.set(p, l); return l; },
    now: () => 0,
  });
  await pm.reconcile();                     // establishes gw4-b (fakeLink.open → connected)
  assert.equal(links.get('gw4-b')!.core.state, 'connected');

  fail = true;
  await pm.reconcile();                     // roster unavailable → keep current state
  const calls = links.get('gw4-b')!.calls;
  assert.ok(!calls.includes('offline'));
  assert.ok(!calls.includes('close'));
  assert.equal(pm.snapshot().length, 1);
  assert.equal(links.get('gw4-b')!.core.state, 'connected');
});
