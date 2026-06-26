import { test } from 'node:test';
import assert from 'node:assert';
import type { Mission } from '../mission/mission-model';
import { handlePlace, handleExecutorStatus } from '../routes/core/mission.routes';
import type { ExecutorState } from '../mission/mission-model';

function memPort(missions: Mission[] = []) {
  const db = new Map<string, Mission>(missions.map((m) => [m.id, m]));
  return {
    isEnabled: () => true,
    get: async (id: string) => db.get(id) ?? null,
    list: async () => [...db.values()],
    put: async (m: Mission) => { db.set(m.id, m); },
    del: async (id: string) => { db.delete(id); },
  };
}

function makeMission(overrides: Partial<Mission>): Mission {
  return {
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
    ...overrides,
  };
}

test('handlePlace: mission with unmet dependency -> go:false reason:dependency', async () => {
  const m = makeMission({ id: 'mission_1', dependsOn: ['mission_2'] });
  const port = memPort([m]);
  const r = await handlePlace('mission_1', port as any);
  assert.ok(r.success);
  const d = r.data as any;
  assert.equal(d.go, false);
  assert.equal(d.reason, 'dependency');
});

test('handlePlace: cloud isolation ready mission -> go:true env:cloud', async () => {
  const m = makeMission({ id: 'mission_2', dependsOn: [] });
  const port = memPort([m]);
  const r = await handlePlace('mission_2', port as any);
  assert.ok(r.success);
  const d = r.data as any;
  assert.equal(d.go, true);
  assert.equal(d.env, 'cloud');
});

test('handleExecutorStatus: injected readExec stub returns its alive shape', async () => {
  const m = makeMission({ id: 'mission_3' });
  const port = memPort([m]);
  const stubState: ExecutorState = {
    alive: true, idle: false, serverStalled: false,
    gate: null, newOutput: { cursor: 5, messages: ['hello'], results: [] },
  };
  const r = await handleExecutorStatus('mission_3', port as any, async () => stubState);
  assert.ok(r.success);
  const d = r.data as any;
  assert.equal(d.alive, true);
  assert.equal(d.idle, false);
  assert.equal(d.status, 'has-output');
});

test('handleExecutorStatus: idle executor -> status idle', async () => {
  const m = makeMission({ id: 'mission_4' });
  const port = memPort([m]);
  const stubState: ExecutorState = {
    alive: true, idle: true, serverStalled: false, gate: null, newOutput: null,
  };
  const r = await handleExecutorStatus('mission_4', port as any, async () => stubState);
  assert.ok(r.success);
  const d = r.data as any;
  assert.equal(d.status, 'idle');
});

test('handlePlace: returns NOT_FOUND for unknown mission', async () => {
  const port = memPort([]);
  const r = await handlePlace('mission_unknown', port as any);
  assert.equal(r.success, false);
});
