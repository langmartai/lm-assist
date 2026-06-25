import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LM_ASSIST_TOOL_NAMES, TOOL_SCOPES, assertScopesCoverTools } from '../mcp-server/configure';

// Regression guard: a tool added to LM_ASSIST_TOOL_DEFS WITHOUT a TOOL_SCOPES entry makes
// assertScopesCoverTools() throw at MCP-server build time — which crashes the Core on the first
// (hub-relayed) /mcp request. Catch it here instead of in production. (Shipped broken once:
// mission_session_answer was added to the defs but not TOOL_SCOPES → fleet outage, hotfix 0.1.91.)

test('every MCP tool has a TOOL_SCOPES entry (assertScopesCoverTools does not throw)', () => {
  const missing = LM_ASSIST_TOOL_NAMES.filter((n) => !(n in TOOL_SCOPES));
  assert.deepEqual(missing, [], `tools missing a TOOL_SCOPES entry: ${missing.join(', ')}`);
  assert.doesNotThrow(() => assertScopesCoverTools());
});

test('mission_session_answer is a write-scoped tool', () => {
  assert.equal(TOOL_SCOPES['mission_session_answer'], 'write');
});
