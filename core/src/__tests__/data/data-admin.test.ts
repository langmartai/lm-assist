import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { DataService } from '../../data/data-service';
import { BackendRegistry } from '../../data/backend-registry';
import { DatasetRegistry } from '../../data/dataset-registry';
import { KeyStore } from '../../data/key-store';
import { AccessManager } from '../../data/access-manager';
import type { StorageBackend, BackendKind, DataRecord, QuerySpec, NodeOrigin } from '../../data/types';

// Minimal fake backends to test the service-level admin dispatch in isolation.
// FakeAdminBackend (kind 'cache') HAS admin; FakeNoAdminBackend (kind 'vector') does NOT.
class FakeAdminBackend implements StorageBackend {
  readonly kind: BackendKind = 'cache';
  lastOp: { op: string; args?: Record<string, unknown> } | null = null;
  async createDataset(): Promise<void> {}
  async dropDataset(): Promise<void> {}
  async put(_d: string, r: DataRecord): Promise<{ id: string }> { return { id: r.id }; }
  async get(): Promise<DataRecord | null> { return null; }
  async query(): Promise<{ records: DataRecord[]; total?: number }> { return { records: [], total: 0 }; }
  async delete(): Promise<boolean> { return false; }
  async exportSince(): Promise<DataRecord[]> { return []; }
  async importBatch(_d: string, _r: DataRecord[], _o: NodeOrigin): Promise<{ applied: number; skipped: number }> { return { applied: 0, skipped: 0 }; }
  async admin(_dataset: string, op: string, args?: Record<string, unknown>): Promise<unknown> {
    this.lastOp = { op, args };
    return { ok: true, op, echoed: args, apiKey: 'sk-should-be-redacted' };
  }
}
class FakeNoAdminBackend implements StorageBackend {
  readonly kind: BackendKind = 'vector'; // distinct kind, no admin method
  async createDataset(): Promise<void> {}
  async dropDataset(): Promise<void> {}
  async put(_d: string, r: DataRecord): Promise<{ id: string }> { return { id: r.id }; }
  async get(): Promise<DataRecord | null> { return null; }
  async query(): Promise<{ records: DataRecord[]; total?: number }> { return { records: [], total: 0 }; }
  async delete(): Promise<boolean> { return false; }
  async exportSince(): Promise<DataRecord[]> { return []; }
  async importBatch(_d: string, _r: DataRecord[], _o: NodeOrigin): Promise<{ applied: number; skipped: number }> { return { applied: 0, skipped: 0 }; }
}

function svc() {
  const datasets = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-adm-reg-')), 'd.json'));
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-adm-keys-')));
  const backends = new BackendRegistry();
  const fake = new FakeAdminBackend();
  backends.register(fake);
  backends.register(new FakeNoAdminBackend());
  const manager = new AccessManager({ datasets, keys, nodeId: 'n1' });
  const s = new DataService({ datasets, backends, manager });
  (s as any).enabledOverride = true;
  return { s, datasets, fake };
}

test('data admin: local manage dispatches op, result is redacted', async () => {
  const { s, datasets, fake } = svc();
  datasets.create({ id: 'sysd', backend: 'cache', visibility: 'local-only', system: true,
    config: { kind: 'cache' }, acl: [{ principal: 'local', actions: ['manage'] }] });
  const r = await s.admin({ principal: { type: 'local' } }, 'sysd', 'do-thing', { x: 1 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(fake.lastOp?.op, 'do-thing');
  assert.deepEqual(fake.lastOp?.args, { x: 1 });
  // admin RESULT is redaction-swept
  assert.equal((r.value as any).apiKey, '«redacted»');
  assert.equal((r.value as any).ok, true);
});

test('data admin: cloud without a manage key is denied (not dispatched)', async () => {
  const { s, datasets, fake } = svc();
  datasets.create({ id: 'sysd', backend: 'cache', visibility: 'cross-node-readable', system: true,
    config: { kind: 'cache' }, acl: [{ principal: '*', actions: ['read'] }, { principal: 'local', actions: ['manage'] }] });
  const denied = await s.admin({ principal: { type: 'cloud', userId: 'u' } }, 'sysd', 'do-thing');
  assert.equal(denied.ok, false);
  assert.equal(fake.lastOp, null); // never dispatched
});

test('data admin: backend without admin() returns NOT_SUPPORTED', async () => {
  const { s, datasets } = svc();
  // 'plain' uses backend 'vector' -> FakeNoAdminBackend, which has no admin method.
  datasets.create({ id: 'plain', backend: 'vector', visibility: 'local-only',
    config: { kind: 'vector' }, acl: [] });
  const r = await s.admin({ principal: { type: 'local' } }, 'plain', 'noop');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'NOT_SUPPORTED');
});
