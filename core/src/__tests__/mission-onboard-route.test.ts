import { test } from 'node:test';
import assert from 'node:assert';
import { handleOnboard } from '../routes/core/mission.routes';
import type { Mission, MissionActor } from '../mission/mission-model';
import type { MissionDataPort } from '../mission/mission-store';

function memPort(): MissionDataPort & { docs: Map<string, Mission> } {
  const docs = new Map<string, Mission>();
  return {
    docs,
    isEnabled: () => true,
    get: async (id) => docs.get(id) ?? null,
    list: async () => [...docs.values()],
    put: async (m) => { docs.set(m.id, m); },
    del: async (id) => { docs.delete(id); },
  };
}
const user: MissionActor = { kind: 'user', channel: 'mcp', at: 1 };
const localSession: MissionActor = { kind: 'local-session', id: 'caller-uuid-1', channel: 'mcp', at: 1 };
const ctrl: MissionActor = { kind: 'controller', channel: 'controller', at: 1 };

function deps(port: MissionDataPort, over: Record<string, unknown> = {}) {
  return {
    port, actor: user,
    clusterRecords: async () => [{ gatewayId: 'gw4-self', cluster: 'staging' }, { gatewayId: 'gw4-other', cluster: 'prod' }],
    myCluster: () => 'staging',
    onlineNodes: async () => ['gw4-self', 'gw4-other'],
    proxyPost: async () => { throw new Error('no proxy expected'); },
    nativeExists: () => true,
    selfNode: () => 'gw4-self',
    ...over,
  } as any;
}

test('explicit sessionId onboards with defaults (standby, own cluster)', async () => {
  const port = memPort();
  const r = await handleOnboard({ sessionId: 'uuid-x' }, deps(port));
  assert.equal(r.success, true);
  const m = (r.data as any).mission as Mission;
  assert.equal(m.origin, 'onboarded');
  assert.equal(m.manageMode, 'standby');
  assert.equal(m.binding!.sessionId, 'uuid-x');
  assert.equal(m.binding!.node, 'gw4-self');
  assert.deepEqual(m.tags['onboard:state'], ['analyzing']);
});

test('self-onboard resolves sid from a precise local-session actor; coarse actor errors', async () => {
  const port = memPort();
  const ok1 = await handleOnboard({}, deps(port, { actor: localSession }));
  assert.equal(ok1.success, true);
  assert.equal(((ok1.data as any).mission as Mission).binding!.sessionId, 'caller-uuid-1');
  const bad = await handleOnboard({}, deps(memPort(), { actor: user }));
  assert.equal(bad.success, false);
  assert.equal(bad.error!.code, 'INVALID_INPUT');
});

test('idempotent per session (non-terminal)', async () => {
  const port = memPort();
  const a = await handleOnboard({ sessionId: 'uuid-x' }, deps(port));
  const b = await handleOnboard({ sessionId: 'uuid-x', mode: 'handoff' }, deps(port));
  assert.equal(b.success, true);
  assert.equal((b.data as any).existing, true);
  assert.equal((b.data as any).mission.id, (a.data as any).mission.id);
  assert.equal((b.data as any).mission.manageMode, 'standby', 'existing mission returned unchanged');
});

test('mode validation + cloud transport node', async () => {
  const port = memPort();
  const bad = await handleOnboard({ sessionId: 'uuid-x', mode: 'auto' }, deps(port));
  assert.equal(bad.error!.code, 'INVALID_INPUT');
  const cloud = await handleOnboard({ sessionId: 'session_abc', mode: 'handoff' }, deps(port));
  assert.equal((cloud.data as any).mission.binding.node, 'cloud');
});

test('missing native session on own node → SESSION_NOT_FOUND', async () => {
  const r = await handleOnboard({ sessionId: 'uuid-x' }, deps(memPort(), { nativeExists: () => false }));
  assert.equal(r.error!.code, 'SESSION_NOT_FOUND');
});

test('cross-cluster target proxies to that cluster leader (fail-closed)', async () => {
  const port = memPort();
  let proxied: { node: string; path: string; body: any } | null = null;
  const r = await handleOnboard({ sessionId: 'uuid-x', cluster: 'prod' }, deps(port, {
    proxyPost: async (node: string, path: string, body: any) => { proxied = { node, path, body }; return { success: true, data: { mission: { id: 'mission_remote' } } }; },
  }));
  assert.equal(r.success, true);
  assert.equal(proxied!.node, 'gw4-other');
  assert.equal(proxied!.path, '/mission/onboard');
  assert.equal(proxied!.body.node, 'gw4-self', 'origin node stamped BEFORE proxying');
  const down = await handleOnboard({ sessionId: 'uuid-x', cluster: 'prod' }, deps(memPort(), {
    onlineNodes: async () => ['gw4-self'],
  }));
  assert.equal(down.error!.code, 'LEADER_UNREACHABLE');
});

test('cross-cluster session tagged', async () => {
  const port = memPort();
  // session node gw4-self is in staging; target staging→ no tag; but a node in prod with target staging → tag
  const r = await handleOnboard({ sessionId: 'uuid-x', node: 'gw4-other' }, deps(port, { nativeExists: () => { throw new Error('must not check non-self node'); } }));
  assert.equal(r.success, true);
  assert.deepEqual((r.data as any).mission.tags['onboard:cross-cluster'], ['true']);
});
