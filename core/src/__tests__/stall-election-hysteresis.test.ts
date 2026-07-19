import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { amIMonitor, electMonitor, _resetElectionCache } from '../monitor/stall-election';

beforeEach(() => _resetElectionCache());

// getHubConfig().gatewayId is this host's real id in tests — capture it so the
// assertions are host-independent.
async function selfIdOf(): Promise<string | null> {
  const v = await amIMonitor(async () => [], () => 1000);
  return v.selfId;
}

test('electMonitor stays a pure lowest-id convention', () => {
  assert.equal(electMonitor(['b', 'a'], 'a'), true);
  assert.equal(electMonitor(['b', 'a'], 'b'), false);
  assert.equal(electMonitor([], null), false);
});

test('fresh election success is cached; a later input failure serves it STALE within the window', async () => {
  const self = await selfIdOf();
  if (!self) return; // host has no hub identity — hysteresis is untestable here
  _resetElectionCache();
  let t = 1000;
  const good = await amIMonitor(async () => [self], () => t);
  assert.equal(good.isMonitor, true);
  assert.equal(good.stale, undefined);
  t = 1000 + 5 * 60_000; // 5 min later, inside the 10-min window
  const blip = await amIMonitor(async () => { throw new Error('hub not authed'); }, () => t);
  assert.equal(blip.isMonitor, true, 'a blip must serve the last confident answer, not flip to false');
  assert.equal(blip.stale, true);
});

test('input failure with NO recent answer → indeterminate, never a confident false', async () => {
  const v = await amIMonitor(async () => { throw new Error('cluster map cold'); }, () => 1000);
  assert.equal(v.isMonitor, false);
  assert.equal(v.indeterminate, true);
});

test('the hysteresis window expires — old answers are not served forever', async () => {
  const self = await selfIdOf();
  if (!self) return;
  _resetElectionCache();
  let t = 1000;
  await amIMonitor(async () => [self], () => t);
  t = 1000 + 11 * 60_000; // beyond the 10-min window
  const v = await amIMonitor(async () => { throw new Error('down'); }, () => t);
  assert.equal(v.indeterminate, true);
  assert.equal(v.stale, undefined);
});
