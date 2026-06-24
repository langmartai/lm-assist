import { test } from 'node:test';
import assert from 'node:assert';
import type { Mission } from '../mission/mission-model';
import { handleGetController } from '../routes/core/mission.routes';
import type { LeaderInfo } from '../routes/core/mission.routes';
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

// ── Task 2 (Wave 2.2): leader identity ─────────────────────────────────────

test('GET /mission/controller includes leader with host resolved from stub (isSelf=false)', async () => {
  const port = memPort(null);
  const fakeElection = { isMonitor: false, monitorNodeId: 'gw-x' };
  const fakeJob = {};
  // selfId is returned by thisNode() which reads getHubConfig().gatewayId — here we stub 'gw-y' as self via a different leaderNode
  const r = await handleGetController(
    port as any,
    async () => fakeElection,
    () => fakeJob as any,
    async (_node) => 'yitest',
  );
  assert.ok(r.success, 'should succeed');
  const d = r.data as any;
  assert.ok('leader' in d, 'data should include leader key');
  const leader = d.leader as LeaderInfo;
  assert.equal(leader.node, 'gw-x');
  assert.equal(leader.host, 'yitest');
  // isSelf depends on thisNode(); in test env gatewayId is probably 'unknown' ≠ 'gw-x'
  assert.equal(typeof leader.isSelf, 'boolean', 'isSelf should be a boolean');
});

test('GET /mission/controller leader.isSelf is false when monitorNodeId !== selfId', async () => {
  const port = memPort(null);
  // Force monitorNodeId to a value that won't match the test env's thisNode() ('unknown')
  const fakeElection = { isMonitor: false, monitorNodeId: 'gw-x' };
  const r = await handleGetController(
    port as any,
    async () => fakeElection,
    () => ({} as any),
    async (_n) => null,
  );
  assert.ok(r.success);
  const leader = (r.data as any).leader as LeaderInfo;
  assert.equal(leader.node, 'gw-x');
  assert.equal(leader.host, null);
  assert.equal(leader.isSelf, false, 'gw-x should not equal the test-env thisNode()');
});

test('GET /mission/controller leader is null-node when election has no monitorNodeId', async () => {
  const port = memPort(null);
  const fakeElection = { isMonitor: false, monitorNodeId: null };
  const r = await handleGetController(
    port as any,
    async () => fakeElection,
    () => ({} as any),
    async (_n) => null,
  );
  assert.ok(r.success);
  const leader = (r.data as any).leader as LeaderInfo;
  assert.equal(leader.node, null);
  assert.equal(leader.host, null);
  assert.equal(leader.isSelf, false);
});
