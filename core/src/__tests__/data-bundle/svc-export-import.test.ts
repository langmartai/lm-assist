// core/src/__tests__/data-bundle/svc-export-import.test.ts
// BundleService export → plan → apply: the faithful round trip into a fresh node (verbatim
// versions/timestamps, tombstones carried, origin cleared), export enumeration + exclusions,
// the policy matrix at the service level (plan counts == apply counts), the confirm gate,
// corrupt bundles, inventory shape and orphan reporting, section filters and config dispatch.
import { makeNode, ownedDataset, replicaDataset, rec, all, rejectsCode, SELF, LOCAL, tmp, craftBundle, descriptor } from './svc-harness';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { BundleStore } from '../../data/bundle/store';
import type { ConfigProvider } from '../../data/bundle/sections/types';
import { newSectionPlan, asApplied } from '../../data/bundle/sections/types';

const ORIGIN = { machineId: 'gw-origin', hostname: 'origin-host', os: 'linux' };

test('hermetic: the harness pointed HOME and the data dir at temp dirs', () => {
  assert.ok(process.env.HOME!.startsWith(require('os').tmpdir()));
  assert.ok(process.env.LM_ASSIST_DATA_DIR!.startsWith(require('os').tmpdir()));
});

async function sourceNode() {
  const a = makeNode();
  await ownedDataset(a, 'backlog', [
    rec('bl_1', 3, { title: 'one' }),
    rec('bl_2', 7, { title: 'two' }),
    rec('bl_gone', 9, {}, { deleted: true }),
  ]);
  await ownedDataset(a, 'missions', [
    rec('mission_a', 4, { title: 'A', status: 'done' }),
    rec('__controller__', 2, { node: 'n', sessionId: 's', tmux: 't', startedAt: 1 }),
    rec('__engagement__', 2, { lastEngagedAt: null }),
  ], { scope: 'cluster' });
  await ownedDataset(a, 'notes-local', [rec('n1', 1, { t: 'x' })], { syncMode: 'none', visibility: 'local-only' });
  await ownedDataset(a, 'node-clusters', [rec('gw', 1, { cluster: 'alpha' })]);
  await ownedDataset(a, 'mcp-bootstrap', [rec('b', 1, {})]);
  await ownedDataset(a, 'sysidx', [rec('s', 1, {})], { system: true });
  a.datasets.create({ id: 'log-x', backend: 'file', syncMode: 'none', config: { kind: 'file', path: '/nonexistent', format: 'log' } });
  await replicaDataset(a, 'mission-workflows', ORIGIN, [rec('onboard.analyze', 5, { body: 'wf' })]);
  return a;
}

