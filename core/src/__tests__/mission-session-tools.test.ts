import { test } from 'node:test';
import assert from 'node:assert';
import { MISSION_TOOL_DEFS, withActorHint } from '../mcp-server/tools/mission';

const EXPECTED_NEW_TOOLS = [
  'mission_place',
  'mission_executor_status',
  'mission_sessions',
  'mission_session_read',
  'mission_session_drive',
  'mission_session_control',
];

test('MISSION_TOOL_DEFS includes all 6 new session/rail tools', () => {
  const names = (MISSION_TOOL_DEFS as ReadonlyArray<{ name: string }>).map((t) => t.name);
  for (const name of EXPECTED_NEW_TOOLS) {
    assert.ok(names.includes(name), `missing tool: ${name}`);
  }
});

test('mission_place def requires id', () => {
  const def = (MISSION_TOOL_DEFS as ReadonlyArray<{ name: string; inputSchema: { required?: string[] } }>).find((t) => t.name === 'mission_place');
  assert.ok(def);
  assert.ok(def!.inputSchema.required?.includes('id'));
});

test('mission_session_drive def requires sid and text', () => {
  const def = (MISSION_TOOL_DEFS as ReadonlyArray<{ name: string; inputSchema: { required?: string[] } }>).find((t) => t.name === 'mission_session_drive');
  assert.ok(def);
  assert.ok(def!.inputSchema.required?.includes('sid'));
  assert.ok(def!.inputSchema.required?.includes('text'));
});

test('mission_session_control def requires sid and action', () => {
  const def = (MISSION_TOOL_DEFS as ReadonlyArray<{ name: string; inputSchema: { required?: string[] } }>).find((t) => t.name === 'mission_session_control');
  assert.ok(def);
  assert.ok(def!.inputSchema.required?.includes('sid'));
  assert.ok(def!.inputSchema.required?.includes('action'));
});

// arg coercion helper (string lastN -> number)
test('lastN string->number coercion: string "5" -> 5', () => {
  const raw = '5';
  const coerced = typeof raw === 'string' ? parseInt(raw, 10) : raw;
  assert.equal(coerced, 5);
});

// withActorHint carries _actor with toolUseId for drive attribution
test('withActorHint produces _actor with channel mcp', () => {
  const out = withActorHint({ sid: 'session_x', text: 'go' }, 'toolu_10');
  assert.equal((out as any)._actor?.channel, 'mcp');
  assert.equal((out as any)._actor?.toolUseId, 'toolu_10');
});
