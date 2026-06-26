import { test } from 'node:test';
import assert from 'node:assert';
import type { Mission } from '../mission/mission-model';
import { listMissions, putMission } from '../mission/mission-store';
import { getControllerSession, putControllerSession } from '../mission/mission-store';
import type { ControllerSession } from '../mission/mission-store';

function memPort() {
  const db = new Map<string, Mission>();
  return {
    db,
    isEnabled: () => true,
    get: async (id: string) => db.get(id) ?? null,
    list: async () => [...db.values()],
    put: async (m: Mission) => { db.set(m.id, m); },
    del: async (id: string) => { db.delete(id); },
  };
}

const cs: ControllerSession = {
  node: 'gw1',
  sessionId: 'session_abc',
  cse: null,
  tmux: 'lm-ctrl',
  startedAt: 1000,
};

test('putControllerSession then getControllerSession returns it', async () => {
  const port = memPort();
  await putControllerSession(cs, port as any);
  const got = await getControllerSession(port as any);
  assert.ok(got !== null);
  assert.equal(got!.node, 'gw1');
  assert.equal(got!.sessionId, 'session_abc');
  assert.equal(got!.tmux, 'lm-ctrl');
});

test('putControllerSession(null) clears the entry', async () => {
  const port = memPort();
  await putControllerSession(cs, port as any);
  await putControllerSession(null, port as any);
  const got = await getControllerSession(port as any);
  assert.equal(got, null);
});

test('listMissions excludes __controller__ record', async () => {
  const port = memPort();
  // Put a real mission
  const fakeMission: Mission = {
    id: 'mission_1',
    title: 'Test',
    objective: 'test',
    projects: [],
    dependsOn: [],
    tags: {},
    parentId: null,
    rev: 1,
    history: [],
    env: { isolation: 'cloud', resources: [] },
    binding: null,
    progress: null,
    control: { nudgeCount: 0, backoffStep: 0 },
    results: [],
    adjustments: [],
    createdBy: { kind: 'user', channel: 'user', node: 'gw1', at: 0 },
    lastUpdatedBy: { kind: 'user', channel: 'user', node: 'gw1', at: 0 },
    status: 'active',
    ownerNode: 'gw1',
    createdAt: 0,
    updatedAt: 0,
  };
  await putMission(fakeMission, port as any);
  await putControllerSession(cs, port as any);

  const missions = await listMissions(port as any);
  assert.ok(missions.every((m) => m.id !== '__controller__'));
  assert.equal(missions.length, 1);
  assert.equal(missions[0].id, 'mission_1');
});
