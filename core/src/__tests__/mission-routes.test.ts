import { test } from 'node:test';
import assert from 'node:assert';
import { Mission } from '../mission/mission-model';
import { MissionDataPort } from '../mission/mission-store';
import { handleCreate, handleList, handleGet, handlePatch } from '../routes/core/mission.routes';

function fakePort(): MissionDataPort {
  const map = new Map<string, Mission>();
  return {
    isEnabled: () => true,
    get: async (id) => map.get(id) ?? null,
    list: async () => [...map.values()],
    put: async (m) => { map.set(m.id, JSON.parse(JSON.stringify(m))); },
    del: async (id) => { map.delete(id); },
  };
}

test('create -> list -> get -> patch round-trip', async () => {
  const port = fakePort();
  const created = await handleCreate({ title: 'Build X', objective: 'Make X work', projects: ['lm-assist'] }, 'gw4-1', port);
  assert.strictEqual(created.success, true);
  const id = (created.data as Mission).id;
  assert.match(id, /^mission_/);

  const listed = await handleList(port);
  assert.strictEqual((listed.data as Mission[]).length, 1);

  const got = await handleGet(id, port);
  assert.strictEqual((got.data as Mission).objective, 'Make X work');

  const patched = await handlePatch(id, { objective: 'Make X great', status: 'paused' }, port);
  assert.strictEqual((patched.data as Mission).objective, 'Make X great');
  assert.strictEqual((patched.data as Mission).status, 'paused');
});

test('get unknown id fails', async () => {
  const r = await handleGet('mission_nope', fakePort());
  assert.strictEqual(r.success, false);
});

test('mission_update binds a spawned executor (binding) — required for the supervisor to monitor it', async () => {
  const port = fakePort();
  const created = await handleCreate({ title: 'Bind me', objective: 'do work' }, 'gw4-1', port);
  const id = (created.data as Mission).id;
  // The controller spawns a cloud worker then binds it. Without binding support the mission stays
  // unbound → the supervisor can't monitor it → its pendingQuestion never triggers fast engagement.
  const bound = await handlePatch(id, { binding: { sessionId: 'session_worker123', kind: 'worker' } }, port);
  const b = (bound.data as Mission).binding;
  assert.ok(b, 'binding should be set');
  assert.strictEqual(b!.sessionId, 'session_worker123');
  assert.strictEqual(b!.kind, 'worker');
  assert.ok(typeof b!.boundAt === 'number');
  // binding:null unbinds.
  const unbound = await handlePatch(id, { binding: null }, port);
  assert.strictEqual((unbound.data as Mission).binding, null);
});

test('create requires title and objective', async () => {
  const r = await handleCreate({ title: '' }, 'gw4-1', fakePort());
  assert.strictEqual(r.success, false);
});
