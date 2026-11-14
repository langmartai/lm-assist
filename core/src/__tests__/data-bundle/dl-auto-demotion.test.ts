// core/src/__tests__/data-bundle/dl-auto-demotion.test.ts
// SyncEngine auto-demotion of a returning superseded origin (spec: "Auto-demotion of a
// returning superseded origin"). Node O owned `backlog`, went offline, node N took it over
// (promoteReplica stamped supersedes=O). When O comes back and reconciles:
//   - it first pulls N's copy LWW (nothing of N's is lost on O);
//   - if O holds records N does not have (or newer than N's), demoting would STRAND them,
//     so O stays dual-owner and reports it in status.errors;
//   - otherwise O demotes itself to a replica of N.
// Only an explicit `supersedes` naming THIS node triggers any of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-dem-home-'));
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-dem-data-'));

import { DatasetRegistry } from '../../data/dataset-registry';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { SyncEngine } from '../../data/sync-engine';
import type { DatasetRegistry as DatasetRegistryT } from '../../data/dataset-registry';
import type { PeerClient, DataRecord, ManifestEntry } from '../../data/types';

function node(tag: string) {
  const datasets = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), `dl-dem-r-${tag}-`)), 'd.json'));
  const backend = new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(), `dl-dem-c-${tag}-`)));
  const backends = new BackendRegistry();
  backends.register(backend);
  return { datasets, backend, backends };
}

const rec = (id: string, version: number, updatedAt: string, fields: Record<string, unknown> = {}, extra: Partial<DataRecord> = {}): DataRecord =>
  ({ id, version, fields, createdAt: '2026-01-01T00:00:00.000Z', updatedAt, ...extra });

/** Returning origin "gw-O" owns backlog; peer "gw-N" serves the taken-over copy. */
function setup(opts: { oRecords: DataRecord[]; nRecords: DataRecord[]; supersedes?: string }) {
  const o = node('O');
  o.datasets.create({ id: 'backlog', backend: 'cache', visibility: 'cross-node-readable', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' } });
  const nRecords = opts.nRecords;
  const exportCalls: Array<string | undefined> = [];
  const entry: ManifestEntry = { id: 'backlog', syncMode: 'full', ownerNode: 'gw-N', backend: 'cache', scope: 'fleet' };
  if (opts.supersedes !== undefined) entry.supersedes = opts.supersedes;
  const peers: PeerClient = {
    listPeers: async () => [{ node: 'gw-N', hostname: 'new-host', platform: 'linux' }],
    manifest: async () => ({ node: 'gw-N', datasets: [entry] }),
    exportFrom: async (_n, _ds, since) => { exportCalls.push(since); return nRecords.filter((r) => !since || r.updatedAt >= since); },
    getFrom: async () => null,
  };
  const engine = new SyncEngine({ datasets: o.datasets, backends: o.backends, peers, nodeId: 'gw-O' });
  return { o, engine, exportCalls, seed: async () => { for (const r of opts.oRecords) await o.backend.put('backlog', r); } };
}

test('clean: nothing would be stranded → pull LWW, then demote to a replica of the new owner', async () => {
  const t = setup({
    supersedes: 'gw-O',
    // O's records are all on N at the same or a newer version
    oRecords: [rec('a', 2, '2026-01-02T00:00:00.000Z', { v: 'o' }), rec('b', 1, '2026-01-01T00:00:00.000Z')],
    nRecords: [rec('a', 3, '2026-01-03T00:00:00.000Z', { v: 'n' }), rec('b', 1, '2026-01-01T00:00:00.000Z'), rec('c', 1, '2026-01-04T00:00:00.000Z')],
  });
  await t.seed();
  const s = await t.engine.reconcile();
  assert.deepEqual(s.errors, []);
  const d = t.o.datasets.get('backlog')!;
  assert.equal(d.origin?.machineId, 'gw-N', 'demoted: now a replica of N');
  assert.equal(d.origin?.hostname, 'new-host');
  assert.equal(d.ownerNode, 'gw-N');
  assert.equal(d.visibility, 'local-only');
  assert.deepEqual(d.acl, []);
  assert.equal((await t.o.backend.get('backlog', 'a'))!.fields.v, 'n', 'N\'s newer copy was pulled first');
  assert.ok(await t.o.backend.get('backlog', 'c'));
  assert.equal(t.exportCalls[0], undefined, 'the comparison needs N\'s FULL copy');
});

test('stranded: O holds newer/missing records → stay dual-owner and say so in status.errors', async () => {
  const t = setup({
    supersedes: 'gw-O',
    oRecords: [
      rec('a', 5, '2026-01-05T00:00:00.000Z', { v: 'o-newer' }),   // newer than N's
      rec('only-o', 1, '2026-01-02T00:00:00.000Z'),                   // missing on N
      rec('old-tomb', 2, '2026-01-02T00:00:00.000Z', {}, { deleted: true }), // tombstone N never had → nothing to lose
    ],
    nRecords: [rec('a', 3, '2026-01-03T00:00:00.000Z', { v: 'n' })],
  });
  await t.seed();
  const s = await t.engine.reconcile();
  const d = t.o.datasets.get('backlog')!;
  assert.equal(d.origin, undefined, 'still OWNED — demoting would strand O\'s records');
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0], /^takeover backlog by .*gw-N.*: 2 local records not yet on .*— staying dual-owner/);
  assert.equal((await t.o.backend.get('backlog', 'a'))!.fields.v, 'o-newer', 'LWW kept O\'s newer record');
});

