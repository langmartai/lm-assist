import { test } from 'node:test';
import assert from 'node:assert';
import { MISSION_QUERY_TOOL_DEFS } from '../mcp-server/tools/mission-query';
test('MISSION_QUERY_TOOL_DEFS enumerates exactly the 7 query+view tools', () => {
  assert.deepStrictEqual(
    MISSION_QUERY_TOOL_DEFS.map((t) => t.name).sort(),
    ['mission_graph', 'mission_neighbors', 'mission_query', 'mission_view_delete', 'mission_view_get', 'mission_view_list', 'mission_view_set'].sort(),
  );
});
