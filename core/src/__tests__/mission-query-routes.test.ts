import { test } from 'node:test';
import assert from 'node:assert';
import { handleQuery, handleNeighbors, handleGraph } from '../routes/core/mission.routes';
import { newMission, type Mission, type MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
const mk = (id: string, over: Partial<Mission> = {}): Mission => ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: actor }, 1, () => id), id, ...over });
function memPort(seed: Mission[]) {
  const db = new Map(seed.map((m) => [m.id, m]));
  return { db, get: async (id: string) => db.get(id) ?? null, list: async () => [...db.values()], put: async (m: Mission) => { db.set(m.id, m); } };
}

test('handleQuery filters by status', async () => {
  const port = memPort([mk('a', { status: 'active' }), mk('b', { status: 'done' })]);
  const r = await handleQuery({ filter: [{ field: 'status', op: 'eq', value: 'active' }] }, port as any);
  assert.deepEqual((r.data as { missions: Mission[] }).missions.map((m) => m.id), ['a']);
});

test('handleQuery surfaces a bad op as a structured error', async () => {
  const port = memPort([mk('a')]);
  const r = await handleQuery({ filter: [{ field: 'status', op: 'bogus', value: 'x' }] }, port as any);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'BAD_FILTER_OP');
});

test('handleNeighbors returns neighbors + edges; NOT_FOUND for missing', async () => {
  const port = memPort([mk('a', { parentId: 'b' }), mk('b')]);
  const r = await handleNeighbors('a', { direction: 'parents', depth: 1 }, port as any);
  const d = r.data as { neighbors: Array<{ id: string }>; edges: unknown[] };
  assert.deepEqual(d.neighbors.map((n) => n.id), ['b']);
  assert.deepEqual(d.edges, [{ from: 'b', to: 'a', type: 'parent' }]);
  assert.equal((await handleNeighbors('zzz', {}, port as any)).error!.code, 'NOT_FOUND');
});

test('handleGraph returns nodes + edges, with expand', async () => {
  const port = memPort([mk('a', { status: 'active', dependsOn: ['b'] }), mk('b', { status: 'done' })]);
  const r = await handleGraph({ filter: [{ field: 'status', op: 'eq', value: 'active' }], expand: { direction: 'dependencies', depth: 1 } }, port as any);
  const d = r.data as { nodes: Array<{ id: string }>; edges: Array<{ from: string; to: string; type: string }> };
  assert.deepEqual(d.nodes.map((n) => n.id).sort(), ['a', 'b']);
  assert.deepEqual(d.edges, [{ from: 'a', to: 'b', type: 'dependsOn' }]);
});

test('handleGraph coerces a STRING expand.depth (MCP delivers numbers as strings)', async () => {
  // a -> b -> c (2-hop dependsOn chain); depth as the STRING "2" must reach c.
  const port = memPort([mk('a', { status: 'active', dependsOn: ['b'] }), mk('b', { status: 'done', dependsOn: ['c'] }), mk('c', { status: 'done' })]);
  const r = await handleGraph({ filter: [{ field: 'status', op: 'eq', value: 'active' }], expand: { direction: 'dependencies', depth: '2' } }, port as any);
  const d = r.data as { nodes: Array<{ id: string }> };
  assert.deepEqual(d.nodes.map((n) => n.id).sort(), ['a', 'b', 'c']);
});
