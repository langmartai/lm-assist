import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PendingCalls } from '../../fabric/pending-calls';
import type { Envelope } from '../../fabric/envelope';

const res = (id: string): Envelope => ({ kind: 'res', id, headers: { status: 200 }, payload: new Uint8Array() });

test('resolve delivers the response to the registered caller', async () => {
  const pc = new PendingCalls();
  const p = pc.register('c1', 1000);
  assert.equal(pc.size(), 1);
  assert.equal(pc.resolve('c1', res('c1')), true);
  const got = await p;
  assert.equal(got.headers.status, 200);
  assert.equal(pc.size(), 0);
});

test('timeout rejects and drops the entry', async () => {
  const pc = new PendingCalls();
  const keepAlive = setInterval(() => {}, 100);
  try {
    const p = pc.register('c2', 10);
    await assert.rejects(p, /timeout/);
    assert.equal(pc.size(), 0);
    assert.equal(pc.resolve('c2', res('c2')), false); // already gone
  } finally {
    clearInterval(keepAlive);
  }
});

test('rejectAll fails every in-flight call (link close)', async () => {
  const pc = new PendingCalls();
  const keepAlive = setInterval(() => {}, 100);
  try {
    const a = pc.register('a', 5000);
    const b = pc.register('b', 5000);
    pc.rejectAll(new Error('link closed'));
    await assert.rejects(a, /link closed/);
    await assert.rejects(b, /link closed/);
    assert.equal(pc.size(), 0);
  } finally {
    clearInterval(keepAlive);
  }
});
