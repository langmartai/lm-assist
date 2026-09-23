// core/src/__tests__/data-bundle/svc-ownership.test.ts
// The spec's import OWNERSHIP table, row by row, the guarded TAKEOVER (online / offline /
// roster unavailable ± force / not a replica), takeOwnership on apply, the cross-cluster and
// foreign-owner warnings, and mission neutralization (merge and replace).
import { makeNode, ownedDataset, replicaDataset, rec, all, rejectsCode, craftBundle, descriptor, SELF } from './svc-harness';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeMission } from '../../data/bundle/sections/datasets';

const ORIGIN = { machineId: 'gw-origin', hostname: 'origin-host', os: 'linux' };
const OTHER = 'gw-other';

// ─── ownership rows ─────────────────────────────────────────────────────────

test('row 1: local owns it → import per policy; foreign bundle owner warns foreign-owner', async () => {
  const b = makeNode();
  await ownedDataset(b, 'backlog', [rec('x', 1, { v: 'local' })]);
  const id = await craftBundle(b.store, [{ descriptor: descriptor('backlog', { ownerNode: OTHER }), records: [rec('x', 2, { v: 'bundle' }), rec('y', 1, {})] }]);
  const r = await b.svc.apply(id, { confirm: true });
  const s = r.sections[0];
  assert.equal((s as any).action, 'import');
  assert.equal(s.refused, undefined);
  assert.ok(s.warnings.some((w) => w.startsWith('foreign-owner:')), s.warnings.join('|'));
  assert.deepEqual([s.applied!.add, s.applied!.update], [1, 1]);
  assert.equal((await all(b, 'backlog')).get('x')!.fields.v, 'bundle');
  assert.equal(b.datasets.get('backlog')!.ownerNode, SELF, 'still owned here');

  const own = await craftBundle(b.store, [{ descriptor: descriptor('backlog'), records: [] }]);
  const r2 = await b.svc.plan(own);
  assert.ok(!r2.sections[0].warnings.some((w) => w.startsWith('foreign-owner:')), 'own bundle → no foreign-owner warning');
});

test('row 2: local holds a replica → REPLICA_READ_ONLY pointing at the origin; nothing written', async () => {
  const b = makeNode();
  await replicaDataset(b, 'mission-workflows', ORIGIN, [rec('wf', 1, { v: 'replica' })]);
  const id = await craftBundle(b.store, [{ descriptor: descriptor('mission-workflows', { ownerNode: ORIGIN.machineId }), records: [rec('wf', 9, { v: 'bundle' })] }]);
  for (const run of [() => b.svc.plan(id), () => b.svc.apply(id, { confirm: true })]) {
    const r = await run();
    const s = r.sections[0];
    assert.equal(s.refused!.code, 'REPLICA_READ_ONLY');
    assert.match(s.refused!.reason, /origin-host/);
    assert.match(s.refused!.reason, /takeOwnership/);
    assert.equal(r.refused, 1);
  }
  assert.equal((await all(b, 'mission-workflows')).get('wf')!.fields.v, 'replica');
  assert.ok(b.datasets.get('mission-workflows')!.origin);
});

