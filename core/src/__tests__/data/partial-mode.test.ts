// core/src/__tests__/data/partial-mode.test.ts
// Tests for M5 Task 6: partial sync mode — local-first get + remote-fallback + lazy cache.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Isolated data dir — must be set before any module that reads paths
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-pm-'));

import { DatasetRegistry } from '../../data/dataset-registry';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { DataService } from '../../data/data-service';
import { AccessManager } from '../../data/access-manager';
import { KeyStore } from '../../data/key-store';
import { SyncEngine } from '../../data/sync-engine';
import type { PeerClient, DataRecord, ManifestEntry, NodeInfo } from '../../data/types';

// ── Helper: build a fully isolated DataService ────────────────────────────────

function mkSvc(nodeId: string) {
  const regFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `pm-reg-${nodeId}-`)), 'd.json');
  const datasets = new DatasetRegistry(regFile);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), `pm-cache-${nodeId}-`));
  const backend = new CacheBackend(cacheDir);
  const backends = new BackendRegistry();
  backends.register(backend);
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), `pm-keys-${nodeId}-`)));
  const manager = new AccessManager({ datasets, keys, nodeId });
  return { datasets, backend, backends, manager, cacheDir };
}

const LOCAL_CTX = { principal: { type: 'local' as const } };

function mkRecord(id: string, fields: Record<string, unknown> = {}): DataRecord {
  const now = new Date().toISOString();
  return { id, version: 1, fields, createdAt: now, updatedAt: now };
}

// ── Test 1: local-miss → remote fetch → lazy cache ───────────────────────────

/*
 * 🔴 These manifests declare `scope: 'fleet'` EXPLICITLY.
 *
 * MEASURED 2026-08-02: without it the engine defaults to `scope: 'cluster'`
 * (sync-engine.ts, `m.scope ?? 'cluster'`), and the cluster guard then resolves the
 * REAL cluster identity of whatever host the suite runs on — via getMyCluster() /
 * getClusterRecords(), which read live config, not test fixtures. On a host with no
 * cluster config every node collapses to 'default' and these pass; on a configured
 * host (measured here: getMyCluster() === 'dev') peer 'A' resolves elsewhere,
 * shouldPullDataset() returns false, reconcile silently pulls NOTHING, and the
 * suite fails with "replica descriptor must be present on B".
 *
 * That made the outcome depend on the machine rather than the code — and it fails
 * QUIETLY, because a reconcile that pulls nothing still reports success. Note the
 * "second reconcile is idempotent (applied=0)" test PASSED throughout, for exactly
 * the wrong reason.
 *
 * These tests are about FULL-MODE REPLICATION; cluster scoping has its own coverage
 * in sync-engine-scope.test.ts, which sets its cluster context up deliberately.
 */
test('partial mode: local miss triggers remote fetch and lazy-caches the record', async () => {
  const { datasets, backend, backends, manager } = mkSvc('P1');

  // Spy counter for getFrom calls
  let getFromCalls = 0;
  const remoteRecord = mkRecord('remote1', { value: 42 });

  const fakePeer: PeerClient = {
    listPeers: async (): Promise<NodeInfo[]> => [{ node: 'remote-node', hostname: 'rhost', platform: 'linux' }],
    manifest: async () => ({ node: 'remote-node', datasets: [] }),
    exportFrom: async () => [],
    getFrom: async (_node, _ds, id) => {
      getFromCalls++;
      return id === 'remote1' ? { ...remoteRecord } : null;
    },
  };

  const svc = new DataService({ datasets, backends, manager, peers: fakePeer });
  (svc as any).enabledOverride = true;

  // Create a partial dataset
  datasets.create({ id: 'p', backend: 'cache', syncMode: 'partial', config: { kind: 'cache' }, acl: [] });
  // CacheBackend auto-opens on first access — createDataset is a no-op but ensures consistent state
  await backend.createDataset(datasets.get('p')!);

  // 1a. get for 'remote1' (local miss) — should call remote and return value
  const got = await svc.get(LOCAL_CTX, 'p', 'remote1');
  assert.ok(got.ok, 'get should succeed');
  assert.ok(got.value !== null, 'should return the remote record');
  assert.equal((got.value as DataRecord).id, 'remote1');
  assert.equal((got.value as DataRecord).fields.value, 42);
  // The returned record must carry origin (consistent with cache)
  assert.ok((got.value as DataRecord).origin !== undefined, 'returned record must have origin stamped');
  assert.equal((got.value as DataRecord).origin!.machineId, 'remote-node', 'returned origin machineId must match peer');

  // 1b. getFrom was called exactly once
  assert.equal(getFromCalls, 1, 'getFrom should be called once for the remote fetch');

  // 1c. The record is now lazily cached locally
  const cached = await backend.get('p', 'remote1');
  assert.ok(cached !== null, 'record must be cached locally after remote fetch');
  assert.equal(cached!.id, 'remote1');
  // origin must be stamped
  assert.ok(cached!.origin !== undefined, 'origin must be stamped on cached record');
  assert.equal(cached!.origin!.machineId, 'remote-node');
});

