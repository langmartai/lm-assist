// core/src/__tests__/mission-placement-cluster.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { placementAllowed } from '../mission/mission-controller';

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
});
