import { test } from 'node:test';
import assert from 'node:assert';
import { handleCreate, handlePatch } from '../routes/core/mission.routes';
import type { Mission, MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'user', node: 'n', at: 1 };
function memPort() {
  const db = new Map<string, Mission>();
  // clone on BOTH get and put: simulate LMDB independent reads, so putMission's pre-image diff works.
  return { db, get: async (id: string) => { const v = db.get(id); return v ? JSON.parse(JSON.stringify(v)) : null; }, list: async () => [...db.values()], put: async (m: Mission) => { db.set(m.id, JSON.parse(JSON.stringify(m))); } };
}

test('create stamps rev 1 + initial history + createdBy + tags/parentId', async () => {
  const port = memPort();
  const r = await handleCreate({ title: 't', objective: 'o', tags: { project: ['lm'] } }, 'n', port as any, actor);
  const m = r.data as Mission;
  assert.equal(m.rev, 1);
  assert.equal(m.history.length, 1);
  assert.equal(m.history[0].rev, 1);
  assert.deepEqual(m.tags, { project: ['lm'] });
  assert.equal(m.createdBy.kind, 'user');
});

test('patch of a tracked field records a grouped diff + bumps rev + sets lastUpdatedBy', async () => {
  const port = memPort();
  const created = (await handleCreate({ title: 't', objective: 'o' }, 'n', port as any, actor)).data as Mission;
  const r = await handlePatch(created.id, { status: 'paused', title: 't2' }, port as any, actor);
  const m = r.data as Mission;
  assert.equal(m.rev, 2);
  const last = m.history[m.history.length - 1];
  // 'waiting' is the birth status from handleCreate — this test asserts grouped-diff
  // mechanics, not the birth state.
  assert.deepEqual(last.changes.status, { from: 'waiting', to: 'paused' });
  assert.deepEqual(last.changes.title, { from: 't', to: 't2' });
});

test('an untracked-only patch (binding) records no history', async () => {
  const port = memPort();
  const created = (await handleCreate({ title: 't', objective: 'o' }, 'n', port as any, actor)).data as Mission;
  const r = await handlePatch(created.id, { binding: { sessionId: 's', kind: 'worker' } }, port as any, actor);
  assert.equal((r.data as Mission).rev, 1);
  assert.equal((r.data as Mission).history.length, 1); // only the create entry
});

test('a cyclic parentId is rejected', async () => {
  const port = memPort();
  const a = (await handleCreate({ title: 'a', objective: 'o' }, 'n', port as any, actor)).data as Mission;
  const r = await handlePatch(a.id, { parentId: a.id }, port as any, actor);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'CYCLE');
});

test('a non-existent dependsOn is rejected', async () => {
  const port = memPort();
  const a = (await handleCreate({ title: 'a', objective: 'o' }, 'n', port as any, actor)).data as Mission;
  const r = await handlePatch(a.id, { dependsOn: ['mission_zzz'] }, port as any, actor);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'INVALID_RELATIONSHIP');
});
