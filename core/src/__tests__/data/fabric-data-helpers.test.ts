// core/src/__tests__/data/fabric-data-helpers.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fabric from '../../fabric';

test('fabricDataPeer is false when no fabric link exists', () => {
  assert.equal(fabric.fabricDataPeer('nobody'), false);
});

test('fabricDataRequest is exported and callable (rejects with no link)', async () => {
  assert.equal(typeof (fabric as Record<string, unknown>).fabricDataRequest, 'function');
  // fabricDataRequest wraps fabricRequestManaged (retry/escalation, maxAttempts default 4)
  // whose backoff timers are deliberately .unref()'d in production (a stalled retry must
  // never block process shutdown — see retry.ts's header). In an isolated single-file test
  // process there is nothing else keeping the event loop alive, so those unref'd timers
  // never get a chance to fire before Node decides the loop is idle and cancels the still-
  // pending promise ("Promise resolution is still pending but the event loop has already
  // resolved"). Same trap, same fix already established in this codebase — see the
  // identical `keepAlive` try/finally in pending-calls.test.ts and fabric-link.test.ts.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(() => fabric.fabricDataRequest('nobody', { method: 'GET', path: '/data/sync/manifest' }));
  } finally {
    clearInterval(keepAlive);
  }
});
