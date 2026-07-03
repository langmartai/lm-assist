import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Bus } from '../../bus/bus';
import { BusStore } from '../../bus/bus-store';
import type { BusEvent } from '../../bus/types';
import { initEnvelopeCodec, encodeBody } from '../../fabric/envelope';

before(async () => { await initEnvelopeCodec(); });

function mk(over: Partial<{ enabled: boolean }> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-svc-'));
  const fanned: BusEvent[] = [];
  const store = new BusStore(dir);
  // A mutable box (not a fixed closure value) so a test can flip `state.enabled`
  // at runtime and observe the bus react mid-life, not just at construction.
  const state = { enabled: over.enabled ?? true };
  const bus = new Bus({
    store, selfNode: 'gw-self',
    fanout: (e) => fanned.push(e), enabled: () => state.enabled,
  });
  return { bus, fanned, store, state };
}

test('publish appends with self origin + monotonic seq and fans out', () => {
  const { bus, fanned } = mk();
  const e1 = bus.publish('mission:1', 'created', { id: 1 });
  const e2 = bus.publish('mission:1', 'updated', { id: 1 });
  assert.equal(e1.origin, 'gw-self');
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(fanned.length, 2);
  assert.equal(fanned[1].seq, 2);
});

test('publish rejects an over-cap payload (must use a ref)', () => {
  const { bus } = mk();
  assert.throws(() => bus.publish('t', 'big', { blob: 'x'.repeat(70 * 1024) }), /64KB|cap|ref/i);
  // a ref-carrying event is fine
  const e = bus.publish('t', 'big', undefined, { ref: { kind: 'bulk', id: 'xfer-1' } });
  assert.equal(e.ref?.id, 'xfer-1');
});

test('disabled bus refuses to publish and ignores ingest', () => {
  const { bus, fanned } = mk({ enabled: false });
  assert.throws(() => bus.publish('t', 'x', {}), /disabled/i);
  assert.equal(bus.ingest({ topic: 't', origin: 'gw-x', seq: 1, type: 'x', at: Date.now() }), false);
  assert.equal(fanned.length, 0);
});

test('subscribe delivers live events and advances a durable cursor; ingest is idempotent', async () => {
  const { bus } = mk();
  const seen: string[] = [];
  bus.subscribe('sub-A', 'app:y', (e) => { seen.push(`${e.origin}:${e.seq}`); });
  assert.equal(bus.ingest({ topic: 'app:y', origin: 'gw-b', seq: 1, type: 'x', at: Date.now() }), true);
  assert.equal(bus.ingest({ topic: 'app:y', origin: 'gw-b', seq: 1, type: 'x', at: Date.now() }), false); // dup no-op
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, ['gw-b:1']); // delivered once
});

test('a new subscriber replays missed events from its durable cursor', async () => {
  const { bus } = mk();
  bus.ingest({ topic: 'm', origin: 'gw-b', seq: 1, type: 'x', at: Date.now() });
  bus.ingest({ topic: 'm', origin: 'gw-b', seq: 2, type: 'x', at: Date.now() });
  const seen: number[] = [];
  bus.subscribe('sub-Z', 'm', (e) => { seen.push(e.seq); }); // subscribes AFTER the events landed
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, [1, 2]); // replayed from cursor {} → both
});

test('read is stateless: from-cursor → events + nextCursor; long-poll wakes on a new event', async () => {
  const { bus } = mk();
  bus.ingest({ topic: 'q', origin: 'gw-b', seq: 1, type: 'x', at: Date.now() });
  const r1 = await bus.read('q');
  assert.deepEqual(r1.events.map((e) => e.seq), [1]);
  const r2 = await bus.read('q', r1.nextCursor); // caught up → empty immediately (no wait)
  assert.deepEqual(r2.events, []);
  const waiting = bus.read('q', r1.nextCursor, 1000); // long-poll
  setTimeout(() => bus.ingest({ topic: 'q', origin: 'gw-b', seq: 2, type: 'x', at: Date.now() }), 20);
  const r3 = await waiting;
  assert.deepEqual(r3.events.map((e) => e.seq), [2]);
});

// ── Review fixes: gate subscribe() on busEnabled + serialize per-subscriber delivery ──────────

