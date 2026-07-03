import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BusStore } from '../../bus/bus-store';
import type { BusEvent } from '../../bus/types';

function tmpStore(): { store: BusStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-store-'));
  return { store: new BusStore(dir), dir };
}
const ev = (o: Partial<BusEvent> & { topic: string; origin: string; seq: number }): BusEvent =>
  ({ type: 't', at: Date.now(), payload: { n: o.seq }, ...o });

test('append assigns monotonic per-origin seq and reads back', () => {
  const { store } = tmpStore();
  const s1 = store.nextSeq('mission:1', 'gw-a');
  const s2 = store.nextSeq('mission:1', 'gw-a');
  assert.equal(s1, 1);
  assert.equal(s2, 2);
  store.append(ev({ topic: 'mission:1', origin: 'gw-a', seq: s1 }));
  store.append(ev({ topic: 'mission:1', origin: 'gw-a', seq: s2 }));
  assert.equal(store.get('mission:1', 'gw-a', 1)?.seq, 1);
  assert.deepEqual(store.maxCursor('mission:1'), { 'gw-a': 2 });
  store.close();
});

test('ingest is idempotent — a re-delivered event is a no-op', () => {
  const { store } = tmpStore();
  const e = ev({ topic: 'data:missions', origin: 'gw-b', seq: 5 });
  assert.equal(store.ingest(e), true);
  assert.equal(store.ingest(e), false);          // exact replay → no-op
  assert.equal(store.ingest({ ...e, payload: { tampered: true } }), false); // same (origin,seq) → still no-op, no LWW
  assert.equal(store.get('data:missions', 'gw-b', 5)?.payload && (store.get('data:missions', 'gw-b', 5)!.payload as { n: number }).n, 5);
  store.close();
});

test('readSince returns only events after the per-origin cursor, ordered', () => {
  const { store } = tmpStore();
  for (const o of ['gw-a', 'gw-b']) for (let s = 1; s <= 3; s++) store.ingest(ev({ topic: 'app:x', origin: o, seq: s }));
  const got = store.readSince('app:x', { 'gw-a': 1 });        // gw-a>1 → 2,3 ; gw-b>0 → 1,2,3
  assert.deepEqual(got.map((e) => `${e.origin}:${e.seq}`), ['gw-a:2', 'gw-a:3', 'gw-b:1', 'gw-b:2', 'gw-b:3']);
  assert.deepEqual(store.readSince('app:x', store.maxCursor('app:x')), []); // caught up → nothing
  store.close();
});

test('durable cursors survive a store reopen (consumer restart → resume)', () => {
  const { store, dir } = tmpStore();
  store.setCursor('sub-1', 'mission:9', { 'gw-a': 4 });
  store.close();
  const reopened = new BusStore(dir);
  assert.deepEqual(reopened.getCursor('sub-1', 'mission:9'), { 'gw-a': 4 });
  assert.deepEqual(reopened.getCursor('sub-1', 'never'), {});
  reopened.close();
});

test('nextSeq resumes from the persisted head after reopen (no seq reuse)', () => {
  const { store, dir } = tmpStore();
  store.append(ev({ topic: 't', origin: 'self', seq: store.nextSeq('t', 'self') })); // seq 1
  store.close();
  const reopened = new BusStore(dir);
  assert.equal(reopened.nextSeq('t', 'self'), 2); // seeded from heads, not restarting at 1
  reopened.close();
});

test('listTopics reports counts + head', () => {
  const { store } = tmpStore();
  store.ingest(ev({ topic: 'a', origin: 'gw-a', seq: 1 }));
  store.ingest(ev({ topic: 'a', origin: 'gw-b', seq: 1 }));
  const t = store.listTopics().find((x) => x.topic === 'a')!;
  assert.equal(t.events, 2);
  assert.equal(t.origins, 2);
  store.close();
});
