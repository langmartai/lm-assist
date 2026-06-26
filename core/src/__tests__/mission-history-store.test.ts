import { test } from 'node:test';
import assert from 'node:assert';
import { appendMissionHistory, listMissionHistory, type MissionHistoryRecord, type MissionHistoryPort } from '../mission/mission-store';
import type { MissionChange, MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
function memHistoryPort(): MissionHistoryPort & { db: Map<string, MissionHistoryRecord> } {
  const db = new Map<string, MissionHistoryRecord>();
  return {
    db,
    isEnabled: () => true,
    put: async (rec) => { db.set(rec.id, rec); },
    query: async (missionId, opts) => {
      let rows = [...db.values()].filter((r) => r.missionId === missionId);
      if (typeof opts.beforeRev === 'number') rows = rows.filter((r) => r.rev < opts.beforeRev!);
      rows.sort((a, b) => b.rev - a.rev);
      return rows.slice(0, opts.limit ?? 50);
    },
  };
}
const change = (rev: number): MissionChange => ({ rev, at: rev, actor, changes: { status: { from: 'a', to: 'b' } } });

test('appendMissionHistory writes ${id}:${rev} and is idempotent on rev', async () => {
  const p = memHistoryPort();
  await appendMissionHistory('mission_a', change(1), p);
  await appendMissionHistory('mission_a', change(1), p);
  assert.equal(p.db.size, 1);
  assert.ok(p.db.has('mission_a:1'));
});

test('listMissionHistory is newest-first and honours limit + beforeRev', async () => {
  const p = memHistoryPort();
  for (const r of [1, 2, 3, 4]) await appendMissionHistory('mission_a', change(r), p);
  const top2 = await listMissionHistory('mission_a', { limit: 2 }, p);
  assert.deepEqual(top2.map((r) => r.rev), [4, 3]);
  const older = await listMissionHistory('mission_a', { beforeRev: 3 }, p);
  assert.deepEqual(older.map((r) => r.rev), [2, 1]);
});
