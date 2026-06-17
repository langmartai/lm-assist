import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ensureSystemDatasets, SYSTEM_DATASETS } from '../../data/system-datasets';
import { DatasetRegistry } from '../../data/dataset-registry';

function reg() { return new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sysd-')), 'd.json')); }

test('system datasets: registers knowledge + vectors with the gating ACL, idempotently', () => {
  const r = reg();
  ensureSystemDatasets(r);
  ensureSystemDatasets(r); // second call must not throw or duplicate
  const ids = r.list().map((d) => d.id).sort();
  assert.ok(ids.includes('knowledge'));
  assert.ok(ids.includes('vectors'));

  const k = r.get('knowledge')!;
  assert.equal(k.system, true);
  assert.equal(k.readOnly ?? false, false);  // NOT readOnly (manage must be allowed)
  assert.equal(k.syncMode, 'none');
  // gating: cloud/* gets read/query/search; local gets write/delete/manage
  const star = k.acl.find((a: any) => a.principal === '*');
  const local = k.acl.find((a: any) => a.principal === 'local');
  assert.deepEqual(star?.actions.sort(), ['query', 'read', 'search']);
  assert.ok(local?.actions.includes('manage'));
});

test('system datasets: SYSTEM_DATASETS declares knowledge + vectors backends', () => {
  const byId = Object.fromEntries(SYSTEM_DATASETS.map((s) => [s.id, s.backend]));
  assert.equal(byId.knowledge, 'knowledge');
  assert.equal(byId.vectors, 'vectors');
});
