import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BusStore } from '../../bus/bus-store';
import type { BusEvent, BusCursor } from '../../bus/types';

function tmpStore(): { store: BusStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-store-'));
  return { store: new BusStore(dir), dir };
}
const ev = (o: Partial<BusEvent> & { topic: string; origin: string; seq: number }): BusEvent =>
  ({ type: 't', at: Date.now(), payload: { n: o.seq }, ...o });

// Whitebox access to the pending-write overlay + the underlying LMDB `flushed` promise, for
// tests that need to prove non-blocking behavior or deterministically wait for a durable commit
// without a sleep. Mirrors the existing `as unknown as {...}` cast convention already used in
// bus.test.ts to reach a private field (see its override of Bus's private `catchupCall`).
function pendingOf(store: BusStore): Map<string, BusEvent> {
  return (store as unknown as { pendingEvents: Map<string, BusEvent> }).pendingEvents;
}
function flushedOf(store: BusStore): Promise<unknown> {
  return (store as unknown as { events: { flushed: Promise<unknown> } }).events.flushed;
}
// Same whitebox pattern for the cursor overlay (perf(bus): move cursor writes to the overlay too).
function pendingCursorsOf(store: BusStore): Map<string, BusCursor> {
  return (store as unknown as { pendingCursors: Map<string, BusCursor> }).pendingCursors;
}
function cursorsFlushedOf(store: BusStore): Promise<unknown> {
  return (store as unknown as { cursors: { flushed: Promise<unknown> } }).cursors.flushed;
}

test('append assigns monotonic per-origin seq and reads back', async () => {
  const { store } = tmpStore();
  const s1 = store.nextSeq('mission:1', 'gw-a');
  const s2 = store.nextSeq('mission:1', 'gw-a');
  assert.equal(s1, 1);
  assert.equal(s2, 2);
  store.append(ev({ topic: 'mission:1', origin: 'gw-a', seq: s1 }));
  store.append(ev({ topic: 'mission:1', origin: 'gw-a', seq: s2 }));
  assert.equal(store.get('mission:1', 'gw-a', 1)?.seq, 1);
  assert.deepEqual(store.maxCursor('mission:1'), { 'gw-a': 2 });
  await store.close();
});

test('ingest is idempotent — a re-delivered event is a no-op', async () => {
  const { store } = tmpStore();
  const e = ev({ topic: 'data:missions', origin: 'gw-b', seq: 5 });
  assert.equal(store.ingest(e), true);
  assert.equal(store.ingest(e), false);          // exact replay → no-op
  assert.equal(store.ingest({ ...e, payload: { tampered: true } }), false); // same (origin,seq) → still no-op, no LWW
  assert.equal(store.get('data:missions', 'gw-b', 5)?.payload && (store.get('data:missions', 'gw-b', 5)!.payload as { n: number }).n, 5);
  await store.close();
});

test('readSince returns only events after the per-origin cursor, ordered', async () => {
  const { store } = tmpStore();
  for (const o of ['gw-a', 'gw-b']) for (let s = 1; s <= 3; s++) store.ingest(ev({ topic: 'app:x', origin: o, seq: s }));
  const got = store.readSince('app:x', { 'gw-a': 1 });        // gw-a>1 → 2,3 ; gw-b>0 → 1,2,3
  assert.deepEqual(got.map((e) => `${e.origin}:${e.seq}`), ['gw-a:2', 'gw-a:3', 'gw-b:1', 'gw-b:2', 'gw-b:3']);
  assert.deepEqual(store.readSince('app:x', store.maxCursor('app:x')), []); // caught up → nothing
  await store.close();
});

test('durable cursors survive a store reopen (consumer restart → resume)', async () => {
  const { store, dir } = tmpStore();
  store.setCursor('sub-1', 'mission:9', { 'gw-a': 4 });
  await store.close();
  const reopened = new BusStore(dir);
  assert.deepEqual(reopened.getCursor('sub-1', 'mission:9'), { 'gw-a': 4 });
  assert.deepEqual(reopened.getCursor('sub-1', 'never'), {});
  await reopened.close();
});

