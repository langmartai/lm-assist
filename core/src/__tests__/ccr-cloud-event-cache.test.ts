import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  cloudClientEventsReadCached, appendNewerEvents, prependOlderEvents, _resetClientEventCache,
  type CachedEventLog,
} from '../terminal/ccr-cloud';
import { handleSessionRead, type SessionOpsDeps } from '../routes/core/mission.routes';

const ev = (seq: number) => ({ event_type: 'message', sequence_num: seq, payload: { seq } });
const seqs = (events: unknown[]) => (events as Array<{ sequence_num?: unknown }>).map((e) => Number(e.sequence_num));

beforeEach(() => _resetClientEventCache());

/** Fake upstream: an append-only log of `total` events, newest-first pages of `pageSize`. */
function fakeLog(total: number, pageSize = 10) {
  const calls: string[] = [];
  const fetchPage = async (cursor: string) => {
    calls.push(cursor || '<newest>');
    const start = cursor ? Number(cursor) : total; // cursor = exclusive upper seq bound
    const events = [];
    for (let s = start; s > Math.max(0, start - pageSize); s--) events.push(ev(s));
    const nextCursor = start - pageSize > 0 ? String(start - pageSize) : null;
    return { events, nextCursor };
  };
  return { calls, fetchPage, grow: (n: number) => { total += n; }, get total() { return total; } };
}

test('pure merges keep the log ascending and deduped', () => {
  const log: CachedEventLog = { events: [ev(5), ev(6)], newestSeq: 6, oldestCursor: '4', complete: false };
  assert.equal(appendNewerEvents(log, [ev(9), ev(8), ev(7), ev(6)]), 3); // 6 deduped
  assert.deepEqual(seqs(log.events), [5, 6, 7, 8, 9]);
  assert.equal(log.newestSeq, 9);
  assert.equal(prependOlderEvents(log, [ev(4), ev(3), ev(5)]), 2); // 5 already covered
  assert.deepEqual(seqs(log.events), [3, 4, 5, 6, 7, 8, 9]);
});

test('seed + backfill walks to the true beginning and reports complete', async () => {
  const up = fakeLog(35, 10);
  const r1 = await cloudClientEventsReadCached('cse_test1', 200, up.fetchPage);
  // seed page (10) + backfill pages until want or complete: 35 events total
  assert.equal(r1.events.length, 35);
  assert.equal(r1.complete, true);
  assert.deepEqual(seqs(r1.events.slice(0, 3)), [1, 2, 3]); // oldest-first
});

test('a poll only fetches the newest page once cached; new events append in order', async () => {
  const up = fakeLog(40, 10);
  await cloudClientEventsReadCached('cse_test2', 500, up.fetchPage);
  const before = up.calls.length;
  up.grow(3); // three new events arrive
  const r = await cloudClientEventsReadCached('cse_test2', 500, up.fetchPage);
  assert.equal(up.calls.length - before, 1); // ONE newest-page fetch, no re-paging
  assert.equal(r.events.length, 43);
  assert.deepEqual(seqs(r.events.slice(-3)), [41, 42, 43]);
  assert.equal(r.complete, true);
});

test('backfill is budgeted per call — repeated reads dig deeper until complete', async () => {
  const up = fakeLog(500, 10); // 50 pages; one call = seed + 10 backfill pages max
  const r1 = await cloudClientEventsReadCached('cse_test3', 100_000, up.fetchPage);
  assert.ok(r1.events.length < 500 && r1.events.length >= 100);
  assert.equal(r1.complete, false);
  let r = r1;
  for (let i = 0; i < 6 && !r.complete; i++) r = await cloudClientEventsReadCached('cse_test3', 100_000, up.fetchPage);
  assert.equal(r.events.length, 500);
  assert.equal(r.complete, true);
});

// ── handleSessionRead depth semantics via DI ──
function deps(over: Partial<SessionOpsDeps>): SessionOpsDeps {
  return {
    resolve: (sid: string) => ({ sid, transport: 'native', missionId: null, role: 'worker' as const }),
    cloudRead: async (o) => ({ sid: o.sid, messages: [], pendingQuestion: null }),
    cloudDrive: async () => ({}) as never,
    cloudStop: async () => ({}) as never,
    nativeRead: async () => ({ messages: [] }),
    nativeRawMessages: async () => [],
    nativeDrive: async () => ({}) as never,
    ...over,
  } as SessionOpsDeps;
}

test('native read asks N+1 and reports historyComplete=false when older history exists', async () => {
  const all = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const d = deps({ nativeRead: async (_sid, lastN) => ({ messages: lastN ? all.slice(-lastN) : all }) });
  const r: any = await handleSessionRead('00000000-0000-0000-0000-000000000001', 10, d, undefined, { proxyPost: async () => ({}) } as never);
  assert.equal(r.success, true);
  assert.equal(r.data.messages.length, 10); // trimmed back to N
  assert.equal(r.data.historyComplete, false);
  const r2: any = await handleSessionRead('00000000-0000-0000-0000-000000000001', 100, d, undefined, { proxyPost: async () => ({}) } as never);
  assert.equal(r2.data.messages.length, 50);
  assert.equal(r2.data.historyComplete, true);
});

test('cloud read passes historyComplete through', async () => {
  const d = deps({
    resolve: (sid: string) => ({ sid, transport: 'cloud', missionId: null, role: 'worker' as const }),
    cloudRead: async (o) => ({ sid: o.sid, messages: [{ role: 'assistant', text: 'x' }], pendingQuestion: null, historyComplete: true } as never),
  });
  const r: any = await handleSessionRead('cse_x', 30, d, undefined, { proxyPost: async () => ({}) } as never);
  assert.equal(r.data.historyComplete, true);
});
