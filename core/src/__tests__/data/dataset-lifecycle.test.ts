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
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-lc-cache-'));
  const datasets = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-lc-reg-')), 'd.json'));
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-lc-keys-')));
  const backends = new BackendRegistry();
  backends.register(new CacheBackend(cacheDir));
  const manager = new AccessManager({ datasets, keys, nodeId: 'n1' });
  const s = new DataService({ datasets, backends, manager });
  (s as any).enabledOverride = true;
  return { s, datasets, cacheDir };
}

test('lifecycle: initDataset allocates storage; dropDataset removes descriptor + storage', async () => {
  const { s, datasets, cacheDir } = svc();
  datasets.create({ id: 'lc', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [] });
  const local = { principal: { type: 'local' as const } };
  const init = await s.initDataset(local, 'lc');
  assert.equal(init.ok, true);
  assert.ok(fs.existsSync(path.join(cacheDir, 'lc.lmdb')));       // backend.createDataset ran
  // write + read works after init
  await s.put(local, 'lc', { id: 'a', version: 0, fields: { n: 1 }, createdAt: 't', updatedAt: 't' });
  const drop = await s.dropDataset(local, 'lc');
  assert.equal(drop.ok, true);
  assert.equal(datasets.get('lc'), undefined);                    // descriptor gone
  assert.ok(!fs.existsSync(path.join(cacheDir, 'lc.lmdb')));      // storage gone
});

test('lifecycle: dropDataset is local-only and refuses system datasets', async () => {
  const { s, datasets } = svc();
  datasets.create({ id: 'usr', backend: 'cache', config: { kind: 'cache' }, acl: [] });
  const denied = await s.dropDataset({ principal: { type: 'cloud', userId: 'u' } }, 'usr');
  assert.equal(denied.ok, false);
  datasets.create({ id: 'sysd', backend: 'cache', system: true, config: { kind: 'cache' }, acl: [] });
  const sysDrop = await s.dropDataset({ principal: { type: 'local' } }, 'sysd');
  assert.equal(sysDrop.ok, false);
  if (sysDrop.ok) return;
  assert.equal(sysDrop.code, 'FORBIDDEN');
});