test('row 2 + takeOwnership: origin offline → takeover then import; origin online → ORIGIN_ONLINE; roster down → ROSTER_UNAVAILABLE unless force', async () => {
  const mk = async () => {
    const b = makeNode();
    await replicaDataset(b, 'mission-workflows', ORIGIN, [rec('wf', 1, { v: 'replica' })]);
    const id = await craftBundle(b.store, [{
      descriptor: descriptor('mission-workflows', { ownerNode: ORIGIN.machineId, visibility: 'synced', acl: [{ principal: 'owner', actions: ['read'] }] }),
      records: [rec('wf', 9, { v: 'bundle' })],
    }]);
    return { b, id };
  };

  { // online → refused
    const { b, id } = await mk();
    b.roster.online(ORIGIN.machineId);
    const r = await b.svc.apply(id, { confirm: true, takeOwnership: true });
    assert.equal(r.sections[0].refused!.code, 'ORIGIN_ONLINE');
    assert.ok(b.datasets.get('mission-workflows')!.origin, 'still a replica');
  }
  { // roster unavailable → refused unless force
    const { b, id } = await mk();
    b.roster.unavailable = 'hub down';
    const r = await b.svc.apply(id, { confirm: true, takeOwnership: true });
    assert.equal(r.sections[0].refused!.code, 'ROSTER_UNAVAILABLE');
    const forced = await b.svc.apply(id, { confirm: true, takeOwnership: true, force: true });
    assert.equal(forced.sections[0].refused, undefined);
    assert.equal(b.datasets.get('mission-workflows')!.origin, undefined);
  }
  { // offline → plan says so and writes nothing; apply promotes, imports, notifies
    const { b, id } = await mk();
    b.roster.online('gw-unrelated');
    const plan = await b.svc.plan(id, { takeOwnership: true });
    assert.equal((plan.sections[0] as any).action, 'takeover');
    assert.ok(plan.sections[0].warnings.some((w) => /would be promoted/.test(w)));
    assert.equal(plan.sections[0].counts.update, 1);
    assert.ok(b.datasets.get('mission-workflows')!.origin, 'plan does not take over');

    const r = await b.svc.apply(id, { confirm: true, takeOwnership: true });
    assert.equal(r.sections[0].refused, undefined, JSON.stringify(r.sections[0]));
    assert.equal(r.sections[0].applied!.update, 1);
    const d = b.datasets.get('mission-workflows')!;
    assert.equal(d.origin, undefined);
    assert.equal(d.ownerNode, SELF);
    assert.equal(d.supersedes!.machineId, ORIGIN.machineId);
    assert.equal(d.visibility, 'synced', "the bundle owned it → the bundle's visibility/ACL");
    assert.deepEqual(d.acl, [{ principal: 'owner', actions: ['read'] }]);
    assert.equal((await all(b, 'mission-workflows')).get('wf')!.fields.v, 'bundle');
    assert.deepEqual(b.notes.map((n) => n.id), ['mission-workflows'], 'takeover fired a change-notify');
    assert.ok(b.invalidated.flat().includes('mission-workflows'));
  }
});

test('row 3: absent locally and not synced → created from the descriptor, then imported', async () => {
  const b = makeNode();
  b.roster.unavailable = 'hub down'; // irrelevant: a local-only dataset has no owner to ask about
  const id = await craftBundle(b.store, [{ descriptor: descriptor('notes', { ownerNode: OTHER, syncMode: 'none', visibility: 'local-only' }), records: [rec('n', 3, { t: 1 })] }]);
  const r = await b.svc.apply(id, { confirm: true });
  assert.equal((r.sections[0] as any).action, 'create');
  assert.equal(r.sections[0].applied!.add, 1);
  assert.equal(b.datasets.get('notes')!.syncMode, 'none');
  assert.equal(b.roster.calls, 0, 'no roster read for an unsynced dataset');
});

test('row 4: absent, synced, owner offline (or this node) → owned dataset created', async () => {
  const b = makeNode();
  b.roster.online('gw-unrelated');
  const id = await craftBundle(b.store, [
    { descriptor: descriptor('backlog', { ownerNode: OTHER }), records: [rec('bl_1', 4, {})] },
    { descriptor: descriptor('mine', { ownerNode: SELF }), records: [rec('m', 1, {})] },
  ]);
  const r = await b.svc.apply(id, { confirm: true });
  const by = new Map(r.sections.map((s) => [s.id, s]));
  assert.equal((by.get('backlog') as any).action, 'create');
  assert.ok(by.get('backlog')!.warnings.some((w) => w.startsWith('owner-offline:')));
  assert.equal(b.datasets.get('backlog')!.ownerNode, SELF);
  assert.equal(b.datasets.get('backlog')!.origin, undefined);
  assert.equal((await all(b, 'backlog')).get('bl_1')!.version, 4);
  assert.ok(!by.get('mine')!.warnings.some((w) => w.startsWith('owner-offline:')));
  assert.equal(b.datasets.get('mine')!.ownerNode, SELF);
});

test('row 5: absent, synced, owner ONLINE elsewhere → OWNER_ONLINE (no second owner); roster down → ROSTER_UNAVAILABLE unless force', async () => {
  const b = makeNode();
  b.roster.online(OTHER);
  const id = await craftBundle(b.store, [{ descriptor: descriptor('backlog', { ownerNode: OTHER }), records: [rec('bl_1', 4, {})] }]);
  for (const r of [await b.svc.plan(id), await b.svc.apply(id, { confirm: true, force: true })]) {
    assert.equal(r.sections[0].refused!.code, 'OWNER_ONLINE', 'force never overrides an online owner');
    assert.match(r.sections[0].refused!.reason, /host-gw-other/);
  }
  assert.equal(b.datasets.get('backlog'), undefined);

  b.roster.unavailable = 'hub down';
  const r = await b.svc.apply(id, { confirm: true });
  assert.equal(r.sections[0].refused!.code, 'ROSTER_UNAVAILABLE');
  assert.equal(b.datasets.get('backlog'), undefined);
  const forced = await b.svc.apply(id, { confirm: true, force: true });
  assert.equal(forced.sections[0].refused, undefined);
  assert.equal(b.datasets.get('backlog')!.ownerNode, SELF);
});