// ── Test 2: local hit → no peer call ─────────────────────────────────────────

test('partial mode: local hit does NOT call remote peer', async () => {
  const { datasets, backend, backends, manager } = mkSvc('P2');

  let getFromCalls = 0;
  const fakePeer: PeerClient = {
    listPeers: async (): Promise<NodeInfo[]> => [{ node: 'rnode', hostname: 'rh', platform: 'linux' }],
    manifest: async () => ({ node: 'rnode', datasets: [] }),
    exportFrom: async () => [],
    getFrom: async () => { getFromCalls++; return null; },
  };

  const svc = new DataService({ datasets, backends, manager, peers: fakePeer });
  (svc as any).enabledOverride = true;

  datasets.create({ id: 'p', backend: 'cache', syncMode: 'partial', config: { kind: 'cache' }, acl: [] });
  await backend.createDataset(datasets.get('p')!);

  // Write a local record
  await svc.put(LOCAL_CTX, 'p', { id: 'local1', version: 0, fields: { x: 1 }, createdAt: '', updatedAt: '' });
  const callsAfterPut = getFromCalls;

  // Get the local record — should hit local, not remote
  const got = await svc.get(LOCAL_CTX, 'p', 'local1');
  assert.ok(got.ok, 'get should succeed');
  assert.ok(got.value !== null, 'should return the local record');
  assert.equal((got.value as DataRecord).fields.x, 1);

  // getFrom must NOT have been called (same count as after put)
  assert.equal(getFromCalls, callsAfterPut, 'getFrom must not be called when record is local');
});

// ── Test 3: total miss (not on any peer) → null ────────────────────────────

test('partial mode: total miss returns null', async () => {
  const { datasets, backend, backends, manager } = mkSvc('P3');

  const fakePeer: PeerClient = {
    listPeers: async (): Promise<NodeInfo[]> => [{ node: 'rnode', hostname: 'rh', platform: 'linux' }],
    manifest: async () => ({ node: 'rnode', datasets: [] }),
    exportFrom: async () => [],
    getFrom: async () => null, // nothing found anywhere
  };

  const svc = new DataService({ datasets, backends, manager, peers: fakePeer });
  (svc as any).enabledOverride = true;

  datasets.create({ id: 'p', backend: 'cache', syncMode: 'partial', config: { kind: 'cache' }, acl: [] });
  await backend.createDataset(datasets.get('p')!);

  const got = await svc.get(LOCAL_CTX, 'p', 'nope');
  assert.ok(got.ok, 'get should succeed (not an error)');
  assert.equal(got.value, null, 'total miss must return null');
});

// ── Test 4: reconcile registers partial descriptor without importing records ──

test('SyncEngine: reconcile registers partial descriptor without importing records', async () => {
  const { datasets, backend, backends, manager } = mkSvc('SE-P');

  // Fake peer exposes one partial dataset with one record
  const partialRecord = mkRecord('r99', { data: 'should-not-be-pulled' });
  let exportFromCalls = 0;

  const fakePeer: PeerClient = {
    listPeers: async (): Promise<NodeInfo[]> => [{ node: 'peer-node', hostname: 'ph', platform: 'darwin' }],
    manifest: async () => ({
      node: 'peer-node',
      datasets: [{ id: 'lazy-ds', syncMode: 'partial', ownerNode: 'peer-node', backend: 'cache', scope: 'fleet' }] as ManifestEntry[],
    }),
    exportFrom: async () => { exportFromCalls++; return [partialRecord]; },
    getFrom: async () => null,
  };

  const engine = new SyncEngine({ datasets, backends, peers: fakePeer, nodeId: 'local-node' });
  await engine.reconcile();

  // Descriptor must be registered
  const desc = datasets.get('lazy-ds');
  assert.ok(desc !== undefined, 'partial dataset descriptor must be registered after reconcile');
  assert.equal(desc!.syncMode, 'partial', 'syncMode must be "partial"');
  assert.equal(desc!.origin?.machineId, 'peer-node', 'origin must record peer node');

  // exportFrom must NOT have been called (partial = no eager pull)
  assert.equal(exportFromCalls, 0, 'exportFrom must not be called for partial datasets');

  // No records imported — the backend has 0 records for this dataset
  const records = await backend.exportSince('lazy-ds');
  assert.equal(records.length, 0, 'no records should be in local backend for a partial dataset after reconcile');
});
