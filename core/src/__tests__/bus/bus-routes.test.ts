import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createBusRoutes } from '../../routes/core/bus.routes';
import { Bus, __setBusForTest } from '../../bus';
import { BusStore } from '../../bus/bus-store';
import type { RouteHandler } from '../../routes/index';

function routes(): { handlers: RouteHandler[]; bus: Bus } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-rt-'));
  const bus = new Bus({ store: new BusStore(dir), selfNode: 'gw-self' });
  __setBusForTest(bus);
  return { handlers: createBusRoutes({} as never), bus };
}
const find = (hs: RouteHandler[], method: string, p: string) => hs.find((h) => h.method === method && h.pattern.test(p))!;

test('POST /bus/publish appends and returns the event id', async () => {
  const { handlers } = routes();
  const h = find(handlers, 'POST', '/bus/publish');
  const res = await h.handler({ method: 'POST', path: '/bus/publish', query: {}, body: { topic: 'm', type: 'x', payload: { a: 1 } } } as never, {} as never);
  assert.equal(res.success, true);
  assert.equal((res.data as { seq: number }).seq, 1);
});

test('GET /bus/read returns events + nextCursor; POST /bus/:topic/since catches up', async () => {
  const { handlers, bus } = routes();
  bus.publish('m', 'x', { a: 1 });
  const read = find(handlers, 'GET', '/bus/read');
  const r = await read.handler({ method: 'GET', path: '/bus/read', query: { topic: 'm' } } as never, {} as never);
  assert.equal((r.data as { events: unknown[] }).events.length, 1);
  const since = find(handlers, 'POST', '/bus/m/since');
  const s = await since.handler({ method: 'POST', path: '/bus/m/since', query: {}, body: { cursors: {} } } as never, {} as never);
  assert.equal((s.data as { events: unknown[] }).events.length, 1);
});

test('GET /bus/read requires topic', async () => {
  const { handlers } = routes();
  const read = find(handlers, 'GET', '/bus/read');
  const r = await read.handler({ method: 'GET', path: '/bus/read', query: {} } as never, {} as never);
  assert.equal(r.success, false);
});
