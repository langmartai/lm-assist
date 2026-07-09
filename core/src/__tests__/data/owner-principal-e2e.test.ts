// core/src/__tests__/data/owner-principal-e2e.test.ts
// T3 end-to-end-ish: the actual scenario this fix closes — a hub-relayed sync-read
// (GET /data/:ds/export equivalent, i.e. DataService.exportDataset with a resolveSyncPrincipal
// -derived owner principal) against a real DataService + mock dataset. Mirrors the pattern in
// sync-auth.test.ts (isolated temp dirs, hermetic — no live hub).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-owner-e2e-'));

import { DataService } from '../../data/data-service';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { DatasetRegistry } from '../../data/dataset-registry';
import { KeyStore } from '../../data/key-store';
import { AccessManager } from '../../data/access-manager';
import type { ParsedRequest } from '../../routes/index';

function svc(nodeId = 'local-node') {
  const datasets = new DatasetRegistry(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oe-reg-')), 'd.json'),
  );
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'oe-keys-')));
  const backend = new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'oe-cache-')));
  const backends = new BackendRegistry();
  backends.register(backend);
  const manager = new AccessManager({ datasets, keys, nodeId });
  const service = new DataService({ datasets, backends, manager });
  (service as any).enabledOverride = true;
  return { service, datasets, keys, manager };
}

const LOCAL_CTX = { principal: { type: 'local' as const } };
// A GENUINE hub relay always arrives over loopback (api-relay-handler's makeLocalRequest
// dials hostname:'127.0.0.1') — resolveSyncPrincipal requires this in addition to the header
// (see owner-principal-resolve.test.ts for the adversarial non-loopback-spoof proof).
const hubReq = (): ParsedRequest =>
  ({ headers: { 'x-relay-source': 'hub' }, clientIp: '127.0.0.1' } as unknown as ParsedRequest);

test('T3 scenario: a hub-relayed sync-read resolves to owner and can export a cross-node-readable dataset with NO key or ACL', async () => {
  const { service, datasets } = svc();

  datasets.create({
    id: 'shareable-ds',
    backend: 'cache',
    visibility: 'cross-node-readable',
    syncMode: 'full',
    config: { kind: 'cache' },
    acl: [], // deliberately empty — this is the exact gap T3 closes: empty-ACL datasets don't
             // converge over the hub because the OLD path resolved to anonymous cloud (KEY_REQUIRED).
  });
  await service.put(LOCAL_CTX, 'shareable-ds', {
    id: 'r1', version: 0, fields: { hello: 'world' }, createdAt: 't', updatedAt: 't',
  });

  // Simulate the route: resolveSyncPrincipal(req) instead of resolvePrincipal(req).
  const ownerPrincipal = service.resolveSyncPrincipal(hubReq());
  assert.equal(ownerPrincipal.type, 'owner');

  const exported = await service.exportDataset({ principal: ownerPrincipal }, 'shareable-ds');
  assert.equal(exported.ok, true, `expected export to succeed, got: ${JSON.stringify(exported)}`);
  if (!exported.ok) return;
  assert.equal(exported.value.length, 1);
  assert.equal(exported.value[0].id, 'r1');
});

test('T3 scenario: the same hub-relayed sync-read is DENIED on a sensitive dataset', async () => {
  const { service, datasets } = svc();

  datasets.create({
    id: 'sensitive-ds',
    backend: 'cache',
    visibility: 'cross-node-readable',
    sensitive: true,
    syncMode: 'full',
    config: { kind: 'cache' },
    acl: [],
  });
  await service.put(LOCAL_CTX, 'sensitive-ds', {
    id: 'r1', version: 0, fields: { secret: true }, createdAt: 't', updatedAt: 't',
  });

  const ownerPrincipal = service.resolveSyncPrincipal(hubReq());
  const exported = await service.exportDataset({ principal: ownerPrincipal }, 'sensitive-ds');
  assert.equal(exported.ok, false, 'sensitive dataset must never be exported to an owner principal');
  assert.equal((exported as any).code, 'SENSITIVE', `expected SENSITIVE, got ${(exported as any).code}`);
});

test('T3 scenario: the same hub-relayed sync-read is DENIED on a local-only dataset', async () => {
  const { service, datasets } = svc();

  datasets.create({
    id: 'local-only-ds',
    backend: 'cache',
    visibility: 'local-only',
    syncMode: 'full',
    config: { kind: 'cache' },
    acl: [],
  });
  await service.put(LOCAL_CTX, 'local-only-ds', {
    id: 'r1', version: 0, fields: { x: 1 }, createdAt: 't', updatedAt: 't',
  });

  const ownerPrincipal = service.resolveSyncPrincipal(hubReq());
  const exported = await service.exportDataset({ principal: ownerPrincipal }, 'local-only-ds');
  assert.equal(exported.ok, false, 'local-only dataset must never be exported to an owner principal');
  assert.equal((exported as any).code, 'PEER_NOT_SHAREABLE', `expected PEER_NOT_SHAREABLE (identical to peer denial code), got ${(exported as any).code}`);
});

test('T3 scenario: an owner principal cannot write, even to the shareable dataset it can read', async () => {
  const { service, datasets } = svc();

  datasets.create({
    id: 'shareable-ds-2',
    backend: 'cache',
    visibility: 'cross-node-readable',
    syncMode: 'full',
    config: { kind: 'cache' },
    acl: [],
  });

  const ownerPrincipal = service.resolveSyncPrincipal(hubReq());
  const write = await service.put({ principal: ownerPrincipal }, 'shareable-ds-2', {
    id: 'r1', version: 0, fields: { x: 1 }, createdAt: 't', updatedAt: 't',
  });
  assert.equal(write.ok, false, 'owner principal must never be able to write');
});

test('T3 scenario: syncManifest(owner) advertises the shareable dataset (same as it would for peer)', async () => {
  const { service, datasets } = svc();

  datasets.create({
    id: 'manifest-ds',
    backend: 'cache',
    visibility: 'cross-node-readable',
    syncMode: 'full',
    config: { kind: 'cache' },
    acl: [],
  });
  datasets.create({
    id: 'manifest-ds-sensitive',
    backend: 'cache',
    visibility: 'cross-node-readable',
    sensitive: true,
    syncMode: 'full',
    config: { kind: 'cache' },
    acl: [],
  });

  const ownerPrincipal = service.resolveSyncPrincipal(hubReq());
  const manifest = service.syncManifest(ownerPrincipal);
  const ids = manifest.map((m) => m.id);
  assert.ok(ids.includes('manifest-ds'), 'shareable dataset should be in the owner-visible manifest');
  assert.ok(!ids.includes('manifest-ds-sensitive'), 'sensitive dataset must never appear in the owner-visible manifest');
});
