// core/src/__tests__/data-bundle/dl-registry-takeover.test.ts
// DatasetRegistry durability + ownership moves for the data-bundle feature:
//  - atomic save (tmp + fsync + rename, one .bak) and .bak recovery of a corrupt file;
//  - promoteReplica / demoteToReplica (guarded takeover + auto-demotion primitives);
//  - 'bundles' is a reserved id (it would collide with the /data/bundles routes);
//  - syncManifest advertises `supersedes` so a returning origin can demote itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Hermetic: several modules resolve ~/.lm-assist at import time (thisNodeId → hub config).
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-reg-home-'));
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-reg-data-'));

import { DatasetRegistry, RESERVED_DATASET_IDS } from '../../data/dataset-registry';
import { DataService } from '../../data/data-service';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { AccessManager } from '../../data/access-manager';
import { KeyStore } from '../../data/key-store';
import { thisNodeId } from '../../data/paths';
import type { NodeOrigin } from '../../data/types';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-reg-')), 'datasets.json');
}

const ORIGIN: NodeOrigin = { machineId: 'gw-old', hostname: 'old-host', os: 'linux' };

function withReplica(r: DatasetRegistry): void {
  r.upsertReplica({
    id: 'backlog', backend: 'cache', ownerNode: 'gw-old', syncMode: 'full', scope: 'fleet',
    config: { kind: 'cache' }, origin: ORIGIN, title: 'Backlog',
  });
}

// ── atomic save ─────────────────────────────────────────────────────────────

test('save is atomic: no .tmp left behind, and one .bak holds the PREVIOUS good content', () => {
  const file = tmpFile();
  const r = new DatasetRegistry(file);
  r.create({ id: 'one', backend: 'cache', config: { kind: 'cache' } });
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), [], 'the temp file is renamed into place');
  r.create({ id: 'two', backend: 'cache', config: { kind: 'cache' } });
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), []);
  const bak = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf-8'));
  assert.deepEqual(bak.map((d: { id: string }) => d.id), ['one'], '.bak is the state before the last save');
  const cur = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepEqual(cur.map((d: { id: string }) => d.id), ['one', 'two']);
});

test('a corrupt datasets.json loads from .bak instead of silently becoming []', () => {
  const file = tmpFile();
  const r = new DatasetRegistry(file);
  r.create({ id: 'keep-me', backend: 'cache', config: { kind: 'cache' } });
  r.create({ id: 'and-me', backend: 'cache', config: { kind: 'cache' } });
  fs.writeFileSync(file, '{"truncated": [');                 // a torn write / disk-full artifact
  const fresh = new DatasetRegistry(file);
  assert.deepEqual(fresh.list().map((d) => d.id), ['keep-me'], 'recovered from the one-step-back .bak');
  // …and the next save must not clobber the good .bak with the corrupt file.
  fresh.create({ id: 'after', backend: 'cache', config: { kind: 'cache' } });
  const bak = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf-8'));
  assert.deepEqual(bak.map((d: { id: string }) => d.id), ['keep-me'], 'a corrupt main file is never copied over .bak');
  assert.deepEqual(new DatasetRegistry(file).list().map((d) => d.id), ['keep-me', 'after']);
});

// ── reserved id ─────────────────────────────────────────────────────────────

test("'bundles' is a reserved dataset id (it would shadow /data/bundles routes)", () => {
  assert.ok(RESERVED_DATASET_IDS.has('bundles'));
  const r = new DatasetRegistry(tmpFile());
  assert.throws(() => r.create({ id: 'bundles', backend: 'cache', config: { kind: 'cache' } }), /reserved/i);
});

// ── promoteReplica ──────────────────────────────────────────────────────────

