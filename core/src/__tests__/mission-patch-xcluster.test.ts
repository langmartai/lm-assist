/**
 * Cross-cluster mission_update routing (2026-07-21 "progress seems stuck" incident).
 *
 * Mission datasets are CLUSTER-scoped. When an executor's mission_update is relayed
 * by the connector to a node in a DIFFERENT cluster than the mission's origin, the
 * old handlePatch (a) had no way to redirect and (b) rejected a `cluster` routing
 * hint as UNSUPPORTED_FIELD — so the executor's write hit "no mission <id>" on the
 * wrong cluster and its progress never reached the store the controller reads.
 *
 * Fix (additive, mirrors handleOnboard's cluster targeting): handlePatch consumes a
 * `cluster` hint — when it names another cluster, it proxies the write to that
 * cluster's leader; when it names ours (or is absent) behaviour is unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePatch, type XClusterDeps } from '../routes/core/mission.routes';
import { newMission, type Mission, type MissionActor } from '../mission/mission-model';

const human: MissionActor = { kind: 'user', channel: 'user', node: 'n', at: 1 };

const mk = (id: string, over: Partial<Mission> = {}): Mission =>
  ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: human }, 1, () => id), id, ...over });

function memPort(seed: Mission[]) {
  const db = new Map(seed.map((m) => [m.id, m]));
  return { db, get: async (id: string) => db.get(id) ?? null, list: async () => [...db.values()], put: async (m: Mission) => { db.set(m.id, m); } };
}

/** A stage node (self=s1) that can see a prod leader p1 in another cluster. */
function mockXCluster(overrides: Partial<XClusterDeps> = {}) {
  const proxied: Array<{ node: string; path: string; body: any }> = [];
  const xc: XClusterDeps = {
    myCluster: () => 'stage',
    selfNode: () => 's1',
    clusterRecords: async () => [{ gatewayId: 'p1', cluster: 'prod' }, { gatewayId: 's1', cluster: 'stage' }],
    onlineNodes: async () => ['p1', 's1'],
    proxyPost: async (node, path, body) => { proxied.push({ node, path, body }); return { success: true, data: { proxied: true, id: 'm1' } }; },
    ...overrides,
  };
  return { xc, proxied };
}

test('a cross-cluster `cluster` hint proxies the write to that cluster leader — local store untouched', async () => {
  const port = memPort([]); // stage has NO copy of the prod mission
  const { xc, proxied } = mockXCluster();
  const r = await handlePatch('m1', { cluster: 'prod', status: 'done' }, port as any, human, undefined, xc);
  assert.equal(r.success, true, 'proxied write succeeds even though the mission is absent locally');
  assert.equal(proxied.length, 1, 'exactly one cross-cluster proxy hop');
  assert.equal(proxied[0].node, 'p1', 'routed to the prod cluster leader');
  assert.equal(proxied[0].path, '/mission/m1');
  assert.equal(proxied[0].body.cluster, undefined, '`cluster` is stripped before the hop so the target does not re-loop or reject it');
  assert.equal(proxied[0].body.status, 'done', 'the actual patch is forwarded');
  assert.equal(port.db.size, 0, 'nothing written to the wrong (local) cluster');
});

test('a same-cluster `cluster` hint is consumed (NOT an unsupported field) and applied locally', async () => {
  const port = memPort([mk('m1')]);
  const { xc, proxied } = mockXCluster();
  const r = await handlePatch('m1', { cluster: 'stage', status: 'done' }, port as any, human, undefined, xc);
  assert.equal(r.success, true);
  assert.equal(proxied.length, 0, 'no proxy hop — the mission is in our own cluster');
  assert.equal(port.db.get('m1')!.status, 'done', 'patch applied locally');
});

test('this node IS the target cluster leader → handled locally, no self-proxy', async () => {
  const port = memPort([mk('m1')]);
  const { xc, proxied } = mockXCluster({ myCluster: () => 'stage', selfNode: () => 'p1' }); // we are p1, the prod leader
  const r = await handlePatch('m1', { cluster: 'prod', status: 'blocked' }, port as any, human, undefined, xc);
  assert.equal(r.success, true);
  assert.equal(proxied.length, 0, 'we are the target leader — do not proxy to ourselves');
  assert.equal(port.db.get('m1')!.status, 'blocked');
});

test('no `cluster` hint → behaviour unchanged (regression guard)', async () => {
  const port = memPort([mk('m1')]);
  const { xc, proxied } = mockXCluster();
  const r = await handlePatch('m1', { status: 'done' }, port as any, human, undefined, xc);
  assert.equal(r.success, true);
  assert.equal(proxied.length, 0);
  assert.equal(port.db.get('m1')!.status, 'done');
});

test('target cluster has no online node → LEADER_UNREACHABLE, nothing written locally', async () => {
  const port = memPort([]);
  const { xc } = mockXCluster({ onlineNodes: async () => ['s1'] }); // no prod node online
  const r = await handlePatch('m1', { cluster: 'prod', status: 'done' }, port as any, human, undefined, xc);
  assert.equal(r.success, false);
  assert.equal((r as any).error.code, 'LEADER_UNREACHABLE');
  assert.equal(port.db.size, 0);
});

test('a hub hiccup during roster resolution degrades to LEADER_UNREACHABLE (not INTERNAL_ERROR)', async () => {
  const port = memPort([]);
  const { xc } = mockXCluster({ onlineNodes: async () => { throw new Error('Hub returned 502 for /machines'); } });
  const r = await handlePatch('m1', { cluster: 'prod', status: 'done' }, port as any, human, undefined, xc);
  assert.equal(r.success, false);
  assert.equal((r as any).error.code, 'LEADER_UNREACHABLE');
  assert.match((r as any).error.message, /could not resolve cluster "prod"/);
  assert.equal(port.db.size, 0);
});
