import { test } from 'node:test';
import assert from 'node:assert';
import { handleCreate, handlePatch } from '../routes/core/mission.routes';
import type { Mission } from '../mission/mission-model';

function memPort() {
  const db = new Map<string, Mission>();
  return { db, get: async (id: string) => db.get(id) ?? null, list: async () => [...db.values()], put: async (m: Mission) => { db.set(m.id, m); } };
}
const ccrActor = { kind: 'ccr' as const, id: 'cse_1', channel: 'mcp' as const, at: 1 };

test('create stamps the provided actor as createdBy', async () => {
  const port = memPort();
  const r = await handleCreate({ title: 't', objective: 'o' }, 'gw4-n', port as any, ccrActor);
  assert.equal((r.data as Mission).createdBy.id, 'cse_1');
  assert.equal((r.data as Mission).lastUpdatedBy.id, 'cse_1');
});

test('_actor in body never leaks into mission fields', async () => {
  const port = memPort();
  const r = await handleCreate({ title: 't', objective: 'o', _actor: { channel: 'mcp', toolUseId: 'x' } } as any, 'gw4-n', port as any, ccrActor);
  assert.ok(!('_actor' in (r.data as any)));
});

test('patch sets lastUpdatedBy and appends an attributed adjustment', async () => {
  const port = memPort();
  await handleCreate({ title: 't', objective: 'o' }, 'gw4-n', port as any, ccrActor);
  const id = (await port.list())[0].id;
  const userActor = { kind: 'user' as const, channel: 'user' as const, node: 'gw4-n', at: 2 };
  const r = await handlePatch(id, { title: 't2' }, port as any, userActor);
  const m = r.data as Mission;
  assert.equal(m.lastUpdatedBy.kind, 'user');
  assert.equal(m.adjustments[m.adjustments.length - 1].actor.kind, 'user');
});
