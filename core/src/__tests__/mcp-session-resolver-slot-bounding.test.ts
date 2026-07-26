/** A single-flight slot must never be pinned by a promise it does not BOUND.
 *
 *  The user-visible symptom was an agent in a live voice call saying it was still loading
 *  tools: `bootstrap` and `session_status` had stopped returning at all (90s+, never), and
 *  only a Core RESTART cleared it (90s+ -> 458ms, with the handlers themselves serving
 *  bootstrap in 5ms). That is what made it look intermittent, and why it kept coming back:
 *  restarting MASKED it, nothing fixed it.
 *
 *  Structure of the defect (fixable without knowing which call hangs): refresh() assigned
 *  `run` to the single-flight slot, and the ONLY release was `run`'s own `.finally`. That
 *  release is correct in isolation — it clears the slot on both settle paths — but `.finally`
 *  can only fire if `run` SETTLES. Any never-settling call inside it pinned `inFlight`
 *  permanently, and every later caller was handed that same dead promise. One hung call
 *  became a permanent process-wide outage of exactly the two identity tools.
 *
 *  The ~60s of grace before anyone noticed is stale-while-revalidate: inside MAX_STALE the
 *  refresh is fired as `void refresh(deps)`, so the FIRST hang is silent while callers are
 *  still served fast from cache. Only past 60s does every caller fall through to
 *  `return refresh(deps)` and hang forever.
 *
 *  These tests pin the slot DELIBERATELY (a promise that never settles) — a green probe on a
 *  freshly-restarted Core proves nothing here, because the failure needs the slot pinned
 *  first. Each is mutation-verified: with the bound removed, it fails (and `withinMs` is why
 *  it FAILS rather than hanging the suite).
 *
 *  Note the contract: a timeout returns a DEGRADED answer, it does not throw. Every caller
 *  (mission-actor, backlog actorFor, rename_conversation) already handles "no candidates" by
 *  falling back to a coarse actor — so degrading keeps bootstrap WORKING, whereas throwing
 *  would trade a hang for a hard failure. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRecencyCandidates, __resetRecencyCacheForTest, __setSlotDeadlineForTest,
  __ageCacheForTest, resolverSlotState, type RecencyDeps,
} from '../mcp-server/mcp-session-resolver';

/** Fail (don't hang) if `p` never settles — otherwise a regression here would wedge the whole
 *  test process instead of reporting, which is the very failure mode under test. */