test('export: enumerates the registry, excludes system/file/deny-list/replicas, drops mission runtime ids', async () => {
  const a = await sourceNode();
  const res = await a.svc.createExport({ note: 'nightly' });
  assert.match(res.bundleId, /^lmb-\d{8}-\d{6}-[0-9a-f]{6}$/);
  assert.equal(res.note, 'nightly');
  const ids = res.sections.map((s) => s.id).sort();
  assert.deepEqual(ids, ['backlog', 'missions', 'notes-local']);
  const reasons = new Map(res.excluded.map((e) => [e.id, e.reason]));
  assert.match(reasons.get('sysidx')!, /system/);
  assert.match(reasons.get('log-x')!, /file/);
  assert.match(reasons.get('node-clusters')!, /runtime/);
  assert.match(reasons.get('mcp-bootstrap')!, /runtime/);
  assert.match(reasons.get('mission-workflows')!, /replica of origin-host/);
  const backlog = res.sections.find((s) => s.id === 'backlog')!;
  assert.equal(backlog.count, 3);
  assert.equal(backlog.tombstones, 1);
  assert.equal(backlog.owned, true);
  const missions = res.sections.find((s) => s.id === 'missions')!;
  assert.equal(missions.count, 1, 'reserved __controller__/__engagement__ are not exported');
  assert.ok(missions.warnings.some((w) => /reserved: 2/.test(w)));
  assert.match(res.next, /data_import\{action:'fetch'/);
  // The result is compact: no section hash, no records.
  assert.equal((backlog as any).sha256, undefined);
  assert.ok(!JSON.stringify(res).includes('"fields"'));

  const withReplicas = await a.svc.createExport({ includeReplicas: true });
  const wf = withReplicas.sections.find((s) => s.id === 'mission-workflows')!;
  assert.equal(wf.owned, false);
  assert.deepEqual(wf.origin, ORIGIN);

  const named = await a.svc.createExport({ datasets: ['mission-workflows', 'nope'] });
  assert.deepEqual(named.sections.map((s) => s.id), ['mission-workflows'], 'naming a replica opts it in');
  assert.ok(named.warnings.some((w) => /nope/.test(w)));
});

test('round trip into a fresh node: verbatim versions/timestamps, tombstones carried, origin cleared', async () => {
  const a = await sourceNode();
  const exp = await a.svc.createExport({ includeReplicas: true });
  const b = makeNode({ store: a.store });

  const plan = await b.svc.plan(exp.bundleId);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.policy, 'merge');
  const pb = plan.sections.find((s) => s.id === 'backlog')!;
  assert.equal((pb as any).action, 'create');
  assert.equal(pb.counts.add, 3);
  assert.deepEqual(pb.samples.add, ['bl_1', 'bl_2', 'bl_gone']);
  assert.equal(b.datasets.get('backlog'), undefined, 'a plan writes nothing');

  const applied = await b.svc.apply(exp.bundleId, { confirm: true });
  assert.equal(applied.dryRun, false);
  assert.equal(applied.refused, 0, JSON.stringify(applied.sections.filter((s) => s.refused)));
  assert.deepEqual(applied.totals, plan.totals, 'the apply matches its plan');
  assert.equal(applied.applied!.add, 3 + 1 + 1 + 1);

  const src = await all(a, 'backlog');
  const dst = await all(b, 'backlog');
  assert.equal(dst.size, 3);
  for (const [id, r] of src) {
    const d = dst.get(id)!;
    assert.equal(d.version, r.version, id);
    assert.equal(d.createdAt, r.createdAt, id);
    // backlog is SYNCED: updatedAt is re-stamped to now so replicas' watermark pulls see it.
    assert.ok(d.updatedAt > r.updatedAt, `${id}: synced write stamped updatedAt=now`);
    assert.equal(d.deleted, r.deleted, id);
    assert.deepEqual(d.fields, r.fields, id);
  }
  assert.equal(dst.get('bl_gone')!.deleted, true, 'the tombstone travelled');
  const wf = (await all(b, 'mission-workflows')).get('onboard.analyze')!;
  assert.equal(wf.origin, undefined, 'imported records become locally owned');
  assert.equal(wf.version, 5);

  const desc = b.datasets.get('backlog')!;
  assert.equal(desc.origin, undefined);
  assert.equal(desc.ownerNode, SELF);
  assert.equal(desc.syncMode, 'full');
  assert.equal(desc.scope, 'fleet');
  const wfDesc = b.datasets.get('mission-workflows')!;
  assert.equal(wfDesc.origin, undefined, 'a replica in the bundle is created OWNED here (its owner is not online)');
  assert.equal(wfDesc.visibility, 'cross-node-readable', "a replica's local-only visibility is not carried over");
  assert.equal(b.datasets.get('notes-local')!.syncMode, 'none');
  const srcNotes = await all(a, 'notes-local');
  for (const [nid, r] of await all(b, 'notes-local')) assert.equal(r.updatedAt, srcNotes.get(nid)!.updatedAt, 'an unsynced dataset keeps updatedAt verbatim');
  assert.ok(!(await all(b, 'missions')).has('__controller__'));

  // Caches that shadow written datasets are dropped once, with the touched ids.
  assert.equal(b.invalidated.length, 1);
  assert.deepEqual(b.invalidated[0].sort(), ['backlog', 'mission-workflows', 'missions', 'notes-local']);

  // Idempotent: a second apply writes nothing.
  const again = await b.svc.apply(exp.bundleId, { confirm: true });
  assert.equal(again.applied!.add + again.applied!.update, 0);
  assert.equal(again.totals.skipIdentical, 6);
});

