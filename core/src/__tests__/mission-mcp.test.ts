import { test } from 'node:test';
import assert from 'node:assert';
import { MISSION_TOOL_DEFS } from '../mcp-server/tools/mission';

test('exposes the four mission tools', () => {
  const names = MISSION_TOOL_DEFS.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['mission_control_status', 'mission_create', 'mission_list', 'mission_update']);
});
test('mission_create requires title + objective', () => {
  const def = MISSION_TOOL_DEFS.find((t) => t.name === 'mission_create')!;
  assert.deepStrictEqual([...def.inputSchema.required].sort(), ['objective', 'title']);
});