test('no supersedes marker (or one naming another node) → today\'s dual-owner merge, never a demotion', async () => {
  for (const marker of [undefined, 'gw-someone-else']) {
    const t = setup({
      supersedes: marker,
      oRecords: [rec('a', 1, '2026-01-01T00:00:00.000Z')],
      nRecords: [rec('a', 1, '2026-01-01T00:00:00.000Z')],
    });
    await t.seed();
    const s = await t.engine.reconcile();
    assert.deepEqual(s.errors, []);
    assert.equal(t.o.datasets.get('backlog')!.origin, undefined, `marker=${marker}: stays owned`);
  }
});

test('a demoted node keeps replicating normally on the next reconcile', async () => {
  const t = setup({
    supersedes: 'gw-O',
    oRecords: [rec('a', 1, '2026-01-01T00:00:00.000Z')],
    nRecords: [rec('a', 1, '2026-01-01T00:00:00.000Z')],
  });
  await t.seed();
  await t.engine.reconcile();
  assert.equal(t.o.datasets.get('backlog')!.origin?.machineId, 'gw-N');
  const s2 = await t.engine.reconcile();
  assert.deepEqual(s2.errors, []);
  assert.equal(s2.datasetsReplicated, 1);
  assert.equal(t.o.datasets.get('backlog')!.origin?.machineId, 'gw-N');
});

// ─── the node that TOOK OVER pulls the returning origin's full copy ─────────

/** Node "gw-N" took `x` (cluster scope) over from "gw-O"; gw-O is back and still lists it. */
function takerSetup(oRecords: DataRecord[], opts: { oSupersedes?: string; oSupersedesAt?: string; nMarkerAt?: string } = {}) {
  const n = node('N');
  n.datasets.create({
    id: 'x', backend: 'cache', visibility: 'cross-node-readable', syncMode: 'full', scope: 'cluster', config: { kind: 'cache' },
    supersedes: { machineId: 'gw-O', hostname: 'old-host', at: opts.nMarkerAt ?? '2026-01-02T12:00:00.000Z' },
  });
  const entry: ManifestEntry = { id: 'x', syncMode: 'full', ownerNode: 'gw-O', backend: 'cache', scope: 'cluster' };
  if (opts.oSupersedes) { entry.supersedes = opts.oSupersedes; if (opts.oSupersedesAt) entry.supersedesAt = opts.oSupersedesAt; }
  const exportCalls: Array<string | undefined> = [];
  const peers: PeerClient = {
    listPeers: async () => [{ node: 'gw-O', hostname: 'old-host', platform: 'linux' }],
    manifest: async () => ({ node: 'gw-O', datasets: [entry] }),
    exportFrom: async (_n, _ds, since) => { exportCalls.push(since); return oRecords.filter((r) => !since || r.updatedAt >= since); },
    getFrom: async () => null,
  };
  const engine = new SyncEngine({ datasets: n.datasets, backends: n.backends, peers, nodeId: 'gw-N' });
  return { n, engine, exportCalls };
}

test('the taker FULL-pulls the superseded origin: a partition-time write below its watermark is adopted', async () => {
  // O wrote r-a at 01-02 while partitioned; N took over and wrote r-b at 01-03.
  const t = takerSetup([rec('r-a', 1, '2026-01-02T00:00:00.000Z', { v: 'a' })]);
  await t.n.backend.put('x', rec('r-b', 1, '2026-01-03T00:00:00.000Z', { v: 'b' }));
  const before = Date.now();
  const s = await t.engine.reconcile();
  assert.deepEqual(s.errors, []);
  assert.equal(t.exportCalls[0], undefined, 'no watermark: the full copy is asked for');
  const ra = (await t.n.backend.get('x', 'r-a'))!;
  assert.ok(ra, 'r-a reached the taker');
  assert.equal(ra.fields.v, 'a');
  // Re-stamped so this node's own downstream replicas (watermark pulls) see it too.
  assert.equal(ra.version, 2, 'version+1 — out-LWWs the stale copy everywhere');
  assert.ok(Date.parse(ra.updatedAt) >= before - 1000, 'updatedAt = now — above every replica watermark');
  assert.equal(ra.origin, undefined, 'owned here');
  assert.equal(t.n.datasets.get('x')!.origin, undefined, 'the taker stays the owner');
});