test('policy matrix at the service level: plan counts equal apply counts; replace bumps versions', async () => {
  for (const policy of ['merge', 'add-missing', 'replace'] as const) {
    const a = makeNode();
    await ownedDataset(a, 'ds', [
      rec('older', 5, { v: 'bundle' }),     // local has v3 → local older
      rec('newer', 2, { v: 'bundle' }),     // local has v7 → local newer
      rec('same', 4, { v: 'same' }),        // identical
      rec('fresh', 1, { v: 'bundle' }),     // absent locally
    ]);
    const exp = await a.svc.createExport();
    const b = makeNode({ store: a.store });
    await ownedDataset(b, 'ds', [rec('older', 3, { v: 'local' }), rec('newer', 7, { v: 'local' }), rec('same', 4, { v: 'same' }), rec('keep', 1, { v: 'local-only' })]);
    const plan = await b.svc.plan(exp.bundleId, { policy });
    const applied = await b.svc.apply(exp.bundleId, { policy, confirm: true });
    const p = plan.sections[0];
    const x = applied.sections[0];
    assert.deepEqual(x.counts, p.counts, `${policy}: apply matches plan`);
    const recs = await all(b, 'ds');
    assert.equal(recs.get('keep')!.fields.v, 'local-only', `${policy}: import never deletes`);
    assert.equal(recs.get('fresh')!.version, 1, `${policy}: absent → verbatim`);
    if (policy === 'merge') {
      assert.deepEqual([p.counts.add, p.counts.update, p.counts.skipOlder, p.counts.skipIdentical], [1, 1, 1, 1]);
      assert.equal(recs.get('older')!.version, 5);
      assert.equal(recs.get('newer')!.fields.v, 'local');
    } else if (policy === 'add-missing') {
      assert.deepEqual([p.counts.add, p.counts.update, p.counts.skipExists, p.counts.skipIdentical], [1, 0, 2, 1]);
      assert.equal(recs.get('older')!.fields.v, 'local');
    } else {
      assert.deepEqual([p.counts.add, p.counts.update, p.counts.skipIdentical], [1, 2, 1]);
      assert.equal(recs.get('older')!.version, 6, 'replace: max(3,5)+1');
      assert.equal(recs.get('newer')!.version, 8, 'replace: max(7,2)+1');
      assert.equal(recs.get('newer')!.fields.v, 'bundle');
    }
  }
});

test('confirm gate: apply without confirm:true refuses CONFIRM_REQUIRED and writes nothing', async () => {
  const a = await sourceNode();
  const exp = await a.svc.createExport();
  const b = makeNode({ store: a.store });
  await rejectsCode(b.svc.apply(exp.bundleId), 'CONFIRM_REQUIRED');
  await rejectsCode(b.svc.apply(exp.bundleId, { confirm: 'true' as any }), 'CONFIRM_REQUIRED');
  assert.equal(b.datasets.list().length, 0);
});

test('bad input: unknown policy / section, invalid bundle ref, corrupt bundle', async () => {
  const a = await sourceNode();
  const exp = await a.svc.createExport();
  await rejectsCode(a.svc.plan(exp.bundleId, { policy: 'overwrite' }), 'BAD_REQUEST');
  await rejectsCode(a.svc.plan(exp.bundleId, { sections: ['datasets', 'secrets'] }), 'BAD_REQUEST');
  await rejectsCode(a.svc.createExport({ sections: ['everything'] }), 'BAD_REQUEST');
  await rejectsCode(a.svc.plan('../../etc/passwd'), 'BUNDLE_ID_INVALID');
  await rejectsCode(a.svc.plan('lmb-20260101-000000-abcdef'), 'BUNDLE_NOT_FOUND');

  // Flip one byte inside the decompressed stream, re-gzip: the end hash catches it.
  const file = a.store.pathFor(exp.bundleId);
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').replace('"title":"one"', '"title":"onE"');
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(text, 'utf8')));
  const e = await rejectsCode(a.svc.plan(exp.bundleId), 'BUNDLE_CORRUPT');
  assert.match(e.message, /hash/);
  const b = makeNode({ store: a.store });
  await rejectsCode(b.svc.apply(exp.bundleId, { confirm: true }), 'BUNDLE_CORRUPT');
  assert.equal(b.datasets.list().length, 0, 'nothing is written from a corrupt bundle');
});

