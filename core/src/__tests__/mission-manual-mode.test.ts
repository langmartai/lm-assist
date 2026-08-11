import { test } from 'node:test';
import assert from 'node:assert';
import { newMission, type MissionActor } from '../mission/mission-model';
import { applyManageMode } from '../mission/manual-mode';

const human: MissionActor = { kind: 'user', channel: 'mcp', at: 1 };
const controller: MissionActor = { kind: 'controller', channel: 'controller', at: 1 };

test('manageMode is settable on a non-onboarded mission', () => {
  const m = newMission({ title: 't', objective: 'o', ownerNode: 'n', createdBy: human }, 1, () => 'mission_x');
  assert.equal(m.origin, undefined, 'precondition: not an onboarded mission');
  const r = applyManageMode(m, 'standby', human);
  assert.equal(r.ok, true, 'a plain worker mission must accept standby');
  assert.equal(m.manageMode, 'standby');
});

test('manageMode stays human-only', () => {
  const m = newMission({ title: 't', objective: 'o', ownerNode: 'n', createdBy: human }, 1, () => 'mission_y');
  const r = applyManageMode(m, 'handoff', controller);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'FORBIDDEN');
});

test('manageMode rejects an unknown value', () => {
  const m = newMission({ title: 't', objective: 'o', ownerNode: 'n', createdBy: human }, 1, () => 'mission_z');
  const r = applyManageMode(m, 'paused', human);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'INVALID_INPUT');
});
