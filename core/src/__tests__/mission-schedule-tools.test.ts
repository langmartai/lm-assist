import { test } from 'node:test';
import assert from 'node:assert';
import { MISSION_SCHEDULE_TOOL_DEFS } from '../mcp-server/tools/mission-schedule';
import { TOOL_SCOPES } from '../mcp-server/configure';

test('exposes exactly the two read tools with the right names', () => {
  assert.deepEqual(MISSION_SCHEDULE_TOOL_DEFS.map((t) => t.name).sort(), ['mission_changes', 'mission_schedule']);
});

test('both tools are scoped read in TOOL_SCOPES (boot-critical)', () => {
  assert.equal(TOOL_SCOPES['mission_schedule'], 'read');
  assert.equal(TOOL_SCOPES['mission_changes'], 'read');
});
