import { test } from 'node:test';
import assert from 'node:assert';
import { upgradeControllerActor } from '../mission/mission-actor';
import type { MissionActor } from '../mission/mission-model';

const base: MissionActor = { kind: 'local-session', id: 'sess-123', node: 'n', channel: 'mcp', at: 1 };

test('upgrades a local-session whose id is the controller session to channel:controller', () => {
  const up = upgradeControllerActor(base, 'sess-123');
  assert.equal(up.kind, 'controller');
  assert.equal(up.channel, 'controller');
  assert.equal(up.id, 'sess-123');
});

test('leaves a non-controller local-session unchanged', () => {
  const up = upgradeControllerActor(base, 'other-session');
  assert.equal(up.kind, 'local-session');
  assert.equal(up.channel, 'mcp');
});

test('no controller session id -> unchanged', () => {
  assert.equal(upgradeControllerActor(base, null).channel, 'mcp');
  assert.equal(upgradeControllerActor(base, undefined).channel, 'mcp');
});

test('a non-local-session actor is never upgraded even on id match', () => {
  const ai: MissionActor = { kind: 'claudeai-conversation', id: 'sess-123', channel: 'mcp', at: 1 };
  assert.equal(upgradeControllerActor(ai, 'sess-123').channel, 'mcp');
});
