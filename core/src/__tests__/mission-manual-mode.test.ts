import { test } from 'node:test';
import assert from 'node:assert';
import { newMission, type MissionActor } from '../mission/mission-model';
import { applyManageMode, manualBadge } from '../mission/manual-mode';
import { selectActive } from '../mission/mission-store';

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

test('manageMode fails CLOSED on a missing/unidentifiable actor', () => {
  const m = newMission({ title: 't', objective: 'o', ownerNode: 'n', createdBy: human }, 1, () => 'mission_w');
  const r = applyManageMode(m, 'standby', undefined);
  assert.equal(r.ok, false, 'an unknown caller must be refused, not trusted by default');
  if (!r.ok) assert.equal(r.code, 'FORBIDDEN');
  assert.equal(m.manageMode, undefined, 'must not have been mutated');
});

test('selectActive excludes standby missions', () => {
  const mk = (id: string, status: string, mode?: string) =>
    ({ id, status, manageMode: mode } as any);
  const all = [
    mk('mission_a', 'active'),
    mk('mission_b', 'active', 'standby'),
    mk('mission_c', 'waiting', 'standby'),
    mk('mission_d', 'waiting', 'handoff'),
    mk('mission_e', 'done'),
  ];
  const ids = selectActive(all).map((m) => m.id);
  assert.deepEqual(ids, ['mission_a', 'mission_d']);
});

test('a standby mission carries a MANUAL badge', () => {
  const m: any = { manageMode: 'standby', control: { lastHumanInputAt: 42 } };
  assert.deepEqual(manualBadge(m), { label: 'MANUAL', reason: 'human input at 42' });
});

test('a handoff mission has no badge', () => {
  assert.equal(manualBadge({ manageMode: 'handoff', control: {} } as any), null);
});
