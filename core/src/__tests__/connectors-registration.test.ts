import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeClaudeRegistrations } from '../mcp-server/connectors';

const PROD = 'https://mcp.langmart.ai';

test('registration status is per URL: every connector of this hub, each with its profile', () => {
  const s = summarizeClaudeRegistrations([
    { uuid: 'b', name: 'lm-assist langmart basic', url: `${PROD}/mcp/basic` },
    { uuid: 'u', name: 'lm-assist langmart', url: `${PROD}/mcp` },
    { uuid: 'd', name: 'lm-assist dev', url: 'https://mcp.xeenhub.com/mcp' },
  ], PROD);
  assert.deepEqual(s.claudeServers.map((c) => [c.uuid, c.profile]), [['b', 'basic'], ['u', null]]);
  assert.equal(s.preferredName, 'lm-assist langmart');
});

test('a /mcp/<profile> connector counts as registered (the old exact `/mcp` match missed it)', () => {
  const s = summarizeClaudeRegistrations([{ uuid: 'b', name: 'lm-assist langmart basic', url: `${PROD}/mcp/basic` }], PROD);
  assert.equal(s.claudeServers.length, 1);
  assert.equal(s.preferredName, 'lm-assist langmart basic');
});
