// core/src/__tests__/data/dataset-scope.test.ts  (node:test; create() is SYNC, returns DatasetDescriptor)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatasetRegistry } from '../../data/dataset-registry';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';

describe('dataset scope', () => {
  it('defaults to cluster and round-trips fleet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-scope-'));
    const reg = new DatasetRegistry(path.join(dir, 'reg.json'));
    const a = reg.create({ id: 'plain', backend: 'cache', ownerNode: 'n1', visibility: 'private', config: { kind: 'cache' } } as any);
    const b = reg.create({ id: 'shared', backend: 'cache', ownerNode: 'n1', visibility: 'private', scope: 'fleet', config: { kind: 'cache' } } as any);
    assert.equal(a.scope, 'cluster');
    assert.equal(b.scope, 'fleet');
  });
});
