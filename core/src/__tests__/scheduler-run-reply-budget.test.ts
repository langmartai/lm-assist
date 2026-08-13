// POST /scheduler/jobs/:id/run must answer before the proxies in front of it give up.
//
// Measured 2026-08-13 (117): the Scheduler pane's "Test run" button returned HTTP 502 for
// `stall-monitor` every single time. Nothing was denied and nothing was broken downstream — the
// handler simply awaited the whole job, and that job takes 68–90 s (its own runLog:
// 74530 / 69671 / 69358 / 68282 / 90205 / 77142 ms) while the pane data plane destroys an
// upstream at 30 s. The run always SUCCEEDED; its result appeared in the log seconds after the
// pane had already shown a 502. A retry looked fine only because the second click landed while
// the first run still held the singleflight slot and returned immediately.
//
// So the bug is a reply that cannot arrive in time, and the fix is a bounded reply — not a
// bigger timeout somewhere, which would only move the same cliff.
import { test } from 'node:test';
import assert from 'node:assert';
import { runReplyWithinBudget, RUN_REPLY_BUDGET_MS } from '../routes/core/scheduler.routes';

test('a fast job still answers with its own result — the common case is untouched', async () => {
  const out = await runReplyWithinBudget('quick', Promise.resolve({ id: 'quick', lastRun: { status: 'ok' } }), 1000);
  assert.deepEqual(out, { id: 'quick', lastRun: { status: 'ok' } });
});

test('a job slower than the budget replies runPending instead of hanging past a proxy', async () => {
  let finished = false;
  const slow = new Promise((r) => setTimeout(() => { finished = true; r({ id: 'slow', lastRun: { status: 'ok' } }); }, 300));
  const out = await runReplyWithinBudget('slow', slow, 30);
  assert.equal(out?.runPending, true, 'caller is told the run started');
  assert.equal(out?.id, 'slow');
  assert.match(String(out?.detail), /logs/, 'and where to collect the result');
  assert.equal(finished, false, 'the reply did not wait for the run');
  await slow;
  assert.equal(finished, true, 'and the run was NOT cancelled — it keeps going');
});

test('a missing job still resolves null so the 404 branch survives', async () => {
  assert.equal(await runReplyWithinBudget('nope', Promise.resolve(null), 1000), null);
});

test('the budget sits under the tightest proxy in front of the route', () => {
  // ui-pages/local-tier/server.ts destroys a node upstream at 30_000 ms. A reply that arrives
  // after that is a 502 however correct it is, so this must stay strictly below it.
  assert.ok(RUN_REPLY_BUDGET_MS < 30_000, `budget ${RUN_REPLY_BUDGET_MS} must be under the 30s data-plane cap`);
});
