import { test } from 'node:test';
import assert from 'node:assert';
import type { Mission } from '../mission/mission-model';
import { handleGetController } from '../routes/core/mission.routes';
import type { ControllerSession } from '../mission/mission-store';

function memPort(cs?: ControllerSession | null) {
  const db = new Map<string, Mission>();
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

const cs: ControllerSession = {
  node: 'gw1',
  sessionId: 'session_ctrl',
  cse: 'cse_ctrl',
  tmux: 'lm-ctrl',
  startedAt: 1000,
};

test('GET /mission/controller data includes controllerSession when stored', async () => {
  const port = memPort(cs);
  const fakeElection = { isMonitor: true, monitorNodeId: 'gw1' };
  const fakeJob = { name: 'mission-controller', lastRunAt: 0 };
  const r = await handleGetController(port as any, async () => fakeElection, () => fakeJob as any);
  assert.ok(r.success);
  const d = r.data as any;
  assert.ok('controllerSession' in d, 'data should include controllerSession key');
  assert.ok(d.controllerSession !== null, 'controllerSession should be non-null when stored');
  assert.equal(d.controllerSession.sessionId, 'session_ctrl');
  assert.equal(d.controllerSession.node, 'gw1');
});

test('GET /mission/controller data controllerSession is null when none stored', async () => {
  const port = memPort(null);
  const fakeElection = { isMonitor: false, monitorNodeId: null };
  const fakeJob = { name: 'mission-controller', lastRunAt: 0 };
  const r = await handleGetController(port as any, async () => fakeElection, () => fakeJob as any);
  assert.ok(r.success);
  const d = r.data as any;
  assert.ok('controllerSession' in d);
  assert.equal(d.controllerSession, null);
});

test('GET /mission/controller data includes election and job fields', async () => {
  const port = memPort(null);
  const fakeElection = { isMonitor: true, monitorNodeId: 'gw2' };
  const fakeJob = { name: 'mission-controller', lastRunAt: 12345 };
  const r = await handleGetController(port as any, async () => fakeElection, () => fakeJob as any);
  assert.ok(r.success);
  const d = r.data as any;
  assert.ok(d.election, 'should include election');
  assert.ok(d.job !== undefined, 'should include job');
});
