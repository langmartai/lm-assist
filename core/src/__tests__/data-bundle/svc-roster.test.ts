// core/src/__tests__/data-bundle/svc-roster.test.ts
// The ownership guards' roster: a roster that cannot be read is UNAVAILABLE — never an empty
// "nobody is online" list, which would let a takeover or an import mint a second owner.
import './svc-harness';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoster, isOnline } from '../../data/bundle/roster';

test('roster: a listed peer is online, an unlisted one is offline', async () => {
  const s = await createRoster({ listPeers: async () => [{ node: 'gw-a', hostname: 'a', platform: 'linux' }] }).snapshot();
  assert.equal(s.available, true);
  assert.equal(isOnline(s, 'gw-a'), true);
  assert.equal(isOnline(s, 'gw-b'), false);
  assert.equal(isOnline(s, null), false);
});

test('roster: a throwing hub, a hub that is not configured, or a non-list answer is UNAVAILABLE', async () => {
  let called = 0;
  const down = await createRoster({ listPeers: async () => { called++; throw new Error('Hub returned 502'); } }).snapshot();
  assert.equal(down.available, false);
  assert.match((down as { reason: string }).reason, /502/);
  assert.equal(isOnline(down, 'gw-a'), null, 'unknown, not offline');

  const unconfigured = await createRoster({ listPeers: async () => { called++; return []; }, configured: () => false }).snapshot();
  assert.equal(unconfigured.available, false);
  assert.match((unconfigured as { reason: string }).reason, /not configured/);

  const garbage = await createRoster({ listPeers: async () => ({ machines: [] }) as never }).snapshot();
  assert.equal(garbage.available, false);
  assert.equal(called, 1, 'an unconfigured hub is not even dialled');
});