test('once adopted, the returning origin finds nothing stranded and demotes', async () => {
  // Both sides wired together: O (owner, returning) and N (taker).
  const o = node('O2');
  const n = node('N2');
  o.datasets.create({ id: 'x', backend: 'cache', visibility: 'cross-node-readable', syncMode: 'full', scope: 'cluster', config: { kind: 'cache' } });
  n.datasets.create({ id: 'x', backend: 'cache', visibility: 'cross-node-readable', syncMode: 'full', scope: 'cluster', config: { kind: 'cache' }, supersedes: { machineId: 'gw-O', hostname: 'o', at: '2026-01-02T12:00:00.000Z' } });
  await o.backend.put('x', rec('r-a', 1, '2026-01-02T00:00:00.000Z'));
  await n.backend.put('x', rec('r-b', 1, '2026-01-03T00:00:00.000Z'));
  const manifestOf = (ds: DatasetRegistryT, self: string): ManifestEntry[] => ds.list().filter((d) => !d.origin).map((d) => ({
    id: d.id, syncMode: 'full' as const, ownerNode: self, backend: 'cache' as const, scope: 'cluster' as const,
    ...(d.supersedes ? { supersedes: d.supersedes.machineId, supersedesAt: d.supersedes.at } : {}),
  }));
  const client = (peerId: string, peer: ReturnType<typeof node>): PeerClient => ({
    listPeers: async () => [{ node: peerId, hostname: peerId, platform: 'linux' }],
    manifest: async () => ({ node: peerId, datasets: manifestOf(peer.datasets, peerId) }),
    exportFrom: async (_n, ds, since) => (await peer.backend.exportSince(ds, since)).filter((r) => !since || r.updatedAt >= since),
    getFrom: async () => null,
  });
  const eo = new SyncEngine({ datasets: o.datasets, backends: o.backends, peers: client('gw-N', n), nodeId: 'gw-O' });
  const en = new SyncEngine({ datasets: n.datasets, backends: n.backends, peers: client('gw-O', o), nodeId: 'gw-N' });
  const s1 = await eo.reconcile();
  assert.match(s1.errors.join('\n'), /1 local records not yet on/, 'round 1: r-a would be stranded');
  await en.reconcile();                                   // N full-pulls O and adopts r-a
  assert.ok(await n.backend.get('x', 'r-a'));
  const s2 = await eo.reconcile();
  assert.deepEqual(s2.errors, [], 'round 2: nothing stranded');
  assert.equal(o.datasets.get('x')!.origin?.machineId, 'gw-N', 'O demoted to a replica of N');
});

test('opposite takeovers: the NEWER takeover wins — its holder never demotes', async () => {
  // This node (gw-N) took x from gw-O at 01-05; gw-O's stale manifest still names us from 01-02.
  const newer = takerSetup([rec('r', 1, '2026-01-01T00:00:00.000Z')], { oSupersedes: 'gw-N', oSupersedesAt: '2026-01-02T00:00:00.000Z', nMarkerAt: '2026-01-05T00:00:00.000Z' });
  await newer.engine.reconcile();
  assert.equal(newer.n.datasets.get('x')!.origin, undefined, 'our newer takeover stands');
  // Reverse: our marker (01-02) is older than the peer's (01-05) → we are the one that demotes.
  const older = takerSetup([rec('r', 1, '2026-01-01T00:00:00.000Z')], { oSupersedes: 'gw-N', oSupersedesAt: '2026-01-05T00:00:00.000Z', nMarkerAt: '2026-01-02T00:00:00.000Z' });
  await older.engine.reconcile();
  assert.equal(older.n.datasets.get('x')!.origin?.machineId, 'gw-O', 'the older takeover yields');
});

test('an empty peer answer is reported honestly (unreachable or empty), never as a plain data gap', async () => {
  const t = setup({ supersedes: 'gw-O', oRecords: [rec('a', 1, '2026-01-01T00:00:00.000Z')], nRecords: [] });
  await t.seed();
  const s = await t.engine.reconcile();
  assert.match(s.errors[0], /returned no records — unreachable, or its copy is empty/);
  assert.equal(t.o.datasets.get('backlog')!.origin, undefined);
});

test('reconcile is single-flight: overlapping calls share one pass', async () => {
  const t = setup({ supersedes: 'gw-O', oRecords: [], nRecords: [] });
  const [a, b] = [t.engine.reconcile(), t.engine.reconcile()];
  assert.equal(a, b);
  await a;
  const c = t.engine.reconcile();
  assert.notEqual(c, a, 'a later call runs a fresh pass');
  await c;
});
