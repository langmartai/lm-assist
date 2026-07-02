// core/src/__tests__/fabric/peer-link.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PeerLink, type LinkChannel } from '../../fabric/peer-link';
import { encodeFabricControl, FABRIC_TAG, FABRIC_VERSION } from '../../fabric/protocol';

function fakeCh(over: Partial<LinkChannel> = {}) {
  const sent: Buffer[] = [];
  let dataCb: ((d: Buffer) => void) | null = null;
  const ch = {
    mode: 'bidi' as const, via: 'host' as const, rtt: 3,
    sendControl: (b: Buffer) => sent.push(b),
    onData: (cb: (d: Buffer) => void) => { dataCb = cb; },
    onClose: (_cb: (r?: string) => void) => {},
    close: () => {},
    ...over,
  };
  return { ch: ch as LinkChannel, sent, reply: (b: Buffer) => dataCb && dataCb(b) };
}
const ack = () => encodeFabricControl({ type: FABRIC_TAG, kind: 'hello-ack', version: FABRIC_VERSION, features: [], node: 'gw4-peer' });

test('initiator: open sends hello, ack confirms → connected, policy direct on host', async () => {
  const f = fakeCh();
  const link = new PeerLink('gw4-peer', { openChannel: async () => f.ch, selfNode: 'gw4-self', now: () => 1, helloTimeoutMs: 1000 });
  const opening = link.open();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.sent.length, 1); // hello went out on the relay floor
  f.reply(ack());
  await opening;
  assert.equal(link.core.state, 'connected');
  assert.equal(link.policy(), 'direct');
  assert.equal(link.snapshot().pathInUse, 'direct');
});

test('initiator: no ack within timeout → legacy, pathInUse legacy-proxy', async () => {
  const f = fakeCh();
  const link = new PeerLink('gw4-peer', { openChannel: async () => f.ch, selfNode: 'gw4-self', now: () => 1, helloTimeoutMs: 10 });
  await link.open();
  assert.equal(link.core.state, 'legacy');
  assert.equal(link.snapshot().pathInUse, 'legacy-proxy');
});

test('relay-only channel: connected reports degraded + relay policy', async () => {
  const f = fakeCh({ mode: 'relay', via: null });
  const link = new PeerLink('gw4-peer', { openChannel: async () => f.ch, selfNode: 'gw4-self', now: () => 1, helloTimeoutMs: 1000 });
  const opening = link.open();
  await new Promise((r) => setImmediate(r));
  f.reply(ack());
  await opening;
  assert.equal(link.policy(), 'relay');
  assert.equal(link.snapshot().state, 'degraded');
  assert.equal(link.snapshot().pathInUse, 'relay-floor');
});

test('answerer: adopt replies hello-ack and connects', async () => {
  const f = fakeCh();
  const link = new PeerLink('gw4-peer', { openChannel: async () => { throw new Error('unused'); }, selfNode: 'gw4-self', now: () => 1 });
  link.adopt(f.ch);
  f.reply(encodeFabricControl({ type: FABRIC_TAG, kind: 'hello', version: FABRIC_VERSION, features: [], node: 'gw4-peer' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(link.core.state, 'connected');
  assert.equal(f.sent.length, 1); // the hello-ack
  assert.equal(link.snapshot().counters.inboundAdopted, 1);
});

test('open failure → failed with attempts', async () => {
  const link = new PeerLink('gw4-peer', { openChannel: async () => { throw new Error('hub not connected'); }, selfNode: 'gw4-self', now: () => 1 });
  await link.open();
  assert.equal(link.core.state, 'failed');
  assert.equal(link.core.attempts, 1);
  assert.match(link.core.lastError ?? '', /hub not connected/);
});

test('sync-firing close does not stomp the legacy state', async () => {
  // Build a fake channel whose close() synchronously invokes onClose callback
  let closeCallback: ((reason?: string) => void) | null = null;
  const syncCloseCh = {
    mode: 'bidi' as const, via: 'host' as const, rtt: 3,
    sendControl: () => {},
    onData: () => {},
    onClose: (cb: (r?: string) => void) => { closeCallback = cb; },
    close: () => { if (closeCallback) closeCallback('sync'); }, // Sync fire
  };
  const link = new PeerLink('gw4-peer', { openChannel: async () => syncCloseCh as LinkChannel, selfNode: 'gw4-self', now: () => 1, helloTimeoutMs: 10 });
  await link.open();
  // Channel closed synchronously during hello-timeout, but state should stay 'legacy' not 'failed'
  assert.equal(link.core.state, 'legacy');
  assert.equal(link.core.attempts, 0);
  assert.equal(link.snapshot().counters.helloTimeouts, 1);
});

test('markPeerOffline with sync-firing close does not pollute attempts', async () => {
  // Same sync-close fake as above, but this one reaches 'connected' first (hello-ack replied),
  // then markPeerOffline() closes it — the close() call fires onClose synchronously, and the
  // pre-fix ordering let that reduce a 'channel-closed' (bumping attempts) before 'peer-offline'
  // landed. attach()'s `this.ch === ch` guard (ch nulled BEFORE close()) must prevent that.
  let closeCallback: ((reason?: string) => void) | null = null;
  let dataCb: ((d: Buffer) => void) | null = null;
  const syncCloseCh = {
    mode: 'bidi' as const, via: 'host' as const, rtt: 3,
    sendControl: () => {},
    onData: (cb: (d: Buffer) => void) => { dataCb = cb; },
    onClose: (cb: (r?: string) => void) => { closeCallback = cb; },
    close: () => { if (closeCallback) closeCallback('sync'); }, // Sync fire
  };
  const reply = (b: Buffer) => dataCb && dataCb(b);
  const link = new PeerLink('gw4-peer', { openChannel: async () => syncCloseCh as LinkChannel, selfNode: 'gw4-self', now: () => 1, helloTimeoutMs: 1000 });
  const opening = link.open();
  await new Promise((r) => setImmediate(r));
  reply(ack());
  await opening;
  assert.equal(link.core.state, 'connected');

  link.markPeerOffline();
  assert.equal(link.core.state, 'idle');
  assert.equal(link.core.attempts, 0);
});

test('resetRetry clears attempts/since only when failed; connected link is untouched', async () => {
  const failedLink = new PeerLink('gw4-peer', { openChannel: async () => { throw new Error('down'); }, selfNode: 'gw4-self', now: () => 500 });
  await failedLink.open();
  assert.equal(failedLink.core.state, 'failed');
  assert.equal(failedLink.core.attempts, 1);

  failedLink.resetRetry();
  assert.equal(failedLink.core.state, 'failed'); // resetRetry does not change state, only attempts/since
  assert.equal(failedLink.core.attempts, 0);
  assert.equal(failedLink.core.since, 0);

  const f = fakeCh();
  const connectedLink = new PeerLink('gw4-peer', { openChannel: async () => f.ch, selfNode: 'gw4-self', now: () => 1, helloTimeoutMs: 1000 });
  const opening = connectedLink.open();
  await new Promise((r) => setImmediate(r));
  f.reply(ack());
  await opening;
  assert.equal(connectedLink.core.state, 'connected');
  const before = { ...connectedLink.core };

  connectedLink.resetRetry(); // no-op: link is not 'failed'
  assert.deepEqual(connectedLink.core, before);
});
