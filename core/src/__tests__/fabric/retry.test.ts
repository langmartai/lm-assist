// core/src/__tests__/fabric/retry.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  classify, nextBackoffMs, nextRung, fabricRequestWithRetry, fabricRequestManaged,
  type RequestOutcome, type RetryCounters,
} from '../../fabric/retry';
import type { FabricResponse } from '../../fabric';
import { stopFabric } from '../../fabric';

const ok = (): RequestOutcome => ({ kind: 'ok', res: { status: 200, data: {} } });

test('classification table', () => {
  assert.equal(classify(ok(), 1, 4), 'return-ok');
  assert.equal(classify({ kind: 'app-error', res: { status: 404 } }, 1, 4), 'return-app-error');
  assert.equal(classify({ kind: 'not-delivered', error: new Error('x') }, 1, 4), 'retry-fresh');
  assert.equal(classify({ kind: 'delivered-no-response', error: new Error('x') }, 2, 4), 'retry-same-id');
  assert.equal(classify({ kind: 'not-delivered', error: new Error('x') }, 4, 4), 'fail-budget');
});

test('backoff doubles from 0.5s, caps at 8s; rung ladder', () => {
  assert.equal(nextBackoffMs(1), 500);
  assert.equal(nextBackoffMs(2), 1000);
  assert.equal(nextBackoffMs(9), 8000);
  assert.deepEqual([nextRung('direct'), nextRung('relay'), nextRung('legacy'), nextRung('reresolve')],
    ['relay', 'legacy', 'reresolve', null]);
});

test('orchestrator retries a transient failure then succeeds, keeping reqId stable', async () => {
  const seen: string[] = [];
  const counters: RetryCounters = { retries: 0, escalations: 0, dedupHits: 0, budgetExhausted: 0 };
  let n = 0;
  const res = await fabricRequestWithRetry({
    genReqId: () => 'REQ-1',
    sleep: async () => {},
    counters,
    attempt: async (rung, reqId) => {
      seen.push(`${rung}:${reqId}`);
      n++;
      return n < 2 ? { kind: 'not-delivered', error: new Error('boom') } : { kind: 'ok', res: { status: 200, data: { n } } };
    },
  });
  assert.deepEqual(res, { status: 200, data: { n: 2 } });
  assert.deepEqual(seen, ['direct:REQ-1', 'relay:REQ-1']); // escalated rung, same reqId
  assert.equal(counters.retries, 1);
  assert.equal(counters.escalations, 1);
});

test('app-error is returned without any retry; budget exhaustion throws with a trail', async () => {
  const counters: RetryCounters = { retries: 0, escalations: 0, dedupHits: 0, budgetExhausted: 0 };
  const appRes = await fabricRequestWithRetry({ maxAttempts: 4, sleep: async () => {}, counters,
    attempt: async () => ({ kind: 'app-error', res: { status: 400, code: 'bad' } }) });
  assert.equal(appRes.code, 'bad');
  assert.equal(counters.retries, 0);
  await assert.rejects(fabricRequestWithRetry({ maxAttempts: 2, sleep: async () => {}, counters,
    attempt: async () => ({ kind: 'not-delivered', error: new Error('down') }) }), /down|budget/i);
  assert.equal(counters.budgetExhausted, 1);
});

test('fabricRequestManaged maps a missing link to not-delivered and exhausts the budget', async () => {
  stopFabric(); // no fabric links registered
  const counters: RetryCounters = { retries: 0, escalations: 0, dedupHits: 0, budgetExhausted: 0 };
  // Inject a no-op sleep: fabricRequestManaged's own default sleep uses a REAL,
  // deliberately .unref()'d setTimeout (so a stalled retry never blocks process
  // shutdown in production — see retry.ts's header). In THIS isolated single-file
  // test process there is nothing else keeping the event loop alive, so an
  // unref'd timer never gets a chance to fire before Node decides the loop is
  // idle — reproduced standalone (a bare `await new Promise(r => { const t =
  // setTimeout(r, 500); t.unref(); })` as a test body fails identically with
  // "Promise resolution is still pending but the event loop has already
  // resolved"). Not a retry.ts logic bug; injecting sleep (same seam every
  // other test in this file already uses) keeps this test deterministic and
  // sidesteps the trap entirely, per the brief's own "injected clock" testing
  // principle.
  await assert.rejects(
    fabricRequestManaged({ node: 'ghost' }, { method: 'GET', path: '/health' }, { maxAttempts: 2, counters, sleep: async () => {} }),
    /no fabric link|budget/i,
  );
  assert.equal(counters.budgetExhausted, 1);
});
