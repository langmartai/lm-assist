import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Bus } from '../../bus/bus';
import { BusStore } from '../../bus/bus-store';
import type { BusEvent } from '../../bus/types';

function mk(over: Partial<{ enabled: boolean }> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-svc-'));
  const fanned: BusEvent[] = [];
  const bus = new Bus({
    store: new BusStore(dir), selfNode: 'gw-self',
    fanout: (e) => fanned.push(e), enabled: () => over.enabled ?? true,
  });
  return { bus, fanned };
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
