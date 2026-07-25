/** The MCP caller-identity path must not cost a multiple of the plain write path.
 *
 *  Follow-up to 5434a11 (single-flight). Single-flight fixed the AMPLIFICATION but not the
 *  LATENCY. Measured on prod 117 (2026-07-26), backlog_create direct to :3100, 4 concurrent:
 *
 *    no `_actor` hint (no identity resolution):        server p50 = 7ms
 *    `_actor` WITHOUT a tool-call id, warm:            server p50 = 9ms      <- cache worked
 *    `_actor` WITH a tool-call id, cold:               server p50 = 12948ms
 *    `_actor` WITH a tool-call id, WARM:               server p50 = 9359ms   <- cache irrelevant
 *
 *  The warm-with-tool-call-id row is the tell: the recency cache was working perfectly and
 *  the path was still ~1000x the plain one, because the "cheap (in-memory)" precise match
 *  ran a SYNCHRONOUS lmdb sweep of all 13,607 cached sessions on every single call. Its
 *  file-tail component measures 6-8ms, so the sweep is essentially all of it.
 *
 *  Three defects, one per test below:
 *    1. the precise match swept the session store per call and was never cached;
 *    2. the 2.5s bound could not fire, because that sweep blocks the loop (measured: a
 *       2500ms timer did not fire AT ALL during a 6s synchronous block);
 *    3. the cache was stamped with the resolution's START time, so a resolution slower than
 *       the TTL wrote an already-expired entry and the next caller re-resolved from cold. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCallerCandidates, resolveRecencyCandidates, __resetRecencyCacheForTest, __ageCacheForTest,
  __cacheAgeForTest, type RecencyDeps,
} from '../mcp-server/mcp-session-resolver';
import { runWithMcpContext } from '../mcp-server/principal-context';

const SESSIONS = [
  { sessionId: 'sess-old', filePath: '/nope/sess-old.jsonl', cacheData: { fileMtime: 100, toolUses: [{ id: 'toolu_A' }] } },
  { sessionId: 'sess-new', filePath: '/nope/sess-new.jsonl', cacheData: { fileMtime: 900, toolUses: [{ id: 'toolu_B' }] } },
];

/** Mirrors the real shape: `sessions()` is the expensive synchronous store sweep,
 *  `conversations()` is the bounded network call. Both are counted. */
function countingDeps(counts: { sweeps: number; net: number }, netDelayMs = 0): RecencyDeps {
  return {
    conversations: async () => { counts.net++; if (netDelayMs) await new Promise((r) => setTimeout(r, netDelayMs)); return []; },
    sessions: () => { counts.sweeps++; return SESSIONS; },
  };
}

const withToolUse = <T>(id: string, fn: () => Promise<T>) =>
  runWithMcpContext({ principal: { type: 'local' } as any, toolUseId: id }, fn);

// ── 1. the sweep must not run per call ─────────────────────────────────────

test('the precise match does not sweep the session store on every call', async () => {
  __resetRecencyCacheForTest();
  const counts = { sweeps: 0, net: 0 };
  const deps = countingDeps(counts);
  // A tool-call id that matches NOTHING — the claude.ai-web caller shape, and the worst
  // case: both the in-memory scan and the file-tail fallback run to completion and fail.
  await withToolUse('toolu_MATCHES_NOTHING', async () => {
    for (let i = 0; i < 6; i++) await resolveCallerCandidates(deps);
  });
  assert.equal(counts.sweeps, 1, `the store was swept ${counts.sweeps}x for 6 calls — the per-call sweep is back`);
});

test('concurrent callers WITH a tool-call id share one sweep and one network call', async () => {
  __resetRecencyCacheForTest();
  const counts = { sweeps: 0, net: 0 };
  const deps = countingDeps(counts, 30);
  await withToolUse('toolu_MATCHES_NOTHING', async () => {
    await Promise.all(Array.from({ length: 8 }, () => resolveCallerCandidates(deps)));
  });
  assert.equal(counts.net, 1, `8 concurrent callers made ${counts.net} network calls — single-flight regressed`);
  assert.equal(counts.sweeps, 1, `8 concurrent callers made ${counts.sweeps} store sweeps`);
});

test('a matching tool-call id still pins the exact session (the sweep memo must not break correctness)', async () => {
  __resetRecencyCacheForTest();
  const deps = countingDeps({ sweeps: 0, net: 0 });
  const r = await withToolUse('toolu_A', () => resolveCallerCandidates(deps));
  assert.equal(r.precise, true, 'a known tool-call id must still resolve precisely');
  assert.equal(r.claudeCode?.id, 'sess-old');
});

// ── 2. the bound must hold without depending on a timer firing ─────────────

