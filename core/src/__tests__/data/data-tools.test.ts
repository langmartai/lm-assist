import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-datatools-'));
import { DATA_HANDLERS, DATA_TOOL_DEFS } from '../../mcp-server/tools/data-tools';
import { runWithMcpContext } from '../../mcp-server/principal-context';
import { getDataService } from '../../data/data-service';
import { getDatasetRegistry } from '../../data/dataset-registry';

function enable() { (getDataService() as any).enabledOverride = true; }
function textOf(r: any): string { return r.content.map((c: any) => c.text).join('\n'); }

test('data tools: the 7 expected tools are defined and mapped', () => {
  const names = DATA_TOOL_DEFS.map((d) => d.name).sort();
  assert.deepEqual(names, ['data_catalog', 'data_delete', 'data_get', 'data_put', 'data_query', 'data_request_access', 'data_search']);
  for (const n of names) assert.equal(typeof DATA_HANDLERS[n], 'function');
});

test('data tools: local principal can put + get (redacted), cloud without key denied', async () => {
  enable();
  const id = `dt_${Date.now()}`;
  getDatasetRegistry().create({ id, backend: 'cache', visibility: 'cross-node-readable',
    config: { kind: 'cache' }, acl: [{ principal: 'cloud', actions: ['read'] }] });

  // local put
  const put = await runWithMcpContext({ principal: { type: 'local' } }, () =>
    DATA_HANDLERS.data_put({ dataset: id, record: { id: 'a', fields: { title: 't', apiKey: 'sk-x' } } }));
  assert.equal(put.isError ?? false, false);

  // local get -> redacted
  const got = await runWithMcpContext({ principal: { type: 'local' } }, () =>
    DATA_HANDLERS.data_get({ dataset: id, id: 'a' }));
  assert.match(textOf(got), /"title": "t"/);
  assert.match(textOf(got), /«redacted»/);

  // cloud without key -> denied
  const denied = await runWithMcpContext({ principal: { type: 'cloud', userId: 'u' } }, () =>
    DATA_HANDLERS.data_get({ dataset: id, id: 'a' }));
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /KEY_REQUIRED/);
});

test('data tools: cloud request_access then get with key', async () => {
  enable();
  const id = `dt2_${Date.now()}`;
  getDatasetRegistry().create({ id, backend: 'cache', visibility: 'cross-node-readable',
    config: { kind: 'cache' }, acl: [{ principal: 'cloud', actions: ['read'] }] });
  await runWithMcpContext({ principal: { type: 'local' } }, () =>
    DATA_HANDLERS.data_put({ dataset: id, record: { id: 'a', fields: { n: 1 } } }));

  const cloud = { type: 'cloud' as const, userId: 'u1' };
  const acc = await runWithMcpContext({ principal: cloud }, () =>
    DATA_HANDLERS.data_request_access({ intent: 'read', grants: [{ dataset: id, actions: ['read'] }] }));
  const key = JSON.parse(textOf(acc)).key as string;
  assert.equal(typeof key, 'string');

  const got = await runWithMcpContext({ principal: cloud }, () =>
    DATA_HANDLERS.data_get({ dataset: id, id: 'a', key }));
  assert.equal(got.isError ?? false, false);
  assert.match(textOf(got), /"n": 1/);
});

test('data tools: data_search on a non-search (cache) dataset returns NOT_SUPPORTED', async () => {
  enable();
  const id = `ds_search_${Date.now()}`;
  getDatasetRegistry().create({ id, backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [] });
  const r = await runWithMcpContext({ principal: { type: 'local' } }, () =>
    DATA_HANDLERS.data_search({ dataset: id, query: 'anything' }));
  assert.equal(r.isError, true);
  assert.match(textOf(r), /NOT_SUPPORTED/);
});

test('data tools: data_search requires dataset and query', async () => {
  enable();
  const missing = await runWithMcpContext({ principal: { type: 'local' } }, () =>
    DATA_HANDLERS.data_search({ dataset: 'x' }));
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /query is required/);
});
