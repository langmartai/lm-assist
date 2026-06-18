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

function svc() {
  const datasets = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-mgmt-reg-')), 'd.json'));
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-mgmt-keys-')));
  const backends = new BackendRegistry();
  backends.register(new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-mgmt-cache-'))));
  const manager = new AccessManager({ datasets, keys, nodeId: 'n1' });
  const s = new DataService({ datasets, backends, manager });
  (s as any).enabledOverride = true;
  return { s, datasets, keys };
}
const LOCAL = { principal: { type: 'local' as const } };
const CLOUD = { principal: { type: 'cloud' as const, userId: 'u' } };

test('createDataset: local creates + allocates; cloud is FORBIDDEN', async () => {
  const { s, datasets } = svc();
  const r = await s.createDataset(LOCAL, { id: 'md1', backend: 'cache', config: { kind: 'cache' }, acl: [] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.id, 'md1');
  assert.ok(datasets.get('md1'));
  // a write works (storage allocated)
  const put = await s.put(LOCAL, 'md1', { id: 'a', version: 0, fields: { n: 1 }, createdAt: 't', updatedAt: 't' });
  assert.equal(put.ok, true);
  const denied = await s.createDataset(CLOUD, { id: 'md2', backend: 'cache', config: { kind: 'cache' }, acl: [] });
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.code, 'FORBIDDEN');
  assert.equal(datasets.get('md2'), undefined); // not created on a denied call
});

test('listKeys: local lists key metadata WITHOUT secretHash; cloud FORBIDDEN', async () => {
  const { s, datasets } = svc();
  datasets.create({ id: 'x', backend: 'cache', config: { kind: 'cache' }, acl: [{ principal: '*', actions: ['read'] }] });
  const issued = await s.requestAccess({ type: 'local' }, { grants: [{ dataset: 'x', actions: ['read'] }], intent: 'test' });
  assert.equal(issued.ok, true);
  const r = await s.listKeys(LOCAL);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.value.length >= 1);
  for (const k of r.value) {
    assert.ok(k.keyId);
    assert.equal((k as any).secretHash, undefined); // NEVER expose the hash
    assert.ok(Array.isArray(k.grants));
  }
  const denied = await s.listKeys(CLOUD);
  assert.equal(denied.ok, false);
});

test('sync + syncStatus are local-only', async () => {
  const { s } = svc();
  const st = await s.syncStatus(LOCAL);
  assert.equal(st.ok, true);
  const denied = await s.syncStatus(CLOUD);
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.code, 'FORBIDDEN');
});

test('createDataset: ignores caller-supplied system/origin (stays user-droppable)', async () => {
  const { s, datasets } = svc();
  const r = await s.createDataset(LOCAL, {
    id: 'md3', backend: 'cache', config: { kind: 'cache' }, acl: [],
    system: true, origin: { machineId: 'evil', updatedAt: 't', version: 1 },
  } as any);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.notEqual(r.value.system, true);              // system flag NOT honored from caller input
  assert.equal((r.value as any).origin, undefined);   // no replica origin stamped
  const stored = datasets.get('md3');
  assert.ok(stored);
  assert.notEqual(stored!.system, true);
  // because it is not a system dataset, it is user-droppable:
  const dropped = await s.dropDataset(LOCAL, 'md3');
  assert.equal(dropped.ok, true);
});

test('catalogView: reports caller capability (canManage) alongside visible datasets', async () => {
  const { s, datasets } = svc();
  datasets.create({ id: 'cv1', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [{ principal: '*', actions: ['read'] }] });

  const local = s.catalogView(LOCAL.principal);
  assert.equal(local.you.principal, 'local');
  assert.equal(local.you.canManage, true);
  assert.ok(Array.isArray(local.datasets));
  assert.ok(local.datasets.some((d) => d.id === 'cv1'));

  const cloud = s.catalogView(CLOUD.principal);
  assert.equal(cloud.you.principal, 'cloud');
  assert.equal(cloud.you.canManage, false);
});