test('nextSeq resumes from the persisted head after reopen (no seq reuse)', async () => {
  const { store, dir } = tmpStore();
  store.append(ev({ topic: 't', origin: 'self', seq: store.nextSeq('t', 'self') })); // seq 1
  await store.close();
  const reopened = new BusStore(dir);
  assert.equal(reopened.nextSeq('t', 'self'), 2); // seeded from heads, not restarting at 1
  await reopened.close();
});

test('listTopics reports counts + head', async () => {
  const { store } = tmpStore();
  store.ingest(ev({ topic: 'a', origin: 'gw-a', seq: 1 }));
  store.ingest(ev({ topic: 'a', origin: 'gw-b', seq: 1 }));
  const t = store.listTopics().find((x) => x.topic === 'a')!;
  assert.equal(t.events, 2);
  assert.equal(t.origins, 2);
  await store.close();
});

// ── perf(bus): non-blocking append via in-memory write-through overlay ──────────────────────
//
// putSync-per-event synchronously fsyncs and blocks the Node event loop (measured: bus publish
// capped at ~70-86 ops/s, and 24 concurrent publishers stalled the whole Core API — /health p50
// 234ms / max 1829ms). append()/ingest()/bumpHead() now commit via async put(), returning before
// the write is durable. The tests below prove that change never broke read-your-writes, never
// introduced a seq collision, still commits durably on a clean close(), stays idempotent across
// the pending/committed boundary, and is genuinely non-blocking.

test('read-your-writes: get/readSince/nextSeq/maxCursor all reflect an append in the SAME tick (no await)', () => {
  const { store } = tmpStore();
  const seq = store.nextSeq('rw:topic', 'gw-a');
  store.append(ev({ topic: 'rw:topic', origin: 'gw-a', seq }));
  // Everything below runs synchronously, immediately after append() returns — no await anywhere
  // above this point, so the async LMDB commit cannot possibly have landed yet. If read-your-
  // writes broke, at least one of these would come back empty/stale.
  assert.equal(store.get('rw:topic', 'gw-a', seq)?.seq, seq);
  assert.deepEqual(store.readSince('rw:topic', {}).map((e) => e.seq), [seq]);
  assert.deepEqual(store.maxCursor('rw:topic'), { 'gw-a': seq });
  // nextSeq() itself mutates the in-memory head (it's a reservation, not a peek) — check it LAST
  // so it doesn't invalidate the maxCursor assertion above.
  assert.equal(store.nextSeq('rw:topic', 'gw-a'), seq + 1);
});

test('readSince/listTopics/maxCursor correctly merge a committed origin with a still-pending origin', async () => {
  const { store } = tmpStore();
  for (let s = 1; s <= 3; s++) store.ingest(ev({ topic: 'merge:topic', origin: 'gw-a', seq: s }));
  await flushedOf(store); // gw-a:1..3 are now durably committed
  const s = store.nextSeq('merge:topic', 'gw-z');
  store.append(ev({ topic: 'merge:topic', origin: 'gw-z', seq: s })); // gw-z:1 stays pending — no await after this
  assert.deepEqual(
    store.readSince('merge:topic', {}).map((e) => `${e.origin}:${e.seq}`),
    ['gw-a:1', 'gw-a:2', 'gw-a:3', 'gw-z:1'],
  );
  assert.deepEqual(store.maxCursor('merge:topic'), { 'gw-a': 3, 'gw-z': 1 });
  const t = store.listTopics().find((x) => x.topic === 'merge:topic')!;
  assert.equal(t.events, 4);
  assert.equal(t.origins, 2);
  await store.close();
});

test('no seq collision: repeated synchronous nextSeq+append cycles for the same (topic,origin) strictly increase', async () => {
  const { store } = tmpStore();
  const seqs: number[] = [];
  for (let i = 0; i < 200; i++) {
    // No await between reservation and append — exactly how Bus.publish() calls these back-to-back.
    const s = store.nextSeq('collide:topic', 'gw-a');
    store.append(ev({ topic: 'collide:topic', origin: 'gw-a', seq: s }));
    seqs.push(s);
  }
  assert.deepEqual(seqs, Array.from({ length: 200 }, (_, i) => i + 1)); // strictly increasing, no dupes
  assert.equal(store.get('collide:topic', 'gw-a', 200)?.seq, 200);
  await store.close();
});

