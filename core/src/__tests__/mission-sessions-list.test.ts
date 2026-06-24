import { test } from 'node:test';
import assert from 'node:assert';
import type { Mission } from '../mission/mission-model';
import { handleAllSessions } from '../routes/core/mission.routes';
import type { ControllerSession } from '../mission/mission-store';
import type { WorkerRecord } from '../worker-role/types';

function memPort(missions: Mission[] = [], cs?: ControllerSession | null) {
  const db = new Map<string, Mission>(missions.map((m) => [m.id, m]));
  // Store controller session if provided
  if (cs) {
    db.set('__controller__', { id: '__controller__', ...cs } as unknown as Mission);
  }
  return {
    isEnabled: () => true,
    get: async (id: string) => db.get(id) ?? null,
    list: async () => [...db.values()],
    put: async (m: Mission) => { db.set(m.id, m); },
    del: async (id: string) => { db.delete(id); },
  };
}

function makeActiveMission(id: string, orchestratorSid: string): Mission {
  return {
    id,
    title: 'Test',
    objective: 'test',
    projects: [],
    dependsOn: [],
    env: { isolation: 'cloud', resources: [] },
    binding: {
      sessionId: orchestratorSid,
      node: 'cloud',
      kind: 'orchestrator',
      boundAt: 1000,
      ccr: { cse: `cse_${orchestratorSid.replace('session_', '')}`, sid: orchestratorSid, webUrl: null },
    },
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
}

const cs: ControllerSession = {
  node: 'gw1',
  sessionId: 'session_ctrl',
  cse: null,
  tmux: 'lm-ctrl',
  startedAt: 1000,
};

test('handleAllSessions returns controller row + orchestrator row', async () => {
  const mission = makeActiveMission('mission_1', 'session_o1');
  const port = memPort([mission], cs);
  const noWorkers = (): WorkerRecord[] => [];
  const r = await handleAllSessions(port as any, noWorkers, 'session_ctrl');
  assert.ok(r.success);
  const { sessions } = r.data as { sessions: any[] };
  // Should have controller + orchestrator
  assert.ok(sessions.length >= 2);
  const ctrl = sessions.find((s: any) => s.role === 'controller');
  assert.ok(ctrl, 'should have a controller row');
  assert.equal(ctrl.sid, 'session_ctrl');
  assert.ok(ctrl.transport);
  const orch = sessions.find((s: any) => s.role === 'orchestrator');
  assert.ok(orch, 'should have an orchestrator row');
  assert.equal(orch.missionId, 'mission_1');
  assert.ok(orch.transport);
});

test('handleAllSessions without controller returns only mission sessions', async () => {
  const mission = makeActiveMission('mission_2', 'session_o2');
  const port = memPort([mission]);
  const noWorkers = (): WorkerRecord[] => [];
  const r = await handleAllSessions(port as any, noWorkers, null);
  assert.ok(r.success);
  const { sessions } = r.data as { sessions: any[] };
  assert.ok(sessions.every((s: any) => s.role !== 'controller'));
  assert.ok(sessions.some((s: any) => s.missionId === 'mission_2'));
});

test('handleAllSessions transport is cloud for session_ sids', async () => {
  const mission = makeActiveMission('mission_3', 'session_xyz');
  const port = memPort([mission]);
  const noWorkers = (): WorkerRecord[] => [];
  const r = await handleAllSessions(port as any, noWorkers, null);
  assert.ok(r.success);
  const { sessions } = r.data as { sessions: any[] };
  const row = sessions.find((s: any) => s.sid === 'session_xyz');
  assert.ok(row);
  assert.equal(row.transport, 'cloud');
});
