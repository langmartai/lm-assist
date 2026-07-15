/**
 * Code-derived tool catalog (spec §4.3): every advertised MCP tool resolves to a
 * category + defining module + scope + advertised def, and the implementation
 * view can produce the registered handler's source. The completeness test
 * mirrors assertScopesCoverTools(): a new tool without a catalog entry fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getToolCatalog, handlerSourceFor, CATEGORY_ORDER } from '../mcp-server/registry/catalog';
import { LM_ASSIST_TOOL_NAMES } from '../mcp-server/configure';
import { PROTECTED_TOOLS } from '../mcp-server/registry/model';

test('every advertised tool has a catalog entry with category, module, scope, def', () => {
  const cat = getToolCatalog();
  const missing = LM_ASSIST_TOOL_NAMES.filter((n) => !cat.has(n));
  assert.deepEqual(missing, [], `catalog missing entries for: ${missing.join(', ')}`);
  for (const name of LM_ASSIST_TOOL_NAMES) {
    const e = cat.get(name)!;
    assert.ok(e.category, `${name} category`);
    assert.ok(e.module.startsWith('core/src/mcp-server/'), `${name} module pointer (${e.module})`);
    assert.ok(['read', 'write', 'admin'].includes(e.scope), `${name} scope`);
    assert.equal(e.def.name, name);
  }
});

test('catalog has no orphan entries for tools that are not advertised', () => {
  const advertised = new Set(LM_ASSIST_TOOL_NAMES);
  for (const name of getToolCatalog().keys()) {
    assert.ok(advertised.has(name), `catalog entry "${name}" is not an advertised tool`);
  }
});

test('spot-check category + module derivation', () => {
  const cat = getToolCatalog();
  assert.equal(cat.get('mission_create')?.category, 'mission');
  assert.equal(cat.get('mission_create')?.module, 'core/src/mcp-server/tools/mission.ts');
  assert.equal(cat.get('mission_view_set')?.module, 'core/src/mcp-server/tools/mission-query.ts');
  assert.equal(cat.get('github_query')?.category, 'github');
  assert.equal(cat.get('search')?.category, 'core');
  assert.equal(cat.get('search')?.module, 'core/src/mcp-server/tools/search.ts');
  assert.equal(cat.get('machine_access')?.category, 'machine-access');
  assert.equal(cat.get('transfer_send_file')?.category, 'transfer');
  assert.equal(cat.get('open_port_forward')?.category, 'transfer');
  assert.equal(cat.get('windows_terminal_list')?.category, 'terminal');
  assert.equal(cat.get('bootstrap')?.category, 'core');
  assert.equal(cat.get('session_status')?.module, 'core/src/mcp-server/mcp-session-resolver.ts');
  assert.equal(cat.get('cluster_assign')?.category, 'cluster');
});

test('scopes come from TOOL_SCOPES (spot checks)', () => {
  const cat = getToolCatalog();
  assert.equal(cat.get('detail')?.scope, 'read');
  assert.equal(cat.get('feedback')?.scope, 'write');
  assert.equal(cat.get('agent_execute')?.scope, 'admin');
});

test('protected names are marked and present', () => {
  const cat = getToolCatalog();
  for (const name of PROTECTED_TOOLS) {
    assert.equal(cat.get(name)?.protected, true, name);
  }
  assert.equal(cat.get('detail')?.protected, false);
});

test('advertised defs carry the node param (post-withNodeParam)', () => {
  const def = getToolCatalog().get('detail')!.def as { inputSchema: { properties: Record<string, unknown> } };
  assert.ok(def.inputSchema.properties.node, 'node selector param present');
});

test('handlerSourceFor returns real source for expanded and base tools, null for unknown', () => {
  const d = handlerSourceFor('detail');
  assert.ok(d && d.source.length > 20, 'detail source non-trivial');
  assert.ok(d!.module.endsWith('detail.ts'));
  const m = handlerSourceFor('mission_create');
  assert.ok(m && m.source.length > 20);
  assert.equal(handlerSourceFor('zz-nope'), null);
});

test('CATEGORY_ORDER covers every category the catalog produces', () => {
  const cats = new Set([...getToolCatalog().values()].map((e) => e.category));
  for (const c of cats) assert.ok(CATEGORY_ORDER.includes(c), `CATEGORY_ORDER missing "${c}"`);
});
