import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { retentionFromEnv, eventsToEvict } from '../../bus/retention';
import { BusStore } from '../../bus/bus-store';
import type { BusEvent } from '../../bus/types';

test('retentionFromEnv has safe defaults and honors env', () => {
  const d = retentionFromEnv();
  assert.equal(d.maxEvents, 10000);
  assert.equal(d.maxAgeMs, 7 * 24 * 3600 * 1000);
  process.env.LM_BUS_RETENTION_EVENTS = '3';
  process.env.LM_BUS_RETENTION_DAYS = '1';
  const e = retentionFromEnv();
  assert.equal(e.maxEvents, 3);
  assert.equal(e.maxAgeMs, 24 * 3600 * 1000);
  delete process.env.LM_BUS_RETENTION_EVENTS;
  delete process.env.LM_BUS_RETENTION_DAYS;
});

test('eventsToEvict drops aged-out AND oldest surplus over the cap', () => {
  const now = 1_000_000_000_000;
  const evs = [
    { origin: 'a', seq: 1, at: now - 10_000 },
    { origin: 'a', seq: 2, at: now - 9_000 },
    { origin: 'a', seq: 3, at: now - 8_000 },
    { origin: 'a', seq: 4, at: now - 1_000 },
  ];
  const evict = eventsToEvict(evs, { maxEvents: 2, maxAgeMs: 9_500 }, now);
  // seq1 is aged out (>9.5s); then cap=2 over 4 events → drop the 2 oldest remaining (seq2, seq3)
  assert.deepEqual(evict.map((e) => e.seq).sort(), [1, 2, 3]);
});

test('sweep removes evicted events from the store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-ret-'));
  const store = new BusStore(dir);
  const now = Date.now();
  for (let s = 1; s <= 5; s++) {
    const e: BusEvent = { topic: 'app:x', origin: 'a', seq: s, type: 't', at: now - (5 - s) * 1000, payload: {} };
    store.ingest(e);
  }
  const removed = store.sweep({ maxEvents: 2, maxAgeMs: 3_500 });
  assert.ok(removed >= 3);
  assert.equal(store.get('app:x', 'a', 1), undefined); // oldest gone
  assert.ok(store.get('app:x', 'a', 5));               // newest kept
  store.close();
});
