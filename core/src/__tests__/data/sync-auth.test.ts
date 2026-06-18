// core/src/__tests__/data/sync-auth.test.ts
// Verifies the cross-node sync auth boundary:
//   - keyless cloud principal is denied on a cloud-read dataset (KEY_REQUIRED)
//   - cloud principal with a minted key is allowed (cross-node read works)
//   - del on a replica descriptor returns READ_ONLY_REPLICA
//   - upsertReplica does NOT overwrite a locally-owned dataset

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Isolate data dir for this test module
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sa-'));

import { DataService } from '../../data/data-service';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { DatasetRegistry } from '../../data/dataset-registry';
import { KeyStore } from '../../data/key-store';
import { AccessManager } from '../../data/access-manager';

// ── Helper — isolated DataService (mirrors pattern in data-service.test.ts) ──

function svc(nodeId = 'local-node') {
  const datasets = new DatasetRegistry(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-reg-')), 'd.json'),
  );
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-keys-')));
  const backend = new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cache-')));
  const backends = new BackendRegistry();
  backends.register(backend);
  const manager = new AccessManager({ datasets, keys, nodeId });
  const service = new DataService({ datasets, backends, manager });
  (service as any).enabledOverride = true;
  return { service, datasets, keys, manager };
}

const LOCAL_CTX = { principal: { type: 'local' as const } };
const CLOUD_P = { type: 'cloud' as const, userId: 'u1' };

// ── Test 1: keyless cloud is denied (KEY_REQUIRED) ────────────────────────────

test('sync-auth: keyless cloud is denied KEY_REQUIRED on exportDataset', async () => {
  const { service, datasets } = svc();

  // Create a cross-node-readable dataset with cloud-read ACL, syncMode full
  datasets.create({
    id: 'syncds',
    backend: 'cache',
    visibility: 'cross-node-readable',
    syncMode: 'full',
    config: { kind: 'cache' },
    acl: [{ principal: 'cloud', actions: ['read'] }],
  });

  // Put a local record so there's something to export
  await service.put(LOCAL_CTX, 'syncds', {
    id: 'r1', version: 0, fields: { x: 1 }, createdAt: 't', updatedAt: 't',
  });

  // Cloud with NO key must be denied
  const denied = await service.exportDataset({ principal: CLOUD_P }, 'syncds');
  assert.equal(denied.ok, false, 'expected denial for keyless cloud');
  assert.equal((denied as any).code, 'KEY_REQUIRED', `expected KEY_REQUIRED, got ${(denied as any).code}`);
});

// ── Test 2: cloud with minted key is allowed ──────────────────────────────────

test('sync-auth: cloud with minted key can exportDataset', async () => {
  const { service, datasets } = svc();

  datasets.create({
    id: 'syncds2',
    backend: 'cache',
    visibility: 'cross-node-readable',
    syncMode: 'full',
    config: { kind: 'cache' },
    acl: [{ principal: 'cloud', actions: ['read'] }],
  });

  await service.put(LOCAL_CTX, 'syncds2', {
    id: 'r1', version: 0, fields: { v: 42 }, createdAt: 't', updatedAt: 't',
  });

  // Mint a key the way the sync engine does (via requestAccess on the peer)
  const minted = await service.requestAccess(CLOUD_P, {
    intent: 'lm-assist cross-node sync',
    grants: [{ dataset: 'syncds2', actions: ['read'] }],
  });
  assert.equal(minted.ok, true, 'requestAccess must succeed for cloud on cloud-read dataset');
  if (!minted.ok) return;

  const { key } = minted.value;
  assert.ok(typeof key === 'string' && key.length > 0, 'minted key must be a non-empty string');

  // Export with the minted key — must succeed and return the record
  const exported = await service.exportDataset(
    { principal: CLOUD_P, keyHeader: key },
    'syncds2',
  );
  assert.equal(exported.ok, true, 'exportDataset with minted key must succeed');
  if (!exported.ok) return;
  assert.ok(Array.isArray(exported.value), 'export must return an array');
  assert.equal(exported.value.length, 1, 'should export the one record that was put');
});

// ── Test 3: del on a replica returns READ_ONLY_REPLICA ───────────────────────

test('sync-auth: del on replica dataset returns READ_ONLY_REPLICA', async () => {
  const { service, datasets } = svc();

  // Register a replica (as the sync engine would after pulling from a peer)
  datasets.upsertReplica({
    id: 'replica1',
    backend: 'cache',
    ownerNode: 'peer-node',
    syncMode: 'full',
    config: { kind: 'cache' },
    origin: { machineId: 'peer-node', hostname: 'peer', os: 'linux' },
  });

  // del must be rejected (read-only replica) even for a local caller
  const result = await service.del(LOCAL_CTX, 'replica1', 'any-id');
  assert.equal(result.ok, false, 'del on replica must fail');
  assert.equal((result as any).code, 'READ_ONLY_REPLICA', `expected READ_ONLY_REPLICA, got ${(result as any).code}`);
});

// ── Test 4: upsertReplica does NOT overwrite a locally-owned dataset ──────────

test('sync-auth: upsertReplica does not clobber a locally-owned dataset', async () => {
  const { service, datasets } = svc();

  // Create a local (owned) dataset
  datasets.create({
    id: 'localowned',
    backend: 'cache',
    visibility: 'cross-node-readable',
    syncMode: 'full',
    config: { kind: 'cache' },
    acl: [{ principal: 'cloud', actions: ['read'] }],
  });

  // Put a record so we can verify writability is preserved
  const put = await service.put(LOCAL_CTX, 'localowned', {
    id: 'r1', version: 0, fields: { owner: true }, createdAt: 't', updatedAt: 't',
  });
  assert.equal(put.ok, true, 'local put on owned dataset must succeed before upsertReplica');

  // Attempt to overwrite with a replica descriptor (simulating a rogue sync)
  const after = datasets.upsertReplica({
    id: 'localowned',
    backend: 'cache',
    ownerNode: 'some-peer',
    syncMode: 'full',
    config: { kind: 'cache' },
    origin: { machineId: 'some-peer', hostname: 'peer', os: 'linux' },
  });

  // The returned descriptor must NOT have an origin (i.e. it's still locally owned)
  assert.equal((after as any).origin, undefined, 'upsertReplica must NOT set origin on a locally-owned dataset');

  // Writes must still succeed (not locked as read-only)
  const put2 = await service.put(LOCAL_CTX, 'localowned', {
    id: 'r2', version: 0, fields: { owner: true }, createdAt: 't', updatedAt: 't',
  });
  assert.equal(put2.ok, true, 'local put must still succeed after failed upsertReplica attempt');
});
