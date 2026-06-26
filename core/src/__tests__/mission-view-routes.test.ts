import { test } from 'node:test';
import assert from 'node:assert';
import { handleViewSet, handleViewList, handleViewGet, handleViewDelete, handleViewGraph } from '../routes/core/mission.routes';
import { newMission, type Mission, type MissionActor } from '../mission/mission-model';
import type { MissionView } from '../mission/mission-views';

const actor: MissionActor = { kind: 'user', channel: 'user', node: 'n', at: 1 };
const mk = (id: string, over: Partial<Mission> = {}): Mission => ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: actor }, 1, () => id), id, ...over });
function missionPort(seed: Mission[]) { const db = new Map(seed.map((m) => [m.id, m])); return { db, get: async (id: string) => db.get(id) ?? null, list: async () => [...db.values()], put: async (m: Mission) => { db.set(m.id, m); } }; }
function viewPort() { const db = new Map<string, MissionView>(); return { db, isEnabled: () => true, get: async (id: string) => db.get(id) ?? null, list: async () => [...db.values()], put: async (v: MissionView) => { db.set(v.id, v); }, del: async (id: string) => { db.delete(id); } }; }

test('view set → get → list → delete', async () => {
  const vp = viewPort();
  const set = await handleViewSet({ name: 'Active', query: { filter: [{ field: 'status', op: 'eq', value: 'active' }] }, display: { layout: 'dag' } }, vp as any, actor);
  const id = (set.data as MissionView).id;
  assert.ok(id.startsWith('view_'));
  assert.equal((set.data as MissionView).createdBy.kind, 'user');
  assert.equal((await handleViewGet(id, vp as any)).success, true);
  assert.deepEqual((((await handleViewList(vp as any)).data) as { views: MissionView[] }).views.map((v) => v.id), [id]);
  await handleViewDelete(id, vp as any);
  assert.equal((await handleViewGet(id, vp as any)).error!.code, 'NOT_FOUND');
});

test('view set rejects an empty name', async () => {
  const r = await handleViewSet({ name: '' }, viewPort() as any, actor);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'INVALID_VIEW');
});

test('view render with expand.depth but no direction defaults direction to "all"', async () => {
  // Regression: handleViewGraph previously only expanded if exp.direction was set;
  // a saved view with {depth:1} and NO direction did no expansion. buildGraph now
  // defaults direction to 'all', matching handleGraph behavior.
  const vp = viewPort();
  const mp = missionPort([mk('a', { status: 'active', parentId: 'b' }), mk('b', { status: 'done' })]);
  const set = await handleViewSet({ name: 'X', query: { filter: [{ field: 'status', op: 'eq', value: 'active' }], expand: { depth: 1 } } }, vp as any, actor);
  const id = (set.data as MissionView).id;
  const r = await handleViewGraph(id, vp as any, mp as any);
  assert.equal(r.success, true);
  const d = r.data as { nodes: Array<{ id: string }> };
  // 'a' matches the filter; expansion (default direction=all) must pull in parent 'b'.
  assert.deepEqual(d.nodes.map((n) => n.id).sort(), ['a', 'b']);
});

test('view render runs the query → {view, nodes, edges}', async () => {
  const vp = viewPort();
  const mp = missionPort([mk('a', { status: 'active', dependsOn: ['b'] }), mk('b', { status: 'done' })]);
  const set = await handleViewSet({ name: 'G', query: { filter: [{ field: 'status', op: 'eq', value: 'active' }], expand: { direction: 'dependencies', depth: 1 } } }, vp as any, actor);
  const id = (set.data as MissionView).id;
  const r = await handleViewGraph(id, vp as any, mp as any);
  const d = r.data as { view: MissionView; nodes: Array<{ id: string }>; edges: unknown[] };
  assert.equal(d.view.id, id);
  assert.deepEqual(d.nodes.map((n) => n.id).sort(), ['a', 'b']);
  assert.deepEqual(d.edges, [{ from: 'a', to: 'b', type: 'dependsOn' }]);
});
