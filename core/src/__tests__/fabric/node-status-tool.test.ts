import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { NODE_STATUS_TOOL_DEFS, formatStatusSections } from '../../mcp-server/tools/node-status';
import { TOOL_SCOPES } from '../../mcp-server/configure';

test('def is registered read-only and scoped (TOOL_SCOPES or /mcp crashes)', () => {
  assert.equal(NODE_STATUS_TOOL_DEFS.length, 1);
  assert.equal(NODE_STATUS_TOOL_DEFS[0].name, 'node_status');
  assert.equal(NODE_STATUS_TOOL_DEFS[0].annotations.readOnlyHint, true);
  assert.equal(TOOL_SCOPES['node_status'], 'read');
});

test('formatter renders one line per subsystem; section view appends detail', () => {
  const sections = {
    fabric: { verdict: 'ok', summary: '2 peers — 2 direct · 0 relay · 0 legacy · 0 failed', detail: { peers: [] } },
    hub: { verdict: 'warn', summary: 'hub not connected/authenticated' },
  };
  const all = formatStatusSections(sections);
  assert.match(all, /\[ok\] fabric — 2 peers/);
  assert.match(all, /\[warn\] hub — hub not connected/);
  const one = formatStatusSections({ fabric: sections.fabric }, 'fabric');
  assert.match(one, /"peers": \[\]/);
});
