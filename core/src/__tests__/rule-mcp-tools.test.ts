import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPANDED_TOOL_DEFS, EXPANDED_HANDLERS } from '../mcp-server/tools/expanded';
import { assertScopesCoverTools, TOOL_SCOPES } from '../mcp-server/configure';

const NEW_TOOLS = ['rule_record', 'rule_sync_status', 'rule_cross_host', 'rule_import_candidates', 'rule_projects'];

test('each new rule tool is advertised, dispatchable, and scoped read', () => {
  for (const name of NEW_TOOLS) {
    assert.ok(EXPANDED_TOOL_DEFS.some((d: any) => d.name === name), `${name} in EXPANDED_TOOL_DEFS`);
    assert.equal(typeof EXPANDED_HANDLERS[name], 'function', `${name} in EXPANDED_HANDLERS`);
    assert.equal((TOOL_SCOPES as Record<string, string>)[name], 'read', `${name} scoped read`);
  }
});

test('rule_record requires a recordId', async () => {
  const r = await EXPANDED_HANDLERS['rule_record']({});
  assert.equal(r.isError, true);
});

test('rule_cross_host requires a query', async () => {
  const r = await EXPANDED_HANDLERS['rule_cross_host']({});
  assert.equal(r.isError, true);
});

test('assertScopesCoverTools does not throw (every advertised tool has a scope)', () => {
  assert.doesNotThrow(() => assertScopesCoverTools());
});

// ── F5: description fixes ────────────────────────────────────────────────────

test('rule_cross_host description says "user + project rules" not "USER rules"', () => {
  const def = EXPANDED_TOOL_DEFS.find((d: any) => d.name === 'rule_cross_host') as any;
  assert.ok(def, 'rule_cross_host tool found');
  assert.ok(!def.description.includes('USER rules'), 'no "USER rules" in description — should say user + project');
  assert.ok(def.description.toLowerCase().includes('user + project') || def.description.toLowerCase().includes('user and project'), 'description mentions user + project scope');
});

test('rule_import_candidates description does not say "USER rules"', () => {
  const def = EXPANDED_TOOL_DEFS.find((d: any) => d.name === 'rule_import_candidates') as any;
  assert.ok(def, 'rule_import_candidates tool found');
  assert.ok(!def.description.includes('USER rules'), 'no "USER rules" in description');
});
