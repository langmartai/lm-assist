import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { DataService } from '../../data/data-service';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { DatasetRegistry } from '../../data/dataset-registry';
import { KeyStore } from '../../data/key-store';
import { AccessManager } from '../../data/access-manager';
import { REDACTED } from '../../data/redaction';
import { VectorBackend } from '../../data/backends/vector-backend';
import { fakeEmbed } from './_fake-embed';

function service() {
  const datasets = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ds-reg-')), 'd.json'));
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ds-keys-')));
  const backends = new BackendRegistry();
  backends.register(new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ds-cache-'))));
  const manager = new AccessManager({ datasets, keys, nodeId: 'n1' });
  // force-enable regardless of project settings on the test box
  const svc = new DataService({ datasets, backends, manager });
  (svc as any).enabledOverride = true;
  return { svc, datasets };
}

test('data service: local put then redacted get', async () => {
  const { svc, datasets } = service();
  datasets.create({ id: 'd', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [] });
  const local = { principal: { type: 'local' as const } };
  const put = await svc.put(local, 'd', { id: 'a', version: 0, fields: { name: 'x', apiKey: 'sk-1' }, createdAt: 't', updatedAt: 't' });
  assert.equal(put.ok, true);
  const got = await svc.get(local, 'd', 'a');
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.value?.fields.name, 'x');
  assert.equal(got.value?.fields.apiKey, REDACTED); // redaction on the way out
});

test('data service: cloud denied without key, allowed with minted key', async () => {
  const { svc, datasets } = service();
  datasets.create({ id: 'd', backend: 'cache', visibility: 'cross-node-readable',
    config: { kind: 'cache' }, acl: [{ principal: 'cloud', actions: ['read', 'query'] }] });
  await svc.put({ principal: { type: 'local' } }, 'd', { id: 'a', version: 0, fields: { n: 1 }, createdAt: 't', updatedAt: 't' });
  const cloud = { type: 'cloud' as const, userId: 'u1' };
  const denied = await svc.get({ principal: cloud }, 'd', 'a');
  assert.equal(denied.ok, false);
  const issued = await svc.requestAccess(cloud, { grants: [{ dataset: 'd', actions: ['read'] }] });
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  const ok = await svc.get({ principal: cloud, keyHeader: issued.value.key }, 'd', 'a');
  assert.equal(ok.ok, true);
});

test('data service: revoke is local-only', async () => {
  const { svc } = service();
  assert.equal(await svc.revoke({ type: 'cloud', userId: 'u' }, 'any-key-id'), false);
  // local revoke of a nonexistent key returns false too, but is not rejected by authz
  assert.equal(await svc.revoke({ type: 'local' }, 'nonexistent'), false);
});

test('data service: catalog reflects what a principal may do', async () => {
  const { svc, datasets } = service();
  datasets.create({ id: 'pub', backend: 'cache', visibility: 'cross-node-readable',
    config: { kind: 'cache' }, acl: [{ principal: 'cloud', actions: ['read'] }] });
  datasets.create({ id: 'priv', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [] });
  const cloud = svc.catalog({ type: 'cloud', userId: 'u' });
  assert.deepEqual(cloud.map((c) => c.id), ['pub']); // priv hidden from cloud
  const local = svc.catalog({ type: 'local' });
  assert.deepEqual(local.map((c) => c.id).sort(), ['priv', 'pub']);
});

function serviceWithVector() {
  const datasets = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ds-reg-')), 'd.json'));
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ds-keys-')));
  const backends = new BackendRegistry();
  backends.register(new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ds-cache-'))));
  backends.register(new VectorBackend({ storeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ds-vec-')), embed: fakeEmbed }));
  const manager = new AccessManager({ datasets, keys, nodeId: 'n1' });
  const svc = new DataService({ datasets, backends, manager });
  (svc as any).enabledOverride = true;
  return { svc, datasets };
}

test('data service: search on a vector dataset returns redacted scored records', async () => {
  const { svc, datasets } = serviceWithVector();
  datasets.create({ id: 'v', backend: 'vector', visibility: 'local-only', config: { kind: 'vector' }, acl: [] });
  const local = { principal: { type: 'local' as const } };
  await svc.put(local, 'v', { id: 'r1', version: 0, fields: { title: 'secret topic', apiKey: 'sk-leak' }, text: 'secret topic about widgets', createdAt: 't', updatedAt: 't' });
  const r = await svc.search(local, 'v', { query: 'widgets topic', limit: 5 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.value.length >= 1);
  assert.equal(r.value[0].id, 'r1');
  assert.ok(Number.isFinite(r.value[0].score) && r.value[0].score > 0);
  assert.equal(r.value[0].fields.apiKey, REDACTED); // redaction applies to search results too
});

test('data service: search on a non-search backend (cache) returns NOT_SUPPORTED', async () => {
  const { svc, datasets } = serviceWithVector();
  datasets.create({ id: 'c', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [] });
  const r = await svc.search({ principal: { type: 'local' } }, 'c', { query: 'x' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'NOT_SUPPORTED');
});

test('data service: cloud without key cannot search (auth before backend check)', async () => {
  const { svc, datasets } = serviceWithVector();
  datasets.create({ id: 'v2', backend: 'vector', visibility: 'cross-node-readable',
    config: { kind: 'vector' }, acl: [{ principal: 'cloud', actions: ['search'] }] });
  const denied = await svc.search({ principal: { type: 'cloud', userId: 'u' } }, 'v2', { query: 'x' });
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.code, 'KEY_REQUIRED');
});