test('reviewer repro: a faster-resolving later event must not advance the cursor past an earlier failed one; resubscribe redelivers it (no loss)', async () => {
  const { bus, store } = mk();
  const seen: number[] = [];
  // Controllable promise for seq 1 — held pending until the test explicitly rejects it, so we
  // can observe whether seq 2 (which "resolves fast") is dispatched before or after seq 1 settles.
  let failSeq1: () => void = () => { throw new Error('seq 1 handler was never invoked'); };
  const flaky = (e: BusEvent): void | Promise<void> => {
    seen.push(e.seq);
    if (e.seq === 1) return new Promise<void>((_resolve, reject) => { failSeq1 = () => reject(new Error('boom')); });
    return Promise.resolve(); // seq 2's handler resolves immediately
  };
  const unsub = bus.subscribe('sub-loss', 'loss-topic', flaky);
  bus.ingest({ topic: 'loss-topic', origin: 'gw-o', seq: 1, type: 'x', at: Date.now() });
  bus.ingest({ topic: 'loss-topic', origin: 'gw-o', seq: 2, type: 'x', at: Date.now() });

  await new Promise((r) => setTimeout(r, 10));
  // Per-subscriber serialization: seq 2's handler must not even be invoked until seq 1 settles.
  assert.deepEqual(seen, [1]);

  failSeq1();
  await new Promise((r) => setTimeout(r, 10));
  // seq 2 is now dispatched (at-least-once) after seq 1 settled (failed).
  assert.deepEqual(seen, [1, 2]);
  // The durable cursor must NOT have advanced: seq 2's success must not max-merge past seq 1's
  // never-successfully-delivered failure. This is the exact loss the reviewer reproduced.
  assert.deepEqual(store.getCursor('sub-loss', 'loss-topic'), {});

  unsub();
  const redelivered: number[] = [];
  bus.subscribe('sub-loss', 'loss-topic', (e) => { redelivered.push(e.seq); });
  await new Promise((r) => setTimeout(r, 10));
  // A fresh subscribe() replays from the (un-advanced) durable cursor — seq 1 is redelivered, no loss.
  assert.deepEqual(redelivered, [1, 2]);
  // This time both succeed: the fresh Sub's failedOrigins latch is clear, so the cursor advances normally.
  assert.deepEqual(store.getCursor('sub-loss', 'loss-topic'), { 'gw-o': 2 });
});

test('subscribe() while busEnabled=false: no replay, no live delivery; returned unsubscribe is callable', async () => {
  const { bus, state } = mk();
  bus.ingest({ topic: 'gated', origin: 'gw-b', seq: 1, type: 'x', at: Date.now() }); // history that would replay
  state.enabled = false;
  const seen: number[] = [];
  const unsub = bus.subscribe('sub-gate', 'gated', (e) => { seen.push(e.seq); });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, []); // no replay while disabled — subscribe() registered nothing
  assert.doesNotThrow(() => unsub()); // inert unsubscribe, safe to call
});

test('flipping busEnabled to false mid-life silences an existing subscriber; re-enabling resumes for new events', async () => {
  const { bus, state } = mk();
  const seen: number[] = [];
  bus.subscribe('sub-flip', 'flip-topic', (e) => { seen.push(e.seq); });
  bus.ingest({ topic: 'flip-topic', origin: 'gw-b', seq: 1, type: 'x', at: Date.now() });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, [1]);

  state.enabled = false;
  // ingest itself also refuses while disabled (defense in depth), so the event is never even stored.
  assert.equal(bus.ingest({ topic: 'flip-topic', origin: 'gw-b', seq: 2, type: 'x', at: Date.now() }), false);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, [1]); // unchanged — nothing delivered while disabled

  state.enabled = true;
  bus.ingest({ topic: 'flip-topic', origin: 'gw-b', seq: 2, type: 'x', at: Date.now() });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, [1, 2]); // resumes for new events after re-enable
});

test('ingestFromWire round-trip: encodeBody a valid event -> ingestFromWire -> stored + delivered to a live subscriber', async () => {
  const { bus, store } = mk();
  const seen: BusEvent[] = [];
  bus.subscribe('sub-wire', 'wire-topic', (e) => { seen.push(e); });
  const wireEvent: BusEvent = {
    topic: 'wire-topic', origin: 'gw-remote', seq: 1, type: 'wire-test', at: Date.now(), payload: { hello: 'world' },
  };
  const accepted = bus.ingestFromWire(encodeBody(wireEvent));
  assert.equal(accepted, true);
  assert.deepEqual(store.get('wire-topic', 'gw-remote', 1), wireEvent);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], wireEvent);
});
