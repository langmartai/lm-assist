import { test } from 'node:test';
import assert from 'node:assert';
import { handleSchedule, handleChanges } from '../routes/core/mission.routes';
import { newMission, type Mission, type MissionActor, type MissionChange } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
const mk = (id: string, over: Partial<Mission> = {}): Mission =>
  ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: actor }, 1, () => id), id, ...over });
function memPort(seed: Mission[]) {
  const db = new Map(seed.map((m) => [m.id, m]));
  return { db, get: async (id: string) => db.get(id) ?? null, list: async () => [...db.values()], put: async (m: Mission) => { db.set(m.id, m); } };
}

test('handleSchedule returns the deterministic schedule', async () => {
  const port = memPort([mk('a', { status: 'waiting', dependsOn: ['b'] }), mk('b', { status: 'done' })]);
  const r = await handleSchedule({}, port as any);
  const d = r.data as { ready: string[]; blocked: unknown[] };
  assert.deepEqual(d.ready, ['a']);
});

test('handleChanges returns external changes only', async () => {
  const ctrlChange: MissionChange = { rev: 1, at: 100, actor: { kind: 'controller', channel: 'controller', node: 'n', at: 100 }, changes: { 'ctl:readiness': { from: null, to: 'ready' } } };
  const userChange: MissionChange = { rev: 2, at: 200, actor, changes: { objective: { from: 'o', to: 'o2' } } };
  const port = memPort([mk('a', { history: [ctrlChange, userChange] })]);
  const r = await handleChanges({}, port as any);
  const d = r.data as { changes: Array<{ rev: number }> };
  assert.deepEqual(d.changes.map((c) => c.rev), [2]);
});
