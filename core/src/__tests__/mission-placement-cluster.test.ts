// core/src/__tests__/mission-placement-cluster.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { placementAllowed, resolveHostToId } from '../mission/mission-controller';

const recs = [
  { gatewayId: 'gw4-rel', cluster: 'release' },
  { gatewayId: 'gw4-dev', cluster: 'dev' },
];

describe('placementAllowed', () => {
  it('undefined/local/cloud always allowed', () => {
    for (const h of [undefined, 'local', 'cloud'] as const) {
      assert.equal(placementAllowed(h, recs as any, 'gw4-rel', 'release'), true);
    }
  });
  it('in-cluster host allowed; out-of-cluster refused', () => {
    assert.equal(placementAllowed('gw4-rel', recs as any, 'gw4-rel', 'release'), true);
    assert.equal(placementAllowed('gw4-dev', recs as any, 'gw4-rel', 'release'), false);
  });
  it('in-cluster host pinned by hostname is allowed; out-of-cluster hostname refused', () => {
    const recs2 = [
      { gatewayId: 'gw4-rel', cluster: 'release', hostname: 'alpha' },
      { gatewayId: 'gw4-dev', cluster: 'dev', hostname: 'beta' },
    ];
    // hostname 'alpha' maps to gw4-rel which is in cluster 'release' — must be allowed
    assert.equal(placementAllowed('alpha', recs2 as any, 'gw4-rel', 'release'), true);
    // hostname 'beta' maps to gw4-dev which is in cluster 'dev' — must be refused
    assert.equal(placementAllowed('beta', recs2 as any, 'gw4-rel', 'release'), false);
    // gatewayId form still works
    assert.equal(placementAllowed('gw4-rel', recs2 as any, 'gw4-rel', 'release'), true);
    assert.equal(placementAllowed('gw4-dev', recs2 as any, 'gw4-rel', 'release'), false);
  });
});

describe('resolveHostToId', () => {
  const recs3 = [
    { gatewayId: 'gw4-rel', cluster: 'release', hostname: 'alpha' },
    { gatewayId: 'gw4-dev', cluster: 'dev', hostname: 'beta' },
  ];
  it('returns gatewayId unchanged when host is already a gatewayId', () => {
    assert.equal(resolveHostToId('gw4-rel', recs3 as any), 'gw4-rel');
    assert.equal(resolveHostToId('gw4-dev', recs3 as any), 'gw4-dev');
  });
  it('resolves hostname to its gatewayId', () => {
    assert.equal(resolveHostToId('alpha', recs3 as any), 'gw4-rel');
    assert.equal(resolveHostToId('beta', recs3 as any), 'gw4-dev');
  });
  it('returns unknown host unchanged (falls through to default cluster)', () => {
    assert.equal(resolveHostToId('unknown-host', recs3 as any), 'unknown-host');
  });
});
