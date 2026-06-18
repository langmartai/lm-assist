import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertScopesCoverTools, TOOL_SCOPES, LM_ASSIST_TOOL_NAMES } from '../../mcp-server/configure';

// Regression guard for the HTTP /mcp build path. A tool advertised in
// LM_ASSIST_TOOL_DEFS without a TOOL_SCOPES entry makes assertScopesCoverTools()
// throw — which runs inside configureMcpServer() -> buildServer() the first time
// Core handles a (hub-relayed) /mcp request, crashing the Core process. This was
// NOT caught by stdio/REST tests because only the StreamableHTTP /mcp path builds
// the server. data_search/data_admin (M2) and the 6 management tools (M6a) shipped
// without scopes and crashed hub-connected prod nodes on the first /mcp request.
test('every advertised MCP tool has a TOOL_SCOPES entry (so /mcp buildServer cannot crash Core)', () => {
  const missing = LM_ASSIST_TOOL_NAMES.filter((n) => !(n in TOOL_SCOPES));
  assert.deepEqual(missing, [], `tools missing TOOL_SCOPES (would crash /mcp): ${missing.join(', ')}`);
  assert.doesNotThrow(() => assertScopesCoverTools());
});

test('all data-service tools are scope-covered', () => {
  const dataTools = [
    'data_catalog', 'data_request_access', 'data_get', 'data_query', 'data_search',
    'data_put', 'data_delete', 'data_admin',
    'data_create_dataset', 'data_drop_dataset', 'data_keys', 'data_revoke_key',
    'data_sync', 'data_sync_status',
  ];
  for (const t of dataTools) {
    assert.ok(t in TOOL_SCOPES, `${t} must have a TOOL_SCOPES entry`);
  }
});