test('selection: sections and datasets filters on plan; config sections dispatch to their provider', async () => {
  const seen: Array<[string, unknown, string]> = [];
  const provider: ConfigProvider = {
    id: 'project-settings', title: 'Project settings',
    collect: async () => ({ data: { theme: 'dark' }, redactedKeys: ['apiKey'], warnings: ['w1'] }),
    plan: async (data, policy) => { seen.push(['plan', data, policy]); const p = newSectionPlan('config', 'project-settings'); p.counts.add = 1; return p; },
    apply: async (data, policy) => { seen.push(['apply', data, policy]); const p = asApplied(newSectionPlan('config', 'project-settings')); p.counts.add = 1; p.applied.add = 1; return p; },
  };
  const a = makeNode({ deps: { configProviders: () => [provider] } });
  await ownedDataset(a, 'ds1', [rec('r', 1, {})]);
  await ownedDataset(a, 'ds2', [rec('r', 1, {})]);
  const exp = await a.svc.createExport();
  const cfg = exp.sections.find((s) => s.kind === 'config')!;
  assert.deepEqual(cfg.redactedKeys, ['apiKey']);
  assert.deepEqual(cfg.warnings, ['w1']);

  const b = makeNode({ store: a.store, deps: { configProviders: () => [provider] } });
  const onlyDs2 = await b.svc.plan(exp.bundleId, { datasets: ['ds2'] });
  assert.deepEqual(onlyDs2.sections.map((s) => s.id), ['ds2', 'project-settings']);
  const onlyCfg = await b.svc.plan(exp.bundleId, { sections: ['config'], policy: 'replace' });
  assert.deepEqual(onlyCfg.sections.map((s) => s.id), ['project-settings']);
  assert.deepEqual(seen.at(-1), ['plan', { theme: 'dark' }, 'replace']);
  const ap = await b.svc.apply(exp.bundleId, { sections: ['config'], confirm: true });
  assert.equal(ap.applied!.add, 1);
  assert.equal(seen.at(-1)![0], 'apply');
  assert.equal(b.datasets.list().length, 0, 'datasets section not selected — nothing created');

  const cfgOnlyExport = await a.svc.createExport({ sections: ['config'] });
  assert.deepEqual(cfgOnlyExport.sections.map((s) => s.kind), ['config']);
});

