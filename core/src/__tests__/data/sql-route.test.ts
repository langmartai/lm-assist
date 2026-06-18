import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { DataService } from '../../data/data-service';
import { BackendRegistry } from '../../data/backend-registry';
import { SqlBackend } from '../../data/backends/sql-backend';
import { CacheBackend } from '../../data/backends/cache-backend';
import { DatasetRegistry } from '../../data/dataset-registry';
import { KeyStore } from '../../data/key-store';
import { AccessManager } from '../../data/access-manager';

function svc() {
  const datasets = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-rs-reg-')), 'd.json'));
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-rs-keys-')));
  const backends = new BackendRegistry();
  backends.register(new SqlBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-rs-sql-'))));
  backends.register(new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-rs-cache-'))));
  const manager = new AccessManager({ datasets, keys, nodeId: 'n1' });
  const s = new DataService({ datasets, backends, manager });
  (s as any).enabledOverride = true;
  return { s, datasets };
}

test('rawSql: local SELECT returns redacted rows; cloud is FORBIDDEN; writes/multi rejected; non-sql NOT_SUPPORTED', async () => {
  const { s, datasets } = svc();
  datasets.create({ id: 'sq', backend: 'sql', config: { kind: 'sql' }, acl: [] });
  const local = { principal: { type: 'local' as const } };
  await s.initDataset(local, 'sq');
  await s.put(local, 'sq', { id: 'a', version: 0, fields: { token: 'sk-zzz', topic: 'x' }, createdAt: 't', updatedAt: 't' });

  const ok = await s.rawSql(local, 'sq', 'SELECT json_extract(fields, \'$.topic\') AS topic, fields FROM records', []);
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal((ok.value.rows[0] as any).topic, 'x');
  assert.ok(!JSON.stringify(ok.value.rows).includes('sk-zzz')); // secret-named field redacted in the raw rows too

  // cloud is refused outright
  const cloud = await s.rawSql({ principal: { type: 'cloud', userId: 'u' } }, 'sq', 'SELECT 1', []);
  assert.equal(cloud.ok, false);
  if (cloud.ok) return; assert.equal(cloud.code, 'FORBIDDEN');

  // a write is rejected
  const write = await s.rawSql(local, 'sq', 'DELETE FROM records', []);
  assert.equal(write.ok, false);

  // a non-sql dataset → NOT_SUPPORTED
  datasets.create({ id: 'ch', backend: 'cache', config: { kind: 'cache' }, acl: [] });
  const nonSql = await s.rawSql(local, 'ch', 'SELECT 1', []);
  assert.equal(nonSql.ok, false);
  if (nonSql.ok) return; assert.equal(nonSql.code, 'NOT_SUPPORTED');
});
