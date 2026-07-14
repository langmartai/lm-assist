import { test } from 'node:test';
import assert from 'node:assert';
import { MISSION_WORKFLOW_TOOL_DEFS, MISSION_WORKFLOW_HANDLERS } from '../mcp-server/tools/mission-workflow';

test('exactly the 5 workflow tools, defs and handlers aligned', () => {
  const names = MISSION_WORKFLOW_TOOL_DEFS.map((d) => d.name).sort();
  assert.deepEqual(names, ['mission_workflow_get', 'mission_workflow_history', 'mission_workflow_list', 'mission_workflow_rollback', 'mission_workflow_set']);
  assert.deepEqual(Object.keys(MISSION_WORKFLOW_HANDLERS).sort(), names);
  for (const d of MISSION_WORKFLOW_TOOL_DEFS) assert.ok(d.description.length > 20, d.name);
});

test('TOOL_SCOPES covers the 5 tools', () => {
  const { TOOL_SCOPES } = require('../mcp-server/configure');
  for (const d of MISSION_WORKFLOW_TOOL_DEFS) assert.ok(TOOL_SCOPES[d.name], d.name);
});
