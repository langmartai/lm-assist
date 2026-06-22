import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPANDED_TOOL_DEFS, EXPANDED_HANDLERS } from '../mcp-server/tools/expanded';
import { assertScopesCoverTools, TOOL_SCOPES } from '../mcp-server/configure';

test('memory_sync_status is advertised, dispatchable, and scoped', () => {
  assert.ok(EXPANDED_TOOL_DEFS.some((d: any) => d.name === 'memory_sync_status'), 'in EXPANDED_TOOL_DEFS');
  assert.equal(typeof EXPANDED_HANDLERS['memory_sync_status'], 'function', 'in EXPANDED_HANDLERS');
  assert.equal((TOOL_SCOPES as Record<string, string>)['memory_sync_status'], 'read', 'scoped read');
});

test('assertScopesCoverTools does not throw (every advertised tool has a scope)', () => {
  assert.doesNotThrow(() => assertScopesCoverTools());
});
