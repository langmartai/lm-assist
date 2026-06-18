import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { FileBackend } from '../../data/backends/file-backend';
import type { DatasetDescriptor } from '../../data/types';

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-file-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}
function desc(id: string, p: string, format: 'json' | 'log', maxLines?: number): DatasetDescriptor {
  return { id, backend: 'file', ownerNode: 'n', visibility: 'cross-node-readable', readOnly: true, system: true,
    config: { kind: 'file', path: p, format, ...(maxLines ? { maxLines } : {}) }, acl: [], createdAt: 't', updatedAt: 't' };
}
function backend(d: DatasetDescriptor): FileBackend {
  return new FileBackend((id) => (id === d.id ? d : undefined));
}

test('file backend: json OBJECT store → one record per key, scrubbed', async () => {
  const p = tmpFile('store.json', JSON.stringify({ a: { name: 'alice', apiKey: 'sk-secret123456789012' }, b: { name: 'bob' } }));
  const d = desc('fs1', p, 'json');
  const be = backend(d);
  const got = await be.get('fs1', 'a');
  assert.equal(got?.fields.name, 'alice');
  assert.equal(got?.fields.apiKey, '«redacted»'); // secret-named field scrubbed on read
  const all = await be.query('fs1', {});
  assert.deepEqual(all.records.map((r) => r.id).sort(), ['a', 'b']);
});

test('file backend: json ARRAY → one record per index', async () => {
  const p = tmpFile('arr.json', JSON.stringify([{ id: 'x', v: 1 }, { v: 2 }]));
  const d = desc('fs2', p, 'json');
  const be = backend(d);
  const all = await be.query('fs2', {});
  assert.equal(all.records.length, 2);
  // an item with its own id uses it; otherwise the index
  assert.ok(all.records.some((r) => r.id === 'x'));
  assert.ok(all.records.some((r) => r.id === '1'));
});

test('file backend: missing file → empty (no throw on read)', async () => {
  const d = desc('fs3', '/no/such/file.json', 'json');
  const be = backend(d);
  assert.equal(await be.get('fs3', 'a'), null);
  assert.deepEqual((await be.query('fs3', {})).records, []);
});

test('file backend: mutate/admin/search are NOT_SUPPORTED; sync throws', async () => {
  const p = tmpFile('s.json', '{}');
  const be = backend(desc('fs4', p, 'json'));
  await assert.rejects(() => be.put('fs4', { id: 'a', version: 0, fields: {}, createdAt: 't', updatedAt: 't' }), /NOT_SUPPORTED/);
  await assert.rejects(() => be.delete('fs4', 'a'), /NOT_SUPPORTED/);
  await assert.rejects(() => be.exportSince('fs4'), /SYNC_NOT_SUPPORTED/);
});

test('file backend: createDataset refuses a hard-excluded credential path', async () => {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  const d = desc('fsbad', credPath, 'json');
  const be = backend(d);
  await assert.rejects(() => be.createDataset(d), /excluded|forbidden/i);
});

test('file backend: log format → one record per line, tailed, with inline secrets scrubbed', async () => {
  const lines = [];
  for (let i = 0; i < 10; i++) lines.push(`line ${i}`);
  lines.push('oops authorization: Bearer leaktoken9999');
  const p = tmpFile('app.log', lines.join('\n') + '\n');
  const d = desc('lg1', p, 'log', 5); // tail last 5
  const be = backend(d);
  const all = await be.query('lg1', {});
  assert.equal(all.records.length, 5);                  // tailed to maxLines
  assert.ok(all.records.every((r) => typeof r.text === 'string'));
  const leak = all.records.find((r) => /authorization/i.test(String(r.text)));
  assert.ok(leak);
  assert.ok(!String(leak!.text).includes('leaktoken9999')); // inline secret scrubbed
});

test('file backend: log get by line id', async () => {
  const p = tmpFile('b.log', 'alpha\nbeta\ngamma\n');
  const be = backend(desc('lg2', p, 'log'));
  const all = await be.query('lg2', {});
  const first = all.records[0];
  const got = await be.get('lg2', first.id);
  assert.equal(got?.text, first.text);
});
