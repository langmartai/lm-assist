/** Backlog MCP tools — defs/handlers aligned, scopes covered, connector string-arg
 *  coercion. Mirrors mission-workflow-mcp.test.ts. */
import { test } from 'node:test';
import assert from 'node:assert';
import { BACKLOG_TOOL_DEFS, BACKLOG_HANDLERS, coerceTags } from '../mcp-server/tools/backlog';

const EXPECTED = [
  'backlog_create', 'backlog_discuss', 'backlog_get', 'backlog_graph', 'backlog_link',
  'backlog_list', 'backlog_remove', 'backlog_review', 'backlog_unlink', 'backlog_update',
];

test('exactly the 10 backlog tools, defs and handlers aligned', () => {
  const names = BACKLOG_TOOL_DEFS.map((d) => d.name).sort();
  assert.deepEqual(names, EXPECTED);
  assert.deepEqual(Object.keys(BACKLOG_HANDLERS).sort(), names);
  for (const d of BACKLOG_TOOL_DEFS) assert.ok(d.description.length > 20, d.name);
});

test('TOOL_SCOPES covers all 10 (reads read, writes write)', () => {
  const { TOOL_SCOPES } = require('../mcp-server/configure');
  for (const d of BACKLOG_TOOL_DEFS) assert.ok(TOOL_SCOPES[d.name], d.name);
  for (const read of ['backlog_list', 'backlog_get', 'backlog_graph']) assert.equal(TOOL_SCOPES[read], 'read', read);
  for (const write of ['backlog_create', 'backlog_update', 'backlog_link', 'backlog_unlink', 'backlog_review', 'backlog_discuss', 'backlog_remove']) {
    assert.equal(TOOL_SCOPES[write], 'write', write);
  }
});

test('registry catalog carries every backlog tool (page/module mapping)', () => {
  const { getToolCatalog } = require('../mcp-server/registry/catalog');
  const catalog = getToolCatalog();
  for (const name of EXPECTED) {
    const entry = catalog.get(name);
    assert.ok(entry, `catalog entry for ${name}`);
    assert.equal(entry.category, 'backlog', name);
  }
});

test('coerceTags: arrays pass, JSON strings parse, comma strings split, junk drops', () => {
  assert.deepEqual(coerceTags(['a', 'b']), ['a', 'b']);
  assert.deepEqual(coerceTags('["a","b"]'), ['a', 'b']);
  assert.deepEqual(coerceTags('a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(coerceTags(''), []);
  assert.equal(coerceTags(undefined), undefined);
  assert.equal(coerceTags(42), undefined);
});
