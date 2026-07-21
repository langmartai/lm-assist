import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_STATUS_HANDLERS } from '../mcp-server/mcp-session-resolver';
import { stopSessionCache } from '../session-cache';

// session_status() lazily constructs the singleton SessionCache, which starts a
// chokidar file watcher — an open handle that keeps the process alive so the test
// runner never exits (the "hang at setup" class). Release it after the suite.
after(() => stopSessionCache());

test('session_status leads with the fleet/connector identity', async () => {
  const r = await SESSION_STATUS_HANDLERS.session_status({});
  const t = r.content[0].text as string;
  assert.match(t, /FLEET \/ CONNECTOR IDENTITY/, 'session_status must include the fleet identity block');
  assert.match(t, /INDEPENDENT instances over DIFFERENT fleets/, 'must carry the multi-connector caveat');
});

test('session_status still reports the node cluster (additive, not replaced)', async () => {
  const r = await SESSION_STATUS_HANDLERS.session_status({});
  const t = r.content[0].text as string;
  assert.match(t, /cluster/i, 'session_status must still report the node cluster');
});
