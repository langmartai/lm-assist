import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { DatasetRegistry } from '../../data/dataset-registry';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-reg-'));
  return path.join(dir, 'datasets.json');
}

test('registry: create, get, list, persists across instances', () => {
  const file = tmpFile();
  const r = new DatasetRegistry(file);
  const d = r.create({ id: 'tickets', backend: 'cache', config: { kind: 'cache' } });
  assert.equal(d.id, 'tickets');
  assert.equal(d.visibility, 'local-only'); // default
  assert.equal(d.ownerNode.length > 0, true);
  assert.equal(r.get('tickets')?.backend, 'cache');
  // a fresh instance reads the same file
  const r2 = new DatasetRegistry(file);
  assert.equal(r2.list().length, 1);
  assert.equal(r2.get('tickets')?.id, 'tickets');
});

test('registry: rejects bad ids and duplicates', () => {
  const r = new DatasetRegistry(tmpFile());
  assert.throws(() => r.create({ id: 'Bad Id', backend: 'cache', config: { kind: 'cache' } }), /id/i);
  assert.throws(() => r.create({ id: '../escape', backend: 'cache', config: { kind: 'cache' } }), /id/i);
  r.create({ id: 'ok', backend: 'cache', config: { kind: 'cache' } });
  assert.throws(() => r.create({ id: 'ok', backend: 'cache', config: { kind: 'cache' } }), /exists/i);
});

test('registry: update and drop', () => {
  const r = new DatasetRegistry(tmpFile());
  r.create({ id: 'd', backend: 'cache', config: { kind: 'cache' } });
  const u = r.update('d', { visibility: 'synced', readOnly: true });
  assert.equal(u.visibility, 'synced');
  assert.equal(u.readOnly, true);
  assert.equal(r.drop('d'), true);
  assert.equal(r.get('d'), undefined);
  assert.equal(r.drop('d'), false);
});
