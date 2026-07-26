import { test } from 'node:test';
import assert from 'node:assert';
import { putMission, getMission, type MissionDataPort, type MissionHistoryPort, type MissionHistoryRecord } from '../mission/mission-store';
import { newMission, type Mission, type MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
function memPort(): MissionDataPort & { db: Map<string, Mission> } {
  const db = new Map<string, Mission>();
  // clone on BOTH get and put: simulate LMDB independent reads, so putMission's pre-image diff works.
  return { db, isEnabled: () => true, get: async (id) => { const v = db.get(id); return v ? JSON.parse(JSON.stringify(v)) : null; }, list: async () => [...db.values()], put: async (m) => { db.set(m.id, JSON.parse(JSON.stringify(m))); }, del: async (id) => { db.delete(id); } };
}
function memHistoryPort(fail = false): MissionHistoryPort & { db: Map<string, MissionHistoryRecord> } {
  const db = new Map<string, MissionHistoryRecord>();
  return { db, isEnabled: () => true, put: async (rec) => { if (fail) throw new Error('boom'); db.set(rec.id, rec); }, query: async () => [...db.values()] };
}
const mk = (id: string, over: Partial<Mission> = {}): Mission => ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: actor }, 1, () => id), id, ...over });

test('a tracked change bumps rev, appends inline history, spills durably', async () => {
  const port = memPort(); const hp = memHistoryPort();
  const m = mk('mission_a', { rev: 1, history: [] });
  await port.put(m);
  m.status = 'done';
  await putMission(m, port, { actor, historyPort: hp });
  const saved = await getMission('mission_a', port);
  assert.equal(saved!.rev, 2);
  assert.equal(saved!.history.length, 1);
  // 'waiting' is newMission's birth status (mk builds via newMission) — this test is about
  // rev/history mechanics, not the birth state itself.
  assert.deepEqual(saved!.history[0].changes.status, { from: 'waiting', to: 'done' });
  assert.equal(saved!.lastUpdatedBy.channel, 'mcp');
  assert.ok(hp.db.has('mission_a:2'));
});

test('an untracked-only change records no history and no rev bump', async () => {
  const port = memPort(); const hp = memHistoryPort();
  const m = mk('mission_b', { rev: 3, history: [] });
  await port.put(m);
  m.progress = { percent: 10, summary: 's', updatedAt: 9 };
  await putMission(m, port, { actor, historyPort: hp });
  const saved = await getMission('mission_b', port);
  assert.equal(saved!.rev, 3);
  assert.equal(saved!.history.length, 0);
  assert.equal(hp.db.size, 0);
});

test('inline slice never exceeds inlineCap', async () => {
  const port = memPort(); const hp = memHistoryPort();
  const m = mk('mission_c', { rev: 0, history: [] });
  await port.put(m);
  for (const s of ['active', 'paused', 'active', 'done'] as const) {
    const cur = (await getMission('mission_c', port))!;
    cur.status = s;
    await putMission(cur, port, { actor, historyPort: hp, inlineCap: 2 });
  }
  const saved = await getMission('mission_c', port);
  assert.equal(saved!.history.length, 2);
});

test('a durable-spill failure does not throw out of putMission', async () => {
  const port = memPort(); const hp = memHistoryPort(true);
  const m = mk('mission_d', { rev: 1, history: [] });
  await port.put(m);
  m.status = 'done';
  await putMission(m, port, { actor, historyPort: hp }); // must not throw
  assert.equal((await getMission('mission_d', port))!.rev, 2);
});