async function withinMs<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${what} did not return within ${ms}ms — it HUNG (the slot is unbounded again)`)), ms);
  });
  try { return await Promise.race([p, guard]); } finally { clearTimeout(t); }
}

/** The exact shape that wedged prod: a resolution that never settles. */
function pinnedDeps(counter: { n: number }): RecencyDeps {
  return {
    conversations: () => { counter.n++; return new Promise<unknown>(() => { /* never settles */ }); },
    sessions: () => [],
  };
}

function fastDeps(counter: { n: number }, id = 'conv-fresh'): RecencyDeps {
  return {
    conversations: async () => { counter.n++; return [{ uuid: id, name: 'fresh', updated_at: '2026-07-26T00:00:00Z' }]; },
    sessions: () => [],
  };
}

test('a never-settling resolution returns a degraded answer instead of hanging forever', async () => {
  __resetRecencyCacheForTest();
  __setSlotDeadlineForTest(150);
  const c = { n: 0 };
  const started = Date.now();
  const r = await withinMs(resolveRecencyCandidates(pinnedDeps(c)), 3000, 'the first caller');
  assert.ok(r, 'a bounded slot still answers');
  assert.equal(r.degraded, true, 'and marks the answer degraded rather than pretending it resolved');
  assert.ok(Date.now() - started < 2000, 'the caller returns on the deadline, not on the upstream');
});

test('a poisoned slot is evicted, so the NEXT caller resolves for real — recovery WITHOUT a restart', async () => {
  __resetRecencyCacheForTest();
  __setSlotDeadlineForTest(150);
  const pin = { n: 0 };
  const ok = { n: 0 };
  await withinMs(resolveRecencyCandidates(pinnedDeps(pin)), 3000, 'the wedged caller');
  assert.equal(pin.n, 1, 'the hung resolution did start');

  const r = await withinMs(resolveRecencyCandidates(fastDeps(ok)), 3000, 'the caller after the wedge');
  assert.equal(ok.n, 1, 'the slot was released, so a NEW resolution actually ran (this is the no-restart recovery)');
  assert.equal(r.claudeAi?.id, 'conv-fresh', 'and the fresh answer replaced the poisoned one');
  assert.notEqual(r.degraded, true, 'a healthy resolution is not marked degraded');
});

test('joiners inherit the slot deadline instead of waiting unbounded behind it', async () => {
  __resetRecencyCacheForTest();
  __setSlotDeadlineForTest(200);
  const c = { n: 0 };
  const deps = pinnedDeps(c);
  const all = await withinMs(
    Promise.all(Array.from({ length: 6 }, () => resolveRecencyCandidates(deps))),
    3000, 'six concurrent joiners',
  );
  assert.equal(c.n, 1, 'still SINGLE-FLIGHT — bounding the slot must not bring back the thundering herd');
  for (const r of all) assert.equal(r.degraded, true, 'every joiner returned, none waited on the dead promise');
  assert.equal(resolverSlotState().timeouts, 1,
    'ONE poisoned slot counts as ONE timeout, not one per waiter — else the metric reports the crowd, not the fault');
});

test('the poisoned slot is evicted by WALL CLOCK — a starved timer cannot keep it pinned', async () => {
  // mission_035c72e3 fixed an event-loop block that stopped timers firing at all; a deadline
  // that depends on a timer being punctual would be exactly the regression it warns about.
  // So the eviction is checked on the CALLER's turn against Date.now(), and this test proves
  // it by blocking the loop straight through the deadline (no timer callback can run during a
  // synchronous spin) and then calling in that SAME tick, before any timer gets a turn.
  __resetRecencyCacheForTest();
  __setSlotDeadlineForTest(100);
  const pin = { n: 0 };
  const ok = { n: 0 };
  const wedged = resolveRecencyCandidates(pinnedDeps(pin));
  await new Promise((r) => setImmediate(r));
  assert.equal(pin.n, 1, 'the slot is pinned by a promise that will never settle');

  const until = Date.now() + 250;
  while (Date.now() < until) { /* spin: the loop is blocked, so NO timer fires */ }

  const recovered = resolveRecencyCandidates(fastDeps(ok));
  assert.equal(ok.n, 1, 'eviction must not need a timer: the wall clock at entry evicted the dead slot');

  assert.equal((await withinMs(recovered, 3000, 'the recovering caller')).claudeAi?.id, 'conv-fresh');
  await withinMs(wedged, 3000, 'the wedged caller');
});

test('a stale cached identity is preferred over nothing when the slot times out', async () => {
  __resetRecencyCacheForTest();
  __setSlotDeadlineForTest(150);
  const ok = { n: 0 };
  await withinMs(resolveRecencyCandidates(fastDeps(ok, 'conv-cached')), 3000, 'the priming caller');
  __ageCacheForTest(120_000);                       // past MAX_STALE: callers now BLOCK on refresh
  const pin = { n: 0 };
  const r = await withinMs(resolveRecencyCandidates(pinnedDeps(pin)), 3000, 'the caller past MAX_STALE');
  assert.equal(pin.n, 1, 'it did try to refresh');
  assert.equal(r.claudeAi?.id, 'conv-cached', 'identity is best-effort: a stale answer beats no answer');
});

test('slot age and timeout count are observable, so a wedge is diagnosable without a restart', async () => {
  __resetRecencyCacheForTest();
  __setSlotDeadlineForTest(150);
  const before = resolverSlotState();
  assert.equal(before.inFlight, false, 'a reset resolver reports no slot');

  const c = { n: 0 };
  const wedged = resolveRecencyCandidates(pinnedDeps(c));
  await new Promise((r) => setImmediate(r));
  const during = resolverSlotState();
  assert.equal(during.inFlight, true, 'the in-flight slot is visible');
  assert.ok(during.ageMs !== null && during.ageMs >= 0, 'with its age, so a pinned slot can be SEEN rather than inferred from a restart');
  assert.equal(during.deadlineMs, 150);

  await withinMs(wedged, 3000, 'the wedged caller');
  const after = resolverSlotState();
  assert.ok(after.timeouts >= 1, 'and a timed-out slot is counted');
  assert.ok(after.lastTimeoutAt !== null, 'with when it last happened');
});