test('a replica line in the bundle: its owner is the origin it named (replicaOf), not the exporter', async () => {
  const b = makeNode();
  b.roster.online(ORIGIN.machineId);
  const id = await craftBundle(b.store, [{
    descriptor: descriptor('mission-workflows', { ownerNode: ORIGIN.machineId, origin: ORIGIN, visibility: 'local-only' }),
    replicaOf: ORIGIN, records: [rec('wf', 1, {})],
  }]);
  const r = await b.svc.plan(id);
  assert.equal(r.sections[0].refused!.code, 'OWNER_ONLINE');
});

test('cross-cluster warning for cluster-scoped datasets only', async () => {
  const b = makeNode({ cluster: 'beta' });
  const id = await craftBundle(b.store, [
    { descriptor: descriptor('missions', { scope: 'cluster' }), records: [] },
    { descriptor: descriptor('backlog', { scope: 'fleet' }), records: [] },
  ], { cluster: 'alpha' });
  const r = await b.svc.plan(id);
  const by = new Map(r.sections.map((s) => [s.id, s]));
  assert.ok(by.get('missions')!.warnings.some((w) => w.startsWith('cross-cluster:')));
  assert.ok(!by.get('backlog')!.warnings.some((w) => w.startsWith('cross-cluster:')));
});

// ─── takeover ───────────────────────────────────────────────────────────────

test('takeover: NOT_FOUND / NOT_A_REPLICA / ORIGIN_ONLINE / ROSTER_UNAVAILABLE / forced / clean', async () => {
  const b = makeNode();
  await ownedDataset(b, 'owned', []);
  await replicaDataset(b, 'backlog', ORIGIN, [rec('a', 1, {}), rec('b', 2, {}, { deleted: true })]);

  await rejectsCode(b.svc.takeover('nope'), 'NOT_FOUND');
  await rejectsCode(b.svc.takeover('owned'), 'NOT_A_REPLICA');

  b.roster.online(ORIGIN.machineId);
  const online = await rejectsCode(b.svc.takeover('backlog'), 'ORIGIN_ONLINE');
  assert.match(online.message, /origin-host/);
  await rejectsCode(b.svc.takeover('backlog', { force: true }), 'ORIGIN_ONLINE');

  b.roster.unavailable = 'hub down';
  const un = await rejectsCode(b.svc.takeover('backlog'), 'ROSTER_UNAVAILABLE');
  assert.match(un.message, /hub down/);
  assert.ok(b.datasets.get('backlog')!.origin, 'refusals change nothing');
  assert.equal(b.notes.length, 0);

  const forced = await b.svc.takeover('backlog', { force: true });
  assert.equal(forced.forced, true);
  assert.equal(forced.records, 2);
  assert.equal(forced.tombstones, 1);
  assert.deepEqual(forced.superseded, { machineId: ORIGIN.machineId, hostname: ORIGIN.hostname });
  assert.equal(forced.ownerNode, SELF);
  assert.match(forced.note, /demotes itself/);
  const d = b.datasets.get('backlog')!;
  assert.equal(d.origin, undefined);
  assert.equal(d.visibility, 'cross-node-readable');
  assert.equal(d.supersedes!.hostname, 'origin-host');
  assert.deepEqual(b.notes, [{ id: 'backlog', ids: [] }]);
  await rejectsCode(b.svc.takeover('backlog'), 'NOT_A_REPLICA');

  const c = makeNode();
  await replicaDataset(c, 'backlog', ORIGIN, []);
  c.roster.online('gw-unrelated');
  const clean = await c.svc.takeover('backlog');
  assert.equal(clean.forced, false);
  assert.equal(c.datasets.get('backlog')!.origin, undefined);
});

// ─── missions ───────────────────────────────────────────────────────────────

