import { test } from 'node:test';
import assert from 'node:assert';
import { getView, listViews, putView, deleteView, type MissionViewPort } from '../mission/mission-views-store';
import type { MissionView } from '../mission/mission-views';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
const v = (id: string): MissionView => ({ id, name: id, query: {}, display: {}, createdBy: actor, lastUpdatedBy: actor, createdAt: 1, updatedAt: 1 });
function memPort(): MissionViewPort & { db: Map<string, MissionView> } {
  const db = new Map<string, MissionView>();
  return { db, isEnabled: () => true, get: async (id) => db.get(id) ?? null, list: async () => [...db.values()], put: async (x) => { db.set(x.id, x); }, del: async (id) => { db.delete(id); } };
}

test('put/get/list/delete round-trip', async () => {
  const p = memPort();
  await putView(v('view_a'), p);
  await putView(v('view_b'), p);
  assert.equal((await getView('view_a', p))!.name, 'view_a');
  assert.deepEqual((await listViews(p)).map((x) => x.id).sort(), ['view_a', 'view_b']);
  await deleteView('view_a', p);
  assert.equal(await getView('view_a', p), null);
  assert.deepEqual((await listViews(p)).map((x) => x.id), ['view_b']);
});
