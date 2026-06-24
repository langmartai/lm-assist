import { test } from 'node:test';
import assert from 'node:assert';
import { Mission } from '../mission/mission-model';
import {
  MissionDataPort, getMission, listMissions, listActiveMissions, putMission,
  bindExecutor, recordAdjustment, mirrorProgress, findMissionBySession,
} from '../mission/mission-store';

function fakePort(): MissionDataPort {
  const map = new Map<string, Mission>();
  return {
    isEnabled: () => true,
    get: async (id) => map.get(id) ?? null,
    list: async () => [...map.values()],
    put: async (m) => { map.set(m.id, JSON.parse(JSON.stringify(m))); },
    del: async (id) => { map.delete(id); },
  };
}
const mk = (over: Partial<Mission>): Mission => ({
  id: 'm', title: 't', objective: 'o', projects: [], dependsOn: [],
  env: { isolation: 'cloud', resources: [] }, binding: null, progress: null,
  control: { nudgeCount: 0, backoffStep: 0 }, results: [], adjustments: [],
  status: 'active', ownerNode: 'gw4-1', createdAt: 0, updatedAt: 0, ...over,
});

test('put + get round-trip', async () => {
  const p = fakePort();
  await putMission(mk({ id: 'a', objective: 'X' }), p);
  const got = await getMission('a', p);
  assert.strictEqual(got?.objective, 'X');
});
test('listActiveMissions filters to active+waiting', async () => {
  const p = fakePort();
  await putMission(mk({ id: 'a', status: 'active' }), p);
  await putMission(mk({ id: 'b', status: 'done' }), p);
  await putMission(mk({ id: 'c', status: 'waiting' }), p);
  const ids = (await listActiveMissions(p)).map((m) => m.id).sort();
  assert.deepStrictEqual(ids, ['a', 'c']);
});
test('bindExecutor sets binding', async () => {
  const p = fakePort();
  await putMission(mk({ id: 'a' }), p);
  await bindExecutor('a', { sessionId: 'sid1', node: 'h', kind: 'worker' }, p);
  assert.strictEqual((await getMission('a', p))?.binding?.sessionId, 'sid1');
});
test('mirrorProgress + recordAdjustment append', async () => {
  const p = fakePort();
  await putMission(mk({ id: 'a' }), p);
  await mirrorProgress('a', { percent: 50, summary: 'half', updatedAt: 1 }, [{ at: 1, ref: 'r1' }], p);
  await recordAdjustment('a', { at: 2, trigger: 'revise', change: 'narrowed', by: 'controller' }, p);
  const got = await getMission('a', p);
  assert.strictEqual(got?.progress?.percent, 50);
  assert.strictEqual(got?.results.length, 1);
  assert.strictEqual(got?.adjustments.length, 1);
});
test('findMissionBySession matches binding', async () => {
  const p = fakePort();
  await putMission(mk({ id: 'a', binding: { sessionId: 'sX', node: 'h', kind: 'worker' } }), p);
  assert.strictEqual((await findMissionBySession('sX', p))?.id, 'a');
  assert.strictEqual(await findMissionBySession('nope', p), null);
});
test('listMissions returns all', async () => {
  const p = fakePort();
  await putMission(mk({ id: 'a' }), p);
  await putMission(mk({ id: 'b' }), p);
  assert.strictEqual((await listMissions(p)).length, 2);
});
