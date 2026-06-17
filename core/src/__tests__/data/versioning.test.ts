import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ver-'));
import { isNewer } from '../../data/types';
import { DataService } from '../../data/data-service';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { DatasetRegistry } from '../../data/dataset-registry';
import { KeyStore } from '../../data/key-store';
import { AccessManager } from '../../data/access-manager';

function svc() {
  const datasets = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(),'r-')),'d.json'));
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(),'k-')));
  const backends = new BackendRegistry(); backends.register(new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(),'c-'))));
  const s = new DataService({ datasets, backends, manager: new AccessManager({ datasets, keys, nodeId: 'n1' }) });
  (s as any).enabledOverride = true; return { s, datasets };
}

test('isNewer: version then updatedAt then ownerNode', () => {
  const r = (v:number,u:string,m='a') => ({version:v,updatedAt:u,origin:{machineId:m,hostname:'',os:''}});
  assert.equal(isNewer(r(2,'t'), r(1,'t')), true);
  assert.equal(isNewer(r(1,'t'), r(2,'t')), false);
  assert.equal(isNewer(r(1,'2026-02'), r(1,'2026-01')), true);
  assert.equal(isNewer(r(1,'t','b'), r(1,'t','a')), true);
  assert.equal(isNewer(r(1,'t','a'), r(1,'t','a')), false);
  assert.equal(isNewer(r(1,'t'), null), true);
});

test('put: engine assigns version 1,2,... preserves createdAt, bumps updatedAt', async () => {
  const { s, datasets } = svc();
  datasets.create({ id:'d', backend:'cache', visibility:'local-only', config:{kind:'cache'}, acl:[] });
  const ctx = { principal: { type:'local' as const } };
  const p1 = await s.put(ctx, 'd', { id:'a', fields:{x:1}, createdAt:'ignored', updatedAt:'ignored', version:99 } as any);
  assert.equal(p1.ok, true);
  const g1 = await s.get(ctx, 'd', 'a'); if (!g1.ok || !g1.value) throw new Error('no g1');
  assert.equal(g1.value.version, 1);
  const created = g1.value.createdAt;
  await s.put(ctx, 'd', { id:'a', fields:{x:2} } as any);
  const g2 = await s.get(ctx, 'd', 'a'); if (!g2.ok || !g2.value) throw new Error('no g2');
  assert.equal(g2.value.version, 2);
  assert.equal(g2.value.createdAt, created);          // preserved
  assert.ok(g2.value.updatedAt >= g1.value!.updatedAt); // bumped
});
