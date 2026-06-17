import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { DatasetRegistry } from '../../data/dataset-registry';
import type { NodeOrigin } from '../../data/types';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-reg-'));
  return path.join(dir, 'datasets.json');
}

const PEER_ORIGIN: NodeOrigin = {
  machineId: 'peer-machine-123',
  hostname: 'peer-host',
  os: 'linux',
};

test('registry: syncMode persists with default "none"', () => {
  const file = tmpFile();
  const r = new DatasetRegistry(file);

  // Create without explicit syncMode
  const d1 = r.create({ id: 'ds1', backend: 'cache', config: { kind: 'cache' } });
  assert.equal(d1.syncMode, 'none', 'default syncMode should be "none"');

  // Create with explicit syncMode
  const d2 = r.create({ id: 'ds2', backend: 'cache', syncMode: 'full', config: { kind: 'cache' } });
  assert.equal(d2.syncMode, 'full', 'explicit syncMode should be persisted');

  // Fresh instance reads both
  const r2 = new DatasetRegistry(file);
  assert.equal(r2.get('ds1')?.syncMode, 'none', 'syncMode persists across instances');
  assert.equal(r2.get('ds2')?.syncMode, 'full', 'explicit syncMode persists');
});

test('registry: upsertReplica registers a read-only origin-stamped replica', () => {
  const file = tmpFile();
  const r = new DatasetRegistry(file);

  const replica = r.upsertReplica({
    id: 'remote-ds',
    backend: 'vector',
    ownerNode: PEER_ORIGIN.machineId,
    syncMode: 'full',
    config: { kind: 'vector' },
    origin: PEER_ORIGIN,
    title: 'Remote Dataset',
  });

  // Verify the replica has expected properties
  assert.equal(replica.id, 'remote-ds');
  assert.equal(replica.backend, 'vector');
  assert.equal(replica.ownerNode, PEER_ORIGIN.machineId, 'ownerNode should be the peer node');
  assert.equal(replica.syncMode, 'full');
  assert.deepEqual(replica.origin, PEER_ORIGIN, 'origin should be set');
  assert.equal(replica.system, undefined, 'system should not be set');
  assert.deepEqual(replica.acl, [], 'acl should be empty for replica');
  assert.equal(replica.title, 'Remote Dataset');
});

test('registry: upsertReplica includes replica in list and get', () => {
  const file = tmpFile();
  const r = new DatasetRegistry(file);

  r.upsertReplica({
    id: 'rep1',
    backend: 'cache',
    ownerNode: 'peer1',
    syncMode: 'full',
    config: { kind: 'cache' },
    origin: PEER_ORIGIN,
  });

  // list() includes the replica
  const all = r.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 'rep1');
  assert.deepEqual(all[0].origin, PEER_ORIGIN);

  // get() retrieves the replica
  const retrieved = r.get('rep1');
  assert.equal(retrieved?.id, 'rep1');
  assert.deepEqual(retrieved?.origin, PEER_ORIGIN);
});

test('registry: upsertReplica replaces on repeat (idempotent)', () => {
  const file = tmpFile();
  const r = new DatasetRegistry(file);

  // First upsert
  const rep1 = r.upsertReplica({
    id: 'rep-x',
    backend: 'cache',
    ownerNode: 'peer1',
    syncMode: 'none',
    config: { kind: 'cache' },
    origin: PEER_ORIGIN,
  });
  assert.equal(rep1.syncMode, 'none');

  // Second upsert with same id but different syncMode
  const rep2 = r.upsertReplica({
    id: 'rep-x',
    backend: 'cache',
    ownerNode: 'peer1',
    syncMode: 'full',
    config: { kind: 'cache' },
    origin: PEER_ORIGIN,
  });
  assert.equal(rep2.syncMode, 'full', 'upsert should replace with new syncMode');

  // Only one entry in the list
  const all = r.list();
  assert.equal(all.length, 1, 'should have exactly one replica');
  assert.equal(all[0].syncMode, 'full', 'replaced replica has new syncMode');
});

test('registry: defensive copies on upsertReplica (mutation isolation)', () => {
  const file = tmpFile();
  const r = new DatasetRegistry(file);

  const input = {
    id: 'rep-defensive',
    backend: 'cache' as const,
    ownerNode: 'peer',
    syncMode: 'full' as const,
    config: { kind: 'cache' as const },
    origin: PEER_ORIGIN,
  };

  const returned = r.upsertReplica(input);

  // Mutate the returned descriptor
  (returned as any).syncMode = 'none';
  returned.title = 'MUTATED';

  // Verify the stored copy is unchanged
  const retrieved = r.get('rep-defensive');
  assert.equal(retrieved?.syncMode, 'full', 'stored copy should be unaffected by mutation');
  assert.equal(retrieved?.title, undefined, 'stored copy should not have mutated title');
});

test('registry: mixing local datasets and replicas', () => {
  const file = tmpFile();
  const r = new DatasetRegistry(file);

  // Create a local dataset (no origin)
  const local = r.create({
    id: 'local-ds',
    backend: 'cache',
    config: { kind: 'cache' },
  });
  assert.equal(local.origin, undefined, 'local dataset should not have origin');

  // Add a replica
  const replica = r.upsertReplica({
    id: 'remote-ds',
    backend: 'cache',
    ownerNode: 'peer',
    syncMode: 'full',
    config: { kind: 'cache' },
    origin: PEER_ORIGIN,
  });
  assert.deepEqual(replica.origin, PEER_ORIGIN);

  // Both are in the list
  const all = r.list();
  assert.equal(all.length, 2);

  // Identify by origin
  const locals = all.filter((d) => !d.origin);
  const remotes = all.filter((d) => d.origin);
  assert.equal(locals.length, 1);
  assert.equal(remotes.length, 1);
});
