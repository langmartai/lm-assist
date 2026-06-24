import { test } from 'node:test';
import assert from 'node:assert';
import { Mission } from '../mission/mission-model';
import { MissionDataPort } from '../mission/mission-store';
import { handleSessions } from '../routes/core/mission.routes';
import type { WorkerRecord } from '../worker-role/types';

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

function makeMission(id: string, overrides: Partial<Mission> = {}): Mission {
  return {
    id,
    title: 'Test',
    objective: 'Test objective',
    projects: [],
    dependsOn: [],
    env: { isolation: 'cloud', resources: [] },
    binding: null,
    progress: null,
    control: { nudgeCount: 0, backoffStep: 0 },
    results: [],
    adjustments: [],
    status: 'active',
    ownerNode: 'gw4-1',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Mission;
}

test('sessions with bound orchestrator + sub-workers', async () => {
  const port = fakePort();
  const m = makeMission('m1', {
    binding: {
      sessionId: 'session_orch',
      node: 'gw4-1',
      kind: 'orchestrator',
      boundAt: 1000,
    },
  });
  await port.put(m);

  const workers: WorkerRecord[] = [
    { sessionId: 'session_w1', role: 'worker', tasks: [], orchestrator: { id: 'session_orch', lastContact: 5 }, updatedAt: 0 },
    { sessionId: 'session_other', role: 'worker', tasks: [], orchestrator: { id: 'session_xyz' }, updatedAt: 0 },
  ] as any;

  const res = await handleSessions('m1', port, () => workers);
  assert.strictEqual(res.success, true);
  const sessions = (res.data as any).sessions as any[];
  assert.strictEqual(sessions.length, 2);
  assert.deepStrictEqual(sessions[0], { sid: 'session_orch', kind: 'orchestrator', role: 'primary', lastContact: 1000 });
  assert.deepStrictEqual(sessions[1], { sid: 'session_w1', kind: 'worker', role: 'sub', lastContact: 5 });
});

test('sessions with no binding returns empty list', async () => {
  const port = fakePort();
  await port.put(makeMission('m2'));

  const res = await handleSessions('m2', port, () => []);
  assert.strictEqual(res.success, true);
  assert.deepStrictEqual((res.data as any).sessions, []);
});

test('unknown mission id fails', async () => {
  const res = await handleSessions('mission_nope', fakePort(), () => []);
  assert.strictEqual(res.success, false);
  assert.strictEqual((res.error as any).code, 'NOT_FOUND');
});

test('orchestrator self-match excluded from sub-workers', async () => {
  const port = fakePort();
  const m = makeMission('m3', {
    binding: {
      sessionId: 'session_orch',
      node: 'gw4-1',
      kind: 'orchestrator',
      boundAt: 2000,
    },
  });
  await port.put(m);

  // Worker with same sid as orchestrator should not appear as a sub-worker
  const workers: WorkerRecord[] = [
    { sessionId: 'session_orch', role: 'worker', tasks: [], orchestrator: { id: 'session_orch', lastContact: 10 }, updatedAt: 0 },
    { sessionId: 'session_w2', role: 'worker', tasks: [], orchestrator: { id: 'session_orch', lastContact: 20 }, updatedAt: 0 },
  ] as any;

  const res = await handleSessions('m3', port, () => workers);
  assert.strictEqual(res.success, true);
  const sessions = (res.data as any).sessions as any[];
  assert.strictEqual(sessions.length, 2);
  assert.strictEqual(sessions[0].sid, 'session_orch');
  assert.strictEqual(sessions[0].role, 'primary');
  assert.strictEqual(sessions[1].sid, 'session_w2');
  assert.strictEqual(sessions[1].role, 'sub');
});

test('binding with worker kind shows worker in primary row', async () => {
  const port = fakePort();
  const m = makeMission('m4', {
    binding: {
      sessionId: 'session_wrkr',
      node: 'gw4-1',
      kind: 'worker',
      boundAt: 3000,
    },
  });
  await port.put(m);

  const res = await handleSessions('m4', port, () => []);
  assert.strictEqual(res.success, true);
  const sessions = (res.data as any).sessions as any[];
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].kind, 'worker');
  assert.strictEqual(sessions[0].role, 'primary');
});
