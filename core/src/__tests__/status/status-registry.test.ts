// core/src/__tests__/status/status-registry.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { registerStatusProvider, getStatusSnapshot } from '../../status/status-registry';

test('snapshot aggregates providers; section filters; failures become error reports', async () => {
  registerStatusProvider('alpha', () => ({ verdict: 'ok', summary: 'fine' }));
  registerStatusProvider('beta', async () => ({ verdict: 'warn', summary: 'meh', detail: { n: 2 } }));
  registerStatusProvider('broken', () => { throw new Error('kaput'); });

  const all = await getStatusSnapshot();
  assert.equal(all.alpha.verdict, 'ok');
  assert.equal(all.beta.verdict, 'warn');
  assert.equal(all.broken.verdict, 'error');
  assert.match(all.broken.summary, /kaput/);

  const one = await getStatusSnapshot('beta');
  assert.deepEqual(Object.keys(one), ['beta']);
});

test('slow provider times out into an error report', async () => {
  registerStatusProvider('slow', () => new Promise((r) => setTimeout(() => r({ verdict: 'ok', summary: 'late' }), 5000)));
  const snap = await getStatusSnapshot('slow');
  assert.equal(snap.slow.verdict, 'error');
  assert.match(snap.slow.summary, /timeout/i);
});