test('idempotent ingest holds whether the duplicate arrives while pending (overlay) or after commit (durable)', async () => {
  const { store } = tmpStore();
  const e = ev({ topic: 'idem:topic', origin: 'gw-b', seq: 1 });
  assert.equal(store.ingest(e), true);
  assert.equal(store.ingest(e), false); // duplicate while still pending, same tick — not yet committed
  assert.equal(store.ingest({ ...e, payload: { tampered: true } }), false); // no LWW while pending
  await flushedOf(store); // now durably committed
  assert.equal(store.ingest(e), false); // duplicate after commit
  assert.equal(store.ingest({ ...e, payload: { tampered: true } }), false); // no LWW after commit either
  assert.equal((store.get('idem:topic', 'gw-b', 1)!.payload as { n: number }).n, 1); // original content, never overwritten
  await store.close();
});

test('durability: N appended events all survive close()+reopen (async commits are awaited before the env closes)', async () => {
  const { store, dir } = tmpStore();
  const N = 50;
  for (let s = 1; s <= N; s++) store.append(ev({ topic: 'durable:topic', origin: 'gw-a', seq: s }));
  await store.close(); // must not return before every pending commit is durably flushed
  const reopened = new BusStore(dir);
  for (let s = 1; s <= N; s++) assert.equal(reopened.get('durable:topic', 'gw-a', s)?.seq, s);
  assert.deepEqual(reopened.maxCursor('durable:topic'), { 'gw-a': N });
  await reopened.close();
});

test('non-blocking evidence: append() returns synchronously and the overlay holds every entry before any commit resolves', async () => {
  const { store, dir } = tmpStore();
  const N = 500;
  for (let s = 1; s <= N; s++) store.append(ev({ topic: 'nb:topic', origin: 'gw-a', seq: s }));
  // Still the SAME synchronous tick as the N appends above: no putSync-style fsync ran per event,
  // and none of the async put().then() overlay-cleanup callbacks have had a chance to run yet
  // (they're microtasks queued behind this still-executing synchronous block) — so the overlay
  // must still hold all N entries. This is the direct evidence that append() no longer performs
  // a blocking synchronous disk flush per call.
  assert.equal(pendingOf(store).size, N);
  await store.close(); // now wait for the real commits + drain of the overlay
  assert.equal(pendingOf(store).size, 0);
  const reopened = new BusStore(dir);
  assert.equal(reopened.get('nb:topic', 'gw-a', N)?.seq, N);
  await reopened.close();
});

// ── perf(bus): move cursor writes to the overlay too (fully non-blocking bus store) ─────────
//
// setCursor was the last putSync on the hot-ish delivery path (one write per delivered batch
// per subscriber — see Bus.dispatchTo). Under heavy subscriber fan-out this still causes a
// per-write fsync that can briefly block the event loop (the residual max-181ms tail measured
// after the event/head overlay fix). setCursor/getCursor now mirror the exact same in-memory
// write-through overlay pattern as events/heads: a pendingCursors Map read-through on getCursor,
// an async cursors.put() tracked in the shared pendingCommits set, and close() awaiting
// cursors.flushed too.

test('cursor read-your-writes: setCursor then immediate getCursor (same tick, no await) sees the new value', () => {
  const { store } = tmpStore();
  store.setCursor('s', 't', { o: 5 });
  assert.deepEqual(store.getCursor('s', 't'), { o: 5 }); // same tick — async commit cannot have landed yet
  store.setCursor('s', 't', { o: 8 });
  assert.deepEqual(store.getCursor('s', 't'), { o: 8 }); // second overlapping write composes correctly too
});

test('cursor merge semantics preserved: setCursor composes via mergeCursor (per-origin max), across overlay and committed', async () => {
  const { store } = tmpStore();
  store.setCursor('s', 't', { a: 3 });
  store.setCursor('s', 't', { b: 2 });
  assert.deepEqual(store.getCursor('s', 't'), { a: 3, b: 2 }); // union while still pending
  store.setCursor('s', 't', { a: 1 }); // lower value for an already-seen origin
  assert.deepEqual(store.getCursor('s', 't'), { a: 3, b: 2 }); // max wins — no regression
  await cursorsFlushedOf(store);
  assert.deepEqual(store.getCursor('s', 't'), { a: 3, b: 2 }); // still correct once durably committed
  await store.close();
});

