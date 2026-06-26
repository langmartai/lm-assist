import { test } from 'node:test';
import assert from 'node:assert';
import { handleCreate, handleTag } from '../routes/core/mission.routes';
import type { Mission, MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
function memPort() {
  const db = new Map<string, Mission>();
  // clone on BOTH get and put: simulate LMDB independent reads, so putMission's pre-image diff works.
  return { db, get: async (id: string) => { const v = db.get(id); return v ? JSON.parse(JSON.stringify(v)) : null; }, list: async () => [...db.values()], put: async (m: Mission) => { db.set(m.id, JSON.parse(JSON.stringify(m))); } };
}

test('mission_tag add/remove/set merges and flows through history', async () => {
  const port = memPort();
  const m = (await handleCreate({ title: 't', objective: 'o', tags: { component: ['controller'] } }, 'n', port as any, actor)).data as Mission;
  const r1 = await handleTag(m.id, { add: { component: ['web'] } }, port as any, actor);
  assert.deepEqual((r1.data as Mission).tags.component, ['controller', 'web']);
  assert.equal((r1.data as Mission).rev, 2);
  const last = (r1.data as Mission).history.at(-1)!;
  assert.deepEqual(last.changes['tags.component'], { from: ['controller'], to: ['controller', 'web'] });
  const r2 = await handleTag(m.id, { remove: { component: ['controller'] } }, port as any, actor);
  assert.deepEqual((r2.data as Mission).tags.component, ['web']);
});

test('mission_tag on a missing mission returns NOT_FOUND', async () => {
  const port = memPort();
  const r = await handleTag('mission_zzz', { add: { x: ['y'] } }, port as any, actor);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'NOT_FOUND');
});
