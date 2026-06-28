import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_STATUS_HANDLERS } from '../mcp-server/mcp-session-resolver';

test('session_status leads with the fleet/connector identity', async () => {
  const r = await SESSION_STATUS_HANDLERS.session_status({});
  const t = r.content[0].text as string;
  assert.match(t, /FLEET \/ CONNECTOR IDENTITY/, 'session_status must include the fleet identity block');
  assert.match(t, /OTHER lm-assist MCP connectors/, 'must carry the multi-connector caveat');
});

test('session_status still reports the node cluster (additive, not replaced)', async () => {
  const r = await SESSION_STATUS_HANDLERS.session_status({});
  const t = r.content[0].text as string;
  assert.match(t, /cluster/i, 'session_status must still report the node cluster');
});
