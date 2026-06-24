import { test } from 'node:test';
import assert from 'node:assert';
import { MISSION_TOOL_DEFS, withActorHint } from '../mcp-server/tools/mission';

test('exposes the ten mission tools (4 core + 6 session/rail)', () => {
  const names = MISSION_TOOL_DEFS.map((t) => t.name).sort();
  assert.deepStrictEqual(names, [
    'mission_control_status',
    'mission_create',
    'mission_executor_status',
    'mission_list',
    'mission_place',
    'mission_session_control',
    'mission_session_drive',
    'mission_session_read',
    'mission_sessions',
    'mission_update',
  ]);
});
test('mission_create requires title + objective', () => {
  const def = MISSION_TOOL_DEFS.find((t) => t.name === 'mission_create')!;
  assert.deepStrictEqual([...def.inputSchema.required].sort(), ['objective', 'title']);
});

test('withActorHint attaches an mcp _actor with the toolUseId', () => {
  const out = withActorHint({ title: 't' }, 'toolu_9');
  assert.deepEqual((out as any)._actor, { channel: 'mcp', toolUseId: 'toolu_9' });
  assert.equal((out as any).title, 't');
});

test('withActorHint tolerates a missing toolUseId', () => {
  assert.equal(((withActorHint({}, undefined) as any)._actor).toolUseId, null);
});