test('promoteReplica: clears origin, owns it here, stamps supersedes, keeps scope/syncMode/config', () => {
  const r = new DatasetRegistry(tmpFile());
  withReplica(r);
  const before = r.get('backlog')!;
  assert.equal(before.visibility, 'local-only');
  const p = r.promoteReplica('backlog');
  assert.equal(p.origin, undefined, 'no origin ⇒ locally owned (writable)');
  assert.equal(p.ownerNode, thisNodeId());
  assert.equal(p.visibility, 'cross-node-readable', 'a replica\'s local-only is an artifact, not the owner\'s choice');
  assert.deepEqual(p.acl, []);
  assert.equal(p.scope, 'fleet');
  assert.equal(p.syncMode, 'full');
  assert.deepEqual(p.config, { kind: 'cache' });
  assert.equal(p.title, 'Backlog');
  assert.equal(p.createdAt, before.createdAt);
  assert.equal(p.supersedes?.machineId, 'gw-old');
  assert.equal(p.supersedes?.hostname, 'old-host');
  assert.ok(p.supersedes?.at && !Number.isNaN(Date.parse(p.supersedes.at)));
  // persisted, and a later replica upsert can no longer overwrite it (owned-guard)
  const again = new DatasetRegistry((r as any).file as string);
  assert.equal(again.get('backlog')?.supersedes?.machineId, 'gw-old');
  again.upsertReplica({ id: 'backlog', backend: 'cache', ownerNode: 'gw-x', syncMode: 'full', config: { kind: 'cache' }, origin: ORIGIN });
  assert.equal(again.get('backlog')?.origin, undefined);
});

test('promoteReplica: a patch supplies the bundle\'s visibility/acl', () => {
  const r = new DatasetRegistry(tmpFile());
  withReplica(r);
  const p = r.promoteReplica('backlog', { visibility: 'synced', acl: [{ principal: 'peer', actions: ['read'] }] });
  assert.equal(p.visibility, 'synced');
  assert.deepEqual(p.acl, [{ principal: 'peer', actions: ['read'] }]);
});

test('promoteReplica refuses an owned dataset (NOT_A_REPLICA) and a missing one (NOT_FOUND)', () => {
  const r = new DatasetRegistry(tmpFile());
  r.create({ id: 'mine', backend: 'cache', config: { kind: 'cache' } });
  assert.throws(() => r.promoteReplica('mine'), (e: any) => e.code === 'NOT_A_REPLICA');
  assert.throws(() => r.promoteReplica('nope'), (e: any) => e.code === 'NOT_FOUND');
});

// ── demoteToReplica ─────────────────────────────────────────────────────────

test('demoteToReplica: sets origin + ownerNode, local-only, empty acl, drops supersedes', () => {
  const r = new DatasetRegistry(tmpFile());
  withReplica(r);
  r.promoteReplica('backlog', { acl: [{ principal: 'peer', actions: ['read'] }] });
  const newOwner: NodeOrigin = { machineId: 'gw-new', hostname: 'new-host', os: 'linux' };
  const d = r.demoteToReplica('backlog', newOwner, 'gw-new');
  assert.deepEqual(d.origin, newOwner);
  assert.equal(d.ownerNode, 'gw-new');
  assert.equal(d.visibility, 'local-only');
  assert.deepEqual(d.acl, []);
  assert.equal(d.supersedes, undefined);
  assert.equal(d.scope, 'fleet');
  assert.equal(d.syncMode, 'full');
});

test('demoteToReplica refuses a missing or system dataset', () => {
  const r = new DatasetRegistry(tmpFile());
  r.create({ id: 'sys', backend: 'cache', system: true, config: { kind: 'cache' } });
  assert.throws(() => r.demoteToReplica('nope', ORIGIN, 'gw-old'), (e: any) => e.code === 'NOT_FOUND');
  assert.throws(() => r.demoteToReplica('sys', ORIGIN, 'gw-old'), (e: any) => e.code === 'FORBIDDEN');
});

// ── syncManifest carries supersedes ─────────────────────────────────────────

test('syncManifest advertises supersedes (a machineId) only on descriptors that carry it', () => {
  const datasets = new DatasetRegistry(tmpFile());
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-reg-k-')));
  const backends = new BackendRegistry();
  backends.register(new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-reg-c-'))));
  const s = new DataService({ datasets, backends, manager: new AccessManager({ datasets, keys, nodeId: 'self' }) });
  withReplica(datasets);
  datasets.promoteReplica('backlog');
  datasets.create({ id: 'plain', backend: 'cache', visibility: 'cross-node-readable', syncMode: 'full', config: { kind: 'cache' } });
  const m = s.syncManifest({ type: 'local' });
  assert.equal(m.find((e) => e.id === 'backlog')?.supersedes, 'gw-old');
  assert.equal('supersedes' in m.find((e) => e.id === 'plain')!, false, 'no marker ⇒ no field (old builds ignore it anyway)');
});
