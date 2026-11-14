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

function liveMission(id: string, status: string, version = 3, over: Record<string, unknown> = {}) {
  return rec(id, version, {
    id, title: id, status, rev: 4, history: [],
    binding: { sessionId: 's1', node: 'gw-x', kind: 'worker' },
    control: { nudgeCount: 1, backoffStep: 0, spawnInFlight: { node: 'gw-x', requestId: 'r', at: 1 }, lastSpawnRequest: 'req-1' },
    ...over,
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
  // The local mission was at rev 9: the bundle's rev 3 is REBASED (import = rev 10), then the
  // neutralization is rev 11 — an import never lowers rev (durable history keys on it).
  assert.equal(f.rev, 11);
  assert.equal(f.history.length, 2);
  assert.equal(f.history[0].rev, 10);
  assert.equal(f.history[0].actor.label, 'bundle import (replace)');
  assert.deepEqual(f.history[0].changes.status, { from: 'done', to: 'active' });
  assert.deepEqual(f.history[1].changes.status, { from: 'active', to: 'paused' });
  assert.equal(f.history[1].changes.binding.to, null);
  assert.equal(f.history[1].actor.label, 'bundle import (neutralized)');
});

test('missions under replace: an IDENTICAL live mission is left alone (not paused/unbound), and re-apply is a no-op', async () => {
  const b = makeNode();
  const live = liveMission('mission_run', 'active', 4);
  await ownedDataset(b, 'missions', [live], { scope: 'cluster' });
  const id = await craftBundle(b.store, [{ descriptor: descriptor('missions', { scope: 'cluster' }), records: [live] }]);
  const r = await b.svc.apply(id, { confirm: true, policy: 'replace' });
  assert.equal(r.sections[0].applied!.neutralized, 0);
  assert.equal(r.sections[0].counts.skipIdentical, 1);
  const m = (await all(b, 'missions')).get('mission_run')!;
  assert.equal((m.fields as any).status, 'active', 'a running mission keeps running');
  assert.deepEqual((m.fields as any).binding, (live.fields as any).binding);
  assert.equal(m.version, live.version);

  // A DIFFERENT older copy is neutralized once; applying it again is a no-op.
  const older = liveMission('mission_run', 'active', 2, { title: 'older title' });
  const id2 = await craftBundle(b.store, [{ descriptor: descriptor('missions', { scope: 'cluster' }), records: [older] }]);
  const r1 = await b.svc.apply(id2, { confirm: true, policy: 'replace' });
  assert.equal(r1.sections[0].applied!.update, 1);
  assert.equal(r1.sections[0].applied!.neutralized, 1);
  const v1 = (await all(b, 'missions')).get('mission_run')!;
  assert.equal((v1.fields as any).status, 'paused');
  const r2 = await b.svc.apply(id2, { confirm: true, policy: 'replace' });
  assert.equal(r2.sections[0].applied!.update, 0, 're-apply writes nothing');
  assert.equal(r2.sections[0].counts.skipIdentical, 1);
  assert.equal((await all(b, 'missions')).get('mission_run')!.version, v1.version);
});

test('missions under merge: an identical record is skipIdentical, not skipOlder', async () => {
  const b = makeNode();
  const live = liveMission('mission_m', 'active', 4);
  await ownedDataset(b, 'missions', [live], { scope: 'cluster' });
  const id = await craftBundle(b.store, [{ descriptor: descriptor('missions', { scope: 'cluster' }), records: [live] }]);
  const p = await b.svc.plan(id);
  assert.equal(p.sections[0].counts.skipIdentical, 1);
  assert.equal(p.sections[0].counts.skipOlder, 0);
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

// ─── another online node ALREADY owns it (not just "is the recorded origin online") ─────

const owns = (node: string, id: string, extra: Record<string, unknown> = {}) =>
  [{ id, syncMode: 'full' as const, ownerNode: node, backend: 'cache' as const, scope: 'fleet' as const, ...extra }];

test('takeover: refused OWNER_ONLINE when another online node already took the dataset over', async () => {
  const b = makeNode();
  await replicaDataset(b, 'backlog', ORIGIN, [rec('a', 1, {})]);
  b.roster.online('gw-taker');                        // ORIGIN is gone, but gw-taker owns it now
  b.roster.manifests['gw-taker'] = owns('gw-taker', 'backlog', { supersedes: ORIGIN.machineId });
  const e = await rejectsCode(b.svc.takeover('backlog'), 'OWNER_ONLINE');
  assert.match(e.message, /host-gw-taker/);
  await rejectsCode(b.svc.takeover('backlog', { force: true }), 'OWNER_ONLINE');
  assert.ok(b.datasets.get('backlog')!.origin, 'still a replica');
  // An unreadable manifest is not "nobody": ROSTER_UNAVAILABLE unless force.
  b.roster.manifests['gw-taker'] = new Error('proxy timeout');
  await rejectsCode(b.svc.takeover('backlog'), 'ROSTER_UNAVAILABLE');
  const forced = await b.svc.takeover('backlog', { force: true });
  assert.equal(forced.forced, true);
});

test('takeover: a PARTIAL replica is refused NOT_SUPPORTED (it is a read-through cache, not a copy)', async () => {
  const b = makeNode();
  b.datasets.upsertReplica({ id: 'part', backend: 'cache', ownerNode: ORIGIN.machineId, syncMode: 'partial', config: { kind: 'cache' }, origin: ORIGIN });
  await rejectsCode(b.svc.takeover('part', { force: true }), 'NOT_SUPPORTED');
});

test('takeOwnership import: refused OWNER_ONLINE when another online node owns it', async () => {
  const b = makeNode();
  await replicaDataset(b, 'backlog', ORIGIN, []);
  b.roster.online('gw-taker');
  b.roster.manifests['gw-taker'] = owns('gw-taker', 'backlog');
  const id = await craftBundle(b.store, [{ descriptor: descriptor('backlog', { ownerNode: ORIGIN.machineId }), records: [rec('x', 1, {})] }]);
  const r = await b.svc.apply(id, { confirm: true, takeOwnership: true, force: true });
  assert.equal(r.sections[0].refused!.code, 'OWNER_ONLINE');
  assert.ok(b.datasets.get('backlog')!.origin);
});

test('import-create: refused when an online node already owns it; an offline owner gets a supersedes marker', async () => {
  const b = makeNode();
  b.roster.online('gw-taker');
  b.roster.manifests['gw-taker'] = owns('gw-taker', 'backlog');
  const id = await craftBundle(b.store, [{ descriptor: descriptor('backlog', { ownerNode: OTHER }), records: [rec('bl', 1, {})] }]);
  const refused = await b.svc.apply(id, { confirm: true });
  assert.equal(refused.sections[0].refused!.code, 'OWNER_ONLINE');
  assert.equal(b.datasets.get('backlog'), undefined);

  b.roster.manifests['gw-taker'] = [];
  const ok = await b.svc.apply(id, { confirm: true });
  assert.equal(ok.sections[0].refused, undefined);
  const d = b.datasets.get('backlog')!;
  assert.equal(d.supersedes?.machineId, OTHER, 'the returning owner will find a marker naming it and demote');
  assert.ok(d.supersedes?.at);
});

test('import-create on the rebuilt origin: warns that replicas may be newer; refused if a taker owns it now', async () => {
  const b = makeNode();
  b.roster.online('gw-rep');
  const id = await craftBundle(b.store, [{ descriptor: descriptor('backlog', { ownerNode: SELF }), records: [rec('bl', 1, {})] }]);
  const p = await b.svc.plan(id);
  assert.ok(p.sections[0].warnings.some((w) => w.startsWith('rebuilt-origin:')));
  b.roster.manifests['gw-rep'] = owns('gw-rep', 'backlog', { supersedes: SELF });
  const r = await b.svc.plan(id);
  assert.equal(r.sections[0].refused!.code, 'OWNER_ONLINE');
});

test('cluster-scoped: an owner in ANOTHER cluster is that cluster\'s copy, not a competing owner', async () => {
  const b = makeNode();
  b.roster.online('gw-far');
  b.roster.manifests['gw-far'] = [{ id: 'missions', syncMode: 'full', ownerNode: 'gw-far', backend: 'cache', scope: 'cluster' }];
  (b.roster as any).sameCluster = async () => false;
  const id = await craftBundle(b.store, [{ descriptor: descriptor('missions', { ownerNode: OTHER, scope: 'cluster' }), records: [] }]);
  const r = await b.svc.plan(id);
  assert.equal(r.sections[0].refused, undefined);
});

test('a datasets import on a node with the data service OFF warns that nothing will serve it yet', async () => {
  const b = makeNode();
  (b.data as any).enabledOverride = false;
  const id = await craftBundle(b.store, [{ descriptor: descriptor('notes', { syncMode: 'none' }), records: [rec('n', 1, {})] }]);
  const r = await b.svc.plan(id);
  assert.ok(r.warnings.some((w) => w.startsWith('data-service-disabled:')));
  (b.data as any).enabledOverride = true;
  assert.ok(!(await b.svc.plan(id)).warnings.some((w) => w.startsWith('data-service-disabled:')));
});

test('a backend write error mid-apply refuses the section IMPORT_FAILED with partial counts; caches still invalidated', async () => {
  const b = makeNode();
  await ownedDataset(b, 'backlog', []);
  const realPut = b.backend.put.bind(b.backend);
  let n = 0;
  (b.backend as any).put = async (ds: string, r: any) => { if (ds === 'backlog' && ++n === 2) throw new Error('MDB_MAP_FULL'); return realPut(ds, r); };
  const id = await craftBundle(b.store, [{ descriptor: descriptor('backlog'), records: [rec('a', 1, {}), rec('b', 1, {}), rec('c', 1, {})] }]);
  const r = await b.svc.apply(id, { confirm: true });
  const s = r.sections[0];
  assert.equal(s.refused!.code, 'IMPORT_FAILED');
  assert.match(s.refused!.reason, /MDB_MAP_FULL/);
  assert.equal(s.applied!.add, 1, 'what WAS written is reported');
  assert.deepEqual(b.invalidated, [['backlog']], 'the part-written dataset\'s caches are dropped');
});
