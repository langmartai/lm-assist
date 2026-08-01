/**
 * Every MCP tool MUST have a TOOL_SCOPES entry.
 *
 * 🔴 MEASURED 2026-08-01: six Gmail tools shipped without scope entries. The guard
 * in configure.ts already existed and did its job — but it only fires when an MCP
 * request arrives, and it throws during server construction, so the symptom was
 * Core CRASHING on every `tools/list`. Downstream that reads as
 * "Worker disconnected" / "no connected lm-assist node for this user" at the hub,
 * and a bare 502 at the connector — three hops away from the actual cause, and
 * indistinguishable from a platform outage. It cost an hour of hub debugging.
 *
 * The reason it escaped every other check: the tools were exercised through their
 * REST routes, which never build the MCP server. Only an MCP request does.
 *
 * This test runs the same assertion at `npm test`, where the failure names the
 * missing tools instead of taking down a node.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import { assertScopesCoverTools } from '../mcp-server/configure';

test('every registered MCP tool has a TOOL_SCOPES entry', () => {
  assert.doesNotThrow(() => assertScopesCoverTools());
});
