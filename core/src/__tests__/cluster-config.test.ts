import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clusterName } from '../cluster/cluster-config';

describe('clusterName', () => {
  it('normalizes to lowercase [a-z0-9_-]', () => {
    assert.equal(clusterName('Release'), 'release');
    assert.equal(clusterName('  Dev Box! '), 'dev-box-');
    assert.equal(clusterName('a_b-2'), 'a_b-2');
  });
  it('empty / nullish → default', () => {
    assert.equal(clusterName(''), 'default');
    assert.equal(clusterName('   '), 'default');
    assert.equal(clusterName(null), 'default');
    assert.equal(clusterName(undefined), 'default');
  });
});
