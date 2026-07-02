// core/src/__tests__/fabric/fabric-routes.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createFabricRoutes } from '../../routes/core/fabric.routes';

test('routes expose /fabric/status and /status/full and return wrapped payloads', async () => {
  const routes = createFabricRoutes({} as never);
  const byPattern = (p: string) => routes.find((r) => r.pattern.test(p));
  assert.ok(byPattern('/fabric/status'));
  assert.ok(byPattern('/status/full'));

  const res = await byPattern('/fabric/status')!.handler({ params: {}, query: {} } as never, {} as never);
  assert.equal(res.success, true);
  assert.ok('enabled' in (res.data as Record<string, unknown>));
  assert.ok('resolution' in (res.data as Record<string, unknown>));

  const full = await byPattern('/status/full')!.handler({ params: {}, query: {} } as never, {} as never);
  assert.equal(full.success, true);
  assert.ok('sections' in (full.data as Record<string, unknown>));
});