test('cursor durability: N cursors survive close()+reopen', async () => {
  const { store, dir } = tmpStore();
  const N = 20;
  for (let i = 0; i < N; i++) store.setCursor(`sub-${i}`, 'topic', { gw: i });
  await store.close(); // must not return before every pending cursor commit is durably flushed
  const reopened = new BusStore(dir);
  for (let i = 0; i < N; i++) assert.deepEqual(reopened.getCursor(`sub-${i}`, 'topic'), { gw: i });
  await reopened.close();
});

test('cursor non-blocking evidence: setCursor() returns synchronously and the overlay holds the entry before the commit resolves', async () => {
  const { store, dir } = tmpStore();
  store.setCursor('sub-x', 'topic', { gw: 42 });
  // Still the same synchronous tick: the async cursors.put().then() eviction callback is a
  // microtask queued behind this still-executing block, so the overlay must still hold the entry.
  assert.equal(pendingCursorsOf(store).size, 1);
  assert.deepEqual(store.getCursor('sub-x', 'topic'), { gw: 42 });
  await store.close(); // now wait for the real commit + drain of the overlay
  assert.equal(pendingCursorsOf(store).size, 0);
  const reopened = new BusStore(dir);
  assert.deepEqual(reopened.getCursor('sub-x', 'topic'), { gw: 42 });
  await reopened.close();
});

test('cursor eviction ref-check: an OLDER commit landing after a NEWER setCursor must not drop the newer overlay value', async () => {
  const { store } = tmpStore();
  // Force the exact out-of-order-commit scenario the ref-check exists for: fully stub
  // cursors.put() with manually-controlled promises (no real LMDB I/O at all, so resolution
  // order is 100% deterministic — awaiting the stub's own promise, not a guessed number of
  // microtask/macrotask ticks, is what makes this reliable). Issue two overlapping setCursor()
  // calls to the SAME key (older then newer — exactly how Bus.dispatchTo can call this
  // back-to-back for the same subscriber+topic), then resolve the OLDER call's put() while the
  // NEWER call's put() is still outstanding, and directly await the specific promise that
  // resolution triggers. Without the `pendingCursors.get(key) === merged` check in setCursor(),
  // the older commit's unconditional `.then(() => pendingCursors.delete(key))` would fire and
  // wipe the newer, still-pending value out of the overlay purely because it happened to land
  // first — commits do not necessarily resolve in issue order.
  const cursorsDb = (store as unknown as { cursors: { put: (k: unknown, v: unknown) => Promise<unknown> } }).cursors;
  const realPut = cursorsDb.put.bind(cursorsDb);
  const gates: Array<{ resolve: () => void; settled: Promise<void> }> = [];
  cursorsDb.put = () => {
    let resolve!: () => void;
    const settled = new Promise<void>((res) => { resolve = res; });
    gates.push({ resolve, settled });
    return settled; // setCursor's own .then(...) chain is attached directly to THIS promise
  };

  store.setCursor('sub-y', 'topic', { gw: 1 }); // older — put() held back as gates[0]
  store.setCursor('sub-y', 'topic', { gw: 2 }); // newer — put() held back as gates[1]
  assert.equal(gates.length, 2);
  assert.deepEqual(store.getCursor('sub-y', 'topic'), { gw: 2 }); // overlay already reflects the newer merge

  gates[0].resolve(); // resolve the OLDER commit first — its callback must NOT evict the newer value
  await gates[0].settled; // deterministic: waits exactly for setCursor's .then() chained onto THIS promise

  // The critical assertion: the newer value must survive the older commit's eviction callback,
  // which has now definitely run (we awaited the exact promise it's chained off of). A version
  // without the ref-check would have unconditionally deleted the overlay entry here, and
  // getCursor() would fall through to the durable store — which still has nothing written to it
  // in this fully-stubbed scenario (neither commit's real cursors.put ever ran), so the
  // regression would surface as an empty cursor `{}` instead of the correct `{ gw: 2 }`.
  assert.deepEqual(store.getCursor('sub-y', 'topic'), { gw: 2 });

  // Release the still-pending newer commit too so it doesn't dangle (real cursors.put restored
  // below never actually ran for either commit here — durability across a real commit + reopen
  // is covered separately by "cursor durability: N cursors survive close()+reopen").
  gates[1].resolve();
  await gates[1].settled;

  cursorsDb.put = realPut;
  await store.close();
});
