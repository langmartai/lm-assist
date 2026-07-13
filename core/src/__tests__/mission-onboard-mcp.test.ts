import { test } from 'node:test';
import assert from 'node:assert';
import { MISSION_TOOL_DEFS } from '../mcp-server/tools/mission';

test('mission_onboard def present with the right schema', () => {
  const d = MISSION_TOOL_DEFS.find((x: any) => x.name === 'mission_onboard') as any;
  assert.ok(d, 'def exists');
  assert.ok(d.description.includes('standby'));
  for (const p of ['sessionId', 'cluster', 'mode', 'note']) assert.ok(d.inputSchema.properties[p], p);
  assert.deepEqual(d.inputSchema.required ?? [], [], 'no required args (self-onboard)');
});

test('scope registered', () => {
  const { TOOL_SCOPES } = require('../mcp-server/configure');
  assert.equal(TOOL_SCOPES.mission_onboard, 'write');
});
