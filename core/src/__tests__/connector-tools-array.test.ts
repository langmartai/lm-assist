import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConnectorToolsArray, pickLmAssistConnector } from '../mcp-server/connector-tools-array';

const DEFS = [
  { name: 'data_catalog', description: 'list datasets', inputSchema: { type: 'object', properties: { node: { type: 'string' } } } },
  { name: 'list_nodes', description: 'list nodes', inputSchema: { type: 'object', properties: {} } },
  { name: 'session_status', description: 'who am i' },
];
const CONN = { uuid: 'uuid-1', url: 'https://mcp.langmart.ai/mcp', name: 'lm-assist langmart', connected: true, tools: ['data_catalog', 'list_nodes', 'session_status'] };

test('buildConnectorToolsArray maps defs to the claude.ai SPA shape with the connector identity', () => {
  const out = buildConnectorToolsArray(CONN, DEFS, ['data_catalog']);
  assert.equal(out.length, 1);
  const t = out[0];
  assert.equal(t.name, 'data_catalog');
  assert.equal(t.mcp_server_uuid, 'uuid-1');
  assert.equal(t.mcp_server_url, 'https://mcp.langmart.ai/mcp');
  assert.equal(t.integration_name, 'lm-assist langmart');
  assert.deepEqual(t.input_schema, { type: 'object', properties: { node: { type: 'string' } } });
  // CRITICAL: without these flags claude.ai won't backend-execute the connector tool → /tool_approval 404s
  assert.equal(t.backend_execution, true);
  assert.equal(t.needs_approval, false);
  assert.equal(t.is_mcp_app, false);
});

test('a def without an inputSchema still yields a valid object schema (claude.ai requires one)', () => {
  const out = buildConnectorToolsArray(CONN, DEFS, ['session_status']);
  assert.deepEqual(out[0].input_schema, { type: 'object', properties: {} });
});

test('no names → uses the connector’s advertised tool list', () => {
  const out = buildConnectorToolsArray(CONN, DEFS);
  assert.equal(out.length, 3);
});

test('names restricts the set (and ignores unknown names)', () => {
  const out = buildConnectorToolsArray(CONN, DEFS, ['list_nodes', 'nope']);
  assert.deepEqual(out.map((t) => t.name), ['list_nodes']);
});

test('pickLmAssistConnector prefers the connected langmart server', () => {
  const servers = [
    { uuid: 'g', url: 'https://drivemcp.googleapis.com/mcp/v1', name: 'Google Drive', connected: false },
    { uuid: 'x', url: 'https://mcp.xeenhub.com/mcp', name: 'lm-assist', connected: false },
    { uuid: 'l', url: 'https://mcp.langmart.ai/mcp', name: 'lm-assist langmart', connected: true },
  ];
  assert.equal(pickLmAssistConnector(servers)!.uuid, 'l');
});

test('pickLmAssistConnector falls back to the sole connected server, else undefined', () => {
  assert.equal(pickLmAssistConnector([{ uuid: 'a', url: 'u', name: 'n', connected: true }])!.uuid, 'a');
  assert.equal(pickLmAssistConnector([
    { uuid: 'a', url: 'u', name: 'n', connected: true },
    { uuid: 'b', url: 'v', name: 'm', connected: true },
  ]), undefined);
});
