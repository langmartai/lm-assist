import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-m5-'));
import { DataService } from '../../data/data-service';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { DatasetRegistry } from '../../data/dataset-registry';
import { KeyStore } from '../../data/key-store';
import { AccessManager } from '../../data/access-manager';
import { REDACTED } from '../../data/redaction';

function svc() {
  const datasets = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r-')), 'd.json'));
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'k-')));
  const backends = new BackendRegistry(); backends.register(new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'c-'))));
  const s = new DataService({ datasets, backends, manager: new AccessManager({ datasets, keys, nodeId: 'n1' }) });
  (s as any).enabledOverride = true; return { s, datasets };
}

test('exportDataset redacts secret-named fields', async () => {
  const { s, datasets } = svc();
  datasets.create({ id: 'ds1', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [] });
  const ctx = { principal: { type: 'local' as const } };
  await s.put(ctx, 'ds1', { id: 'a', fields: { title: 't', apiKey: 'sk-x' } } as any);
  const result = await s.exportDataset(ctx, 'ds1');
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('export failed');
  assert.equal(result.value.length, 1);
  assert.equal(result.value[0].fields.apiKey, REDACTED);
  assert.equal(result.value[0].fields.title, 't');
});

test('syncManifest excludes sensitive datasets, includes non-sensitive syncable ones', async () => {
  const { s, datasets } = svc();
  datasets.create({ id: 'sens', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [], sensitive: true, syncMode: 'full' });
  datasets.create({ id: 'pub', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [], syncMode: 'full' });
  const manifest = s.syncManifest({ type: 'local' });
  const ids = manifest.map(e => e.id);
  assert.ok(!ids.includes('sens'), 'sensitive dataset must not appear in manifest');
  assert.ok(ids.includes('pub'), 'non-sensitive syncMode:full dataset must appear in manifest');
});