test('inventory: per-dataset ownership/origin online/counts/sizes, orphans, never-exported, sync health', async () => {
  const a = await sourceNode();
  a.roster.online('gw-other');
  // Orphans: an LMDB file and a lock-only leftover with no descriptor, and a stray sqlite.
  fs.writeFileSync(path.join(a.root, 'cache', 'ghost.lmdb'), Buffer.alloc(64));
  fs.writeFileSync(path.join(a.root, 'cache', 'e2e_old.lmdb-lock'), Buffer.alloc(8));
  fs.mkdirSync(path.join(a.root, 'sql'), { recursive: true });
  fs.writeFileSync(path.join(a.root, 'sql', 'stale.sqlite'), Buffer.alloc(16));
  await a.svc.createExport();

  const inv = await a.svc.inventory();
  assert.equal(inv.node.nodeId, SELF);
  assert.equal(inv.node.cluster, 'alpha');
  assert.deepEqual(inv.roster, { queried: true, available: true, onlinePeers: 1 });
  const byId = new Map(inv.datasets.map((d) => [d.id, d]));
  const bl = byId.get('backlog')!;
  assert.equal(bl.owned, true);
  assert.equal(bl.export, 'default');
  assert.equal(bl.records, 3);
  assert.equal(bl.tombstones, 1);
  assert.ok((bl.approxBytes ?? 0) > 0);
  assert.equal(byId.get('missions')!.records, 1, 'reserved ids are not counted');
  const wf = byId.get('mission-workflows')!;
  assert.equal(wf.owned, false);
  assert.equal(wf.export, 'opt-in');
  assert.deepEqual(wf.origin, { machineId: 'gw-origin', hostname: 'origin-host' });
  assert.equal(wf.originOnline, false);
  assert.equal(byId.get('sysidx')!.export, 'never');
  assert.equal(byId.get('sysidx')!.records, null);
  assert.equal(byId.get('node-clusters')!.export, 'never');
  assert.deepEqual(inv.orphans.map((o) => [o.id, o.backend, !!o.lockOnly]).sort(), [
    ['e2e_old', 'cache', true], ['ghost', 'cache', false], ['stale', 'sql', false],
  ]);
  assert.ok(inv.neverExported.some((s) => /api-token/.test(s)));
  assert.equal(inv.sync!.lastRun, '2026-09-23T00:00:00.000Z');
  assert.deepEqual(inv.sync!.errors, ['pull x/y: boom']);
  assert.equal(inv.bundles.count, 1);

  // Roster down: the origin's state is unknown, never "offline".
  a.roster.unavailable = 'hub down';
  const inv2 = await a.svc.inventory();
  assert.equal(inv2.roster.available, false);
  assert.match(inv2.roster.reason!, /hub down/);

  // No replica → no hub call at all.
  const lone = makeNode();
  await ownedDataset(lone, 'ds', []);
  assert.deepEqual((await lone.svc.inventory()).roster, { queried: false });
  assert.equal(lone.roster.calls, 0);
  assert.equal(new Map(inv2.datasets.map((d) => [d.id, d])).get('mission-workflows')!.originOnline, null);
});

test('export: DISK_LOW is refused before anything is read or written', async () => {
  const store = new BundleStore({ dir: path.join(tmp(), 'bundles'), receivedDir: tmp(), retention: 5, freeBytes: () => 1000 });
  const a = makeNode({ store });
  await ownedDataset(a, 'ds', [rec('r', 1, {})]);
  let reads = 0;
  const orig = a.data.exportRaw.bind(a.data);
  (a.data as any).exportRaw = (ctx: any, id: string) => { reads++; return orig(ctx, id); };
  const e = await rejectsCode(a.svc.createExport(), 'DISK_LOW');
  assert.equal((e as any).details.freeBytes, 1000);
  assert.equal(reads, 0);
  assert.equal((await store.list()).length, 0);
});

test('export fails loudly (never a silently short bundle) when a dataset cannot be read completely', async () => {
  const a = makeNode();
  await ownedDataset(a, 'ds', [rec('r', 1, {})]);
  (a.data as any).exportRaw = async () => ({ ok: false, code: 'EXPORT_INCOMPLETE', reason: 'cannot advance' });
  const e = await rejectsCode(a.svc.createExport(), 'EXPORT_INCOMPLETE');
  assert.match(e.message, /"ds"/);
  assert.equal((await a.store.list()).length, 0);
});

test('list / inspect / delete passthroughs; received:<name> resolves through the inbox', async () => {
  const a = await sourceNode();
  const exp = await a.svc.createExport();
  const list = await a.svc.listBundles();
  assert.equal(list[0].bundleId, exp.bundleId);
  assert.equal((list[0].sections![0] as any).sha256, undefined);
  const ins = await a.svc.inspect(exp.bundleId);
  assert.equal(ins.manifest.bundleId, exp.bundleId);
  assert.ok(ins.sizeBytes > 0);

  const inbox = tmp('svc-inbox-');
  const store2 = new BundleStore({ dir: path.join(tmp(), 'bundles'), receivedDir: inbox, retention: 5, freeBytes: () => 1e15 });
  fs.copyFileSync(a.store.pathFor(exp.bundleId), path.join(inbox, 'from-peer.lmbundle.gz'));
  const b = makeNode({ store: store2 });
  const plan = await b.svc.plan('received:from-peer.lmbundle.gz');
  assert.notEqual(plan.bundleId, exp.bundleId, 'stored under a NEW id');
  assert.equal(store2.getImportedMeta(plan.bundleId)!.importedFrom, exp.bundleId);
  await rejectsCode(b.svc.plan('received:../x'), 'RECEIVED_NAME_INVALID');

  assert.deepEqual(a.svc.deleteBundle(exp.bundleId), { bundleId: exp.bundleId, deleted: true });
  assert.deepEqual(a.svc.deleteBundle(exp.bundleId), { bundleId: exp.bundleId, deleted: false });
});