function liveMission(id: string, status: string, version = 3) {
  return rec(id, version, {
    id, title: id, status, rev: 4, history: [],
    binding: { sessionId: 's1', node: 'gw-x', kind: 'worker' },
    control: { nudgeCount: 1, backoffStep: 0, spawnInFlight: { node: 'gw-x', requestId: 'r', at: 1 }, lastSpawnRequest: 'req-1' },
  });
}

test('missions: active/waiting/blocked land paused, unbound, no in-flight spawn; counted as neutralized', async () => {
  const b = makeNode();
  const id = await craftBundle(b.store, [{
    descriptor: descriptor('missions', { scope: 'cluster' }),
    records: [
      liveMission('mission_act', 'active'), liveMission('mission_wait', 'waiting'), liveMission('mission_blk', 'blocked'),
      liveMission('mission_done', 'done'),
      rec('__controller__', 1, { node: 'n', sessionId: 's', tmux: 't', startedAt: 1 }),
    ],
  }]);
  const plan = await b.svc.plan(id);
  assert.equal(plan.sections[0].counts.neutralized, 3);
  assert.deepEqual(plan.sections[0].samples.neutralized!.sort(), ['mission_act', 'mission_blk', 'mission_wait']);
  assert.equal(plan.sections[0].counts.skipped, 1, 'the reserved controller record is never imported');

  const r = await b.svc.apply(id, { confirm: true });
  assert.equal(r.sections[0].applied!.neutralized, 3);
  assert.equal(r.sections[0].counts.neutralized, 3);
  const recs = await all(b, 'missions');
  assert.equal(recs.has('__controller__'), false);
  for (const m of ['mission_act', 'mission_wait', 'mission_blk']) {
    const f = recs.get(m)!.fields as any;
    assert.equal(f.status, 'paused', m);
    assert.equal(f.binding, null, m);
    assert.equal(f.control.spawnInFlight, undefined, m);
    assert.equal(f.control.lastSpawnRequest, undefined, m);
    assert.equal(f.control.nudgeCount, 1, 'the rest of control is kept');
    assert.equal(f.rev, 4, 'merge: no history entry');
    assert.equal(recs.get(m)!.version, 3, 'merge: version kept verbatim');
  }
  assert.equal((recs.get('mission_done')!.fields as any).status, 'done');
  assert.equal((recs.get('mission_done')!.fields as any).binding.sessionId, 's1', 'a finished mission is untouched');

  // Re-import: nothing written, nothing newly neutralized.
  const again = await b.svc.apply(id, { confirm: true });
  assert.equal(again.sections[0].applied!.neutralized, 0);
});

test('missions under replace: the neutralization is recorded in the mission history as a new rev', async () => {
  const b = makeNode();
  await ownedDataset(b, 'missions', [rec('mission_act', 5, { id: 'mission_act', status: 'done', rev: 9, history: [] })], { scope: 'cluster' });
  const id = await craftBundle(b.store, [{ descriptor: descriptor('missions', { scope: 'cluster' }), records: [liveMission('mission_act', 'active', 3)] }]);
  const r = await b.svc.apply(id, { confirm: true, policy: 'replace' });
  assert.equal(r.sections[0].applied!.neutralized, 1);
  const m = (await all(b, 'missions')).get('mission_act')!;
  assert.equal(m.version, 6, 'replace: max(5,3)+1');
  const f = m.fields as any;
  assert.equal(f.status, 'paused');
  assert.equal(f.rev, 5);
  assert.equal(f.history.length, 1);
  assert.deepEqual(f.history[0].changes.status, { from: 'active', to: 'paused' });
  assert.equal(f.history[0].changes.binding.to, null);
  assert.equal(f.history[0].actor.label, 'bundle import (neutralized)');
});

test('neutralizeMission is a no-op for tombstones, finished missions and non-mission shapes', () => {
  const o = { recordHistory: false, nowMs: 1, node: 'n' };
  assert.equal(neutralizeMission(rec('a', 1, {}, { deleted: true }), o), null);
  assert.equal(neutralizeMission(rec('a', 1, { status: 'paused' }), o), null);
  assert.equal(neutralizeMission(rec('a', 1, { status: 'failed' }), o), null);
  assert.equal(neutralizeMission(rec('a', 1, { title: 'no status' }), o), null);
  const n = neutralizeMission(rec('a', 1, { status: 'waiting' }), o)!;
  assert.equal(n.fields.status, 'paused');
  assert.equal(n.fields.binding, null);
  assert.equal('control' in n.fields, false, 'no control object is invented');
});
