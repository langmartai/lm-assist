// core/src/__tests__/resolution/resolution.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ResolutionService } from '../../resolution/resolution-service';
import { buildSessionResolver, buildRoleResolver } from '../../resolution/resolvers';

test('session resolver: cloud pattern → cloud; local → self; else first probing peer', async () => {
  const r = buildSessionResolver({
    isLocal: async (id) => id === 'local-uuid',
    selfNode: () => 'gw4-self',
    peerNodes: async () => ['gw4-b', 'gw4-c'],
    probe: async (node, id) => node === 'gw4-c' && id === 'remote-uuid',
  });
  assert.deepEqual(await r.resolve('session_abc123'), { cloud: true });
  assert.deepEqual(await r.resolve('local-uuid'), { node: 'gw4-self' });
  assert.deepEqual(await r.resolve('remote-uuid'), { node: 'gw4-c' });
  assert.equal(await r.resolve('nowhere-uuid'), null);
});

test('service caches positives, caches negatives briefly, invalidates', async () => {
  let calls = 0;
  const svc = new ResolutionService({ ttlMs: 60_000, negTtlMs: 10_000, cap: 10 });
  svc.register({ kind: 'thing', resolve: async (id) => { calls++; return id === 'x' ? { node: 'gw4-b' } : null; } });

  assert.deepEqual(await svc.resolve('thing', 'x'), { node: 'gw4-b' });
  assert.deepEqual(await svc.resolve('thing', 'x'), { node: 'gw4-b' });
  assert.equal(calls, 1);                          // second was a cache hit
  assert.equal(await svc.resolve('thing', 'nope'), null);
  assert.equal(await svc.resolve('thing', 'nope'), null);
  assert.equal(calls, 2);                          // negative cached too
  svc.invalidate('thing', 'x');
  await svc.resolve('thing', 'x');
  assert.equal(calls, 3);                          // invalidation forced re-resolve
  const c = svc.counters();
  assert.equal(c.hits, 2);
  assert.equal(c.invalidations, 1);
});

test('role resolver answers only "leader"', async () => {
  const r = buildRoleResolver({ leader: async () => 'gw4-b' });
  assert.deepEqual(await r.resolve('leader'), { node: 'gw4-b' });
  assert.equal(await r.resolve('controller'), null);
});
