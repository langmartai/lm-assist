import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-mcpwire-'));
import { createMcpApiRoutes } from '../../routes/core/mcp-api.routes';
import { getDataService } from '../../data/data-service';
import { getDatasetRegistry } from '../../data/dataset-registry';
import type { ParsedRequest } from '../../routes/index';

function enable() { (getDataService() as any).enabledOverride = true; }
function mcpCallRoute() {
  const routes = createMcpApiRoutes({} as any);
  const r = routes.find((x) => x.method === 'POST' && '/mcp-call'.match(x.pattern));
  if (!r) throw new Error('no /mcp-call route');
  return r.handler;
}
function call(tool: string, args: any, headers: Record<string, string>, clientIp = '127.0.0.1') {
  const req: ParsedRequest = { method: 'POST', path: '/mcp-call', params: {}, query: {}, body: { tool, args }, headers, clientIp };
  return mcpCallRoute()(req, {} as any);
}
function textOf(env: any): string {
  const r = env.data; return r.content.map((c: any) => c.text).join('\n');
}

test('mcp-call: local (loopback, no relay header) -> data_put succeeds', async () => {
  enable();
  const id = `wire_${Date.now()}`;
  getDatasetRegistry().create({ id, backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [] });
  const env = await call('data_put', { dataset: id, record: { id: 'a', fields: { n: 1 } } }, {});
  assert.equal(env.success, true);
  assert.equal(env.data.isError ?? false, false);
});

test('mcp-call: cloud (x-relay-source:hub) without key -> denied', async () => {
  enable();
  const id = `wire2_${Date.now()}`;
  getDatasetRegistry().create({ id, backend: 'cache', visibility: 'cross-node-readable',
    config: { kind: 'cache' }, acl: [{ principal: 'cloud', actions: ['read'] }] });
  const env = await call('data_get', { dataset: id, id: 'a' }, { 'x-relay-source': 'hub' });
  assert.equal(env.success, true);          // the route call itself succeeds
  assert.equal(env.data.isError, true);     // but the tool result is an error (denied)
  assert.match(textOf(env), /KEY_REQUIRED/);
});