test('crafted bundle lines for system / denied / unsupported datasets are skipped with a warning', async () => {
  const b = makeNode();
  const id = await craftBundle(b.store, [
    { descriptor: descriptor('sysidx', { system: true }), records: [rec('a', 1, {})] },
    { descriptor: descriptor('node-clusters'), records: [rec('a', 1, {})] },
    { descriptor: descriptor('logs', { backend: 'file', config: { kind: 'file', path: '/x', format: 'log' } }), records: [rec('a', 1, {})] },
    { descriptor: descriptor('bundles'), records: [] },
  ]);
  const r = await b.svc.apply(id, { confirm: true });
  const by = new Map(r.sections.map((s) => [s.id, s]));
  for (const s of ['sysidx', 'node-clusters', 'logs']) {
    assert.equal((by.get(s) as any).action, 'skip', s);
    assert.equal(by.get(s)!.counts.skipped, 1, s);
    assert.equal(by.get(s)!.warnings.length, 1, s);
  }
  assert.equal(by.get('bundles')!.refused!.code, 'BAD_DATASET_ID');
  assert.equal(b.datasets.list().length, 0);
  void LOCAL;
});

test('export: a config/files source that throws is left out and named — it never blocks the backup', async () => {
  const good: ConfigProvider = {
    id: 'mcp-access', title: 'MCP access',
    collect: async () => ({ data: { adminGatedTools: [] }, redactedKeys: [], warnings: [] }),
    plan: async () => newSectionPlan('config', 'mcp-access'),
    apply: async () => asApplied(newSectionPlan('config', 'mcp-access')),
  };
  const bad: ConfigProvider = { ...good, id: 'scheduled-jobs', title: 'Scheduled jobs', collect: async () => { throw new Error('scheduler not loaded'); } };
  const a = makeNode({ deps: { configProviders: () => [bad, good] } });
  await ownedDataset(a, 'ds', [rec('r', 1, {})]);
  const res = await a.svc.createExport();
  assert.deepEqual(res.sections.map((s) => s.id), ['ds', 'mcp-access']);
  assert.ok(res.warnings.some((w) => /not exported — scheduled-jobs: scheduler not loaded/.test(w)));
  const m = await a.store.getManifest(res.bundleId);
  assert.deepEqual(m.options.collectErrors, ['scheduled-jobs: scheduler not loaded']);
});

test('a registry entry with NO id (seen on a real node) is skipped and counted, never a 500', async () => {
  const n = makeNode();
  await ownedDataset(n, 'ds', [rec('r1', 1, { a: 1 })]);
  // Append a descriptor without `id` straight into the registry file, the way an old build left one.
  const file = (n.datasets as unknown as { file: string }).file;
  const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
  arr.push({ backend: 'cache', ownerNode: SELF, visibility: 'local-only', syncMode: 'none', scope: 'cluster', config: { kind: 'cache' }, acl: [], createdAt: 'x', updatedAt: 'x' });
  fs.writeFileSync(file, JSON.stringify(arr));
  const inv = await n.svc.inventory();
  assert.deepEqual(inv.datasets.map((d) => d.id), ['ds']);
  assert.equal(inv.malformedDescriptors, 1);
  const exp = await n.svc.createExport();
  assert.deepEqual(exp.sections.filter((s) => s.kind === 'dataset').map((s) => s.id), ['ds']);
});
