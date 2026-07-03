// core/src/__tests__/bus/status-provider.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerCoreStatusProviders, getStatusSnapshot } from '../../status/status-registry';
import { Bus, __setBusForTest } from '../../bus';
import { BusStore } from '../../bus/bus-store';

test('the bus status provider reports topics + backlog', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-st-'));
  const bus = new Bus({ store: new BusStore(dir), selfNode: 'gw-self' });
  bus.publish('mission:1', 'x', { a: 1 });
  __setBusForTest(bus);
  registerCoreStatusProviders();
  const snap = await getStatusSnapshot('bus');
  assert.ok(snap.bus);
  assert.match(snap.bus.summary, /topics/);
  assert.equal(snap.bus.verdict, 'ok');
});