test('a resolution slower than the bound is abandoned, not awaited to completion', async () => {
  __resetRecencyCacheForTest();
  let aborted = false;
  const deps: RecencyDeps = {
    // Never settles on its own — it can ONLY end via the abort signal. If the bound were
    // still `Promise.race` + setTimeout, the underlying call would leak and keep running.
    conversations: (signal) => new Promise((_res, rej) => {
      signal?.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }, { once: true });
    }),
    sessions: () => SESSIONS,
  };
  // The bound's own timer is deliberately unref'd (the resolver must never hold the process
  // open). In prod the server keeps the loop alive; here the test has to.
  const keepAlive = setInterval(() => {}, 50);
  const t0 = Date.now();
  const r = await resolveRecencyCandidates(deps);
  const ms = Date.now() - t0;
  clearInterval(keepAlive);
  assert.ok(aborted, 'the bound must ABORT the underlying request, not just stop waiting for it');
  assert.ok(ms < 6000, `resolution took ${ms}ms — the 2.5s bound did not hold`);
  assert.equal(r.claudeCode?.id, 'sess-new', 'a bounded-out claude.ai call still yields the session candidate');
});

// ── 3. the cache must not be born expired ──────────────────────────────────

test('the cache is stamped at COMPLETION, so a slow resolution does not write an expired entry', async () => {
  __resetRecencyCacheForTest();
  const counts = { sweeps: 0, net: 0 };
  const SLOW = 300;
  const deps = countingDeps(counts, SLOW);
  await resolveRecencyCandidates(deps);
  // The invariant, stated directly rather than inferred from a hit/miss: a just-written
  // entry is ~0ms old no matter how long the resolution took. Stamped at START it would
  // already be SLOW ms old — and at the real prod figure (an 8229ms resolution against an
  // 8000ms TTL) that is born expired, which is why an 8.2s call landed right after a warm
  // round. Asserting a cache HIT here would not catch it: with any delay short enough to
  // keep the test fast, a start-stamped entry is still comfortably inside the TTL.
  const age = __cacheAgeForTest();
  assert.notEqual(age, null, 'a completed resolution must leave a cache entry');
  assert.ok(age! < SLOW / 2, `the entry was born ${age}ms old after a ${SLOW}ms resolution — it is stamped at START, not completion`);
});

test('past the TTL a caller is served STALE immediately while the refresh runs behind it', async () => {
  __resetRecencyCacheForTest();
  const counts = { sweeps: 0, net: 0 };
  const slow = 400;
  const deps: RecencyDeps = {
    conversations: async () => {
      counts.net++;
      await new Promise((r) => setTimeout(r, slow));
      return [{ uuid: `conv-${counts.net}`, name: 'c', updated_at: '2026-07-26T00:00:00Z' }];
    },
    sessions: () => { counts.sweeps++; return SESSIONS; },
  };
  await resolveRecencyCandidates(deps);              // prime (pays the slow call once)
  assert.equal(counts.net, 1);
  // Age the entry past the TTL without waiting 8s in the test.
  __ageCacheForTest(9000);
  const t0 = Date.now();
  const r = await resolveRecencyCandidates(deps);
  const ms = Date.now() - t0;
  assert.ok(ms < slow / 2, `a stale-but-usable identity took ${ms}ms — resolution is still on the hot path`);
  assert.equal(r.claudeAi?.id, 'conv-1', 'the stale value is served while the refresh runs');
  assert.equal(counts.net, 2, 'a background refresh was started');
});

// ── the acceptance criterion, stated as a ratio ────────────────────────────

test('LATENCY REGRESSION: the MCP identity path stays within a small multiple of the plain path under concurrency', async () => {
  const CONC = 8;
  // The plain path does no identity resolution at all — this is the control.
  const plain = async () => { /* the write itself; no resolver involvement */ };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONC }, plain));
  const plainMs = Math.max(1, Date.now() - t0);

  __resetRecencyCacheForTest();
  const counts = { sweeps: 0, net: 0 };
  // Model the real per-unit costs: the store sweep genuinely blocks (busy-wait, as lmdb's
  // synchronous getRange does), and the network call is bounded.
  const deps: RecencyDeps = {
    conversations: async () => { counts.net++; await new Promise((r) => setTimeout(r, 40)); return []; },
    sessions: () => { counts.sweeps++; const end = Date.now() + 25; while (Date.now() < end) { /* blocking sweep */ } return SESSIONS; },
  };
  await withToolUse('toolu_MATCHES_NOTHING', () => resolveCallerCandidates(deps)); // first call pays
  const t1 = Date.now();
  await withToolUse('toolu_MATCHES_NOTHING', async () => {
    await Promise.all(Array.from({ length: CONC }, () => resolveCallerCandidates(deps)));
  });
  const mcpMs = Date.now() - t1;

  // Pre-fix this was CONC sweeps (8 x 25ms blocking) on top of everything else; the point
  // is that a warm MCP path is now dominated by the write, not by identity resolution.
  assert.equal(counts.sweeps, 1, `${counts.sweeps} sweeps for ${CONC} warm concurrent calls`);
  assert.ok(mcpMs <= plainMs + 30, `warm MCP path ${mcpMs}ms vs plain ${plainMs}ms — identity resolution is back on the hot path`);
});
