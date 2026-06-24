import { test } from 'node:test';
import assert from 'node:assert';
import { Mission } from '../mission/mission-model';
import {
  MissionDataPort, listMissions, listActiveMissions, putMission,
  getEngagementState, putEngagementState, setMissionInterim,
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
} as unknown as Mission);

test('getEngagementState: default when absent', async () => {
  const p = fakePort();
  const s = await getEngagementState(p);
  assert.deepEqual(s, { lastEngagedAt: null, lastActiveIds: [], seen: {} });
});

test('putEngagementState → getEngagementState round-trips', async () => {
  const p = fakePort();
  await putEngagementState({ lastEngagedAt: 123, lastActiveIds: ['a', 'b'], seen: { a: { alive: true, gated: false, cursor: 4 } } }, p);
  const s = await getEngagementState(p);
  assert.equal(s.lastEngagedAt, 123);
  assert.deepEqual(s.lastActiveIds, ['a', 'b']);
  assert.deepEqual(s.seen.a, { alive: true, gated: false, cursor: 4 });
});

test('__engagement__ is excluded from listMissions and listActiveMissions', async () => {
  const p = fakePort();
  await putMission(mk({ id: 'mission_real', status: 'active' }), p);
  await putEngagementState({ lastEngagedAt: 1, lastActiveIds: [], seen: {} }, p);
  const all = await listMissions(p);
  const active = await listActiveMissions(p);
  assert.deepEqual(all.map((m) => m.id), ['mission_real']);
  assert.deepEqual(active.map((m) => m.id), ['mission_real']);
});

test('setMissionInterim sets mission.interim and persists', async () => {
  const p = fakePort();
  await putMission(mk({ id: 'mission_x' }), p);
  const updated = await setMissionInterim('mission_x', { at: 999, text: 'running tests' }, p);
  assert.equal(updated?.interim?.text, 'running tests');
  const reread = await p.get('mission_x');
  assert.equal(reread?.interim?.at, 999);
});

test('setMissionInterim on missing mission → null', async () => {
  const p = fakePort();
  const r = await setMissionInterim('nope', { at: 1, text: 'x' }, p);
  assert.equal(r, null);
});
