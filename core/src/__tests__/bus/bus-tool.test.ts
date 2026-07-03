// core/src/__tests__/bus/bus-tool.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BUS_TOOL_DEFS, formatTopics } from '../../mcp-server/tools/bus';
import { TOOL_SCOPES } from '../../mcp-server/configure';

test('three bus tools are defined and scoped (else /mcp crashes)', () => {
  const names = BUS_TOOL_DEFS.map((d) => d.name).sort();
  assert.deepEqual(names, ['bus_publish', 'bus_read', 'bus_topics']);
  assert.equal(BUS_TOOL_DEFS.find((d) => d.name === 'bus_read')!.annotations.readOnlyHint, true);
  assert.equal(BUS_TOOL_DEFS.find((d) => d.name === 'bus_publish')!.annotations.readOnlyHint, false);
  assert.equal(TOOL_SCOPES['bus_publish'], 'write');
  assert.equal(TOOL_SCOPES['bus_read'], 'read');
  assert.equal(TOOL_SCOPES['bus_topics'], 'read');
});

test('formatTopics renders a topic table', () => {
  const s = formatTopics([{ topic: 'mission:1', events: 3, origins: 2, subscribers: 1, lag: 0, oldestAt: null, newestAt: null, head: {} }]);
  assert.match(s, /mission:1/);
  assert.match(s, /3/);
});
