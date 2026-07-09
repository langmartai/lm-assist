// core/src/__tests__/data/owner-principal-authz.test.ts
// T3: the `owner` principal (hub-relayed sync-read, trusted as this node's own owner)
// must have IDENTICAL capabilities to the existing `peer` principal — read-only,
// shareable + non-sensitive datasets only, no key required or consulted.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AccessManager } from '../../data/access-manager';
import { DatasetRegistry } from '../../data/dataset-registry';
import { getKeyStore } from '../../data/key-store';
import type { DatasetDescriptor, Principal } from '../../data/types';

function mgr() {
  return new AccessManager({ datasets: new DatasetRegistry('/tmp/nope-owner-authz.json'), keys: getKeyStore(), nodeId: 'self' });
}
const ds = (over: Partial<DatasetDescriptor>): DatasetDescriptor => ({
  id: 'd', backend: 'cache', ownerNode: 'self', visibility: 'cross-node-readable',
  syncMode: 'full', config: { kind: 'cache' }, acl: [], createdAt: '', updatedAt: '', ...over,
});
const owner: Principal = { type: 'owner' };
const peer: Principal = { type: 'peer', node: 'gw-b' };

test('owner may READ a shareable, non-sensitive dataset — no key needed', async () => {
  const r = await mgr().enforce(owner, undefined, ds({ visibility: 'cross-node-readable' }), 'read');
  assert.equal(r.ok, true);
  assert.deepEqual(mgr().evaluateGrants(owner, ds({ visibility: 'synced' }), ['read', 'query', 'search']).sort(), ['query', 'read', 'search']);
});

test('owner CANNOT read a local-only dataset', async () => {
  const r = await mgr().enforce(owner, undefined, ds({ visibility: 'local-only' }), 'read');
  assert.equal(r.ok, false);
  assert.deepEqual(mgr().evaluateGrants(owner, ds({ visibility: 'local-only' }), ['read']), []);
});

test('owner CANNOT read a sensitive dataset even if cross-node-readable', async () => {
  const r = await mgr().enforce(owner, undefined, ds({ sensitive: true }), 'read');
  assert.equal(r.ok, false);
  assert.deepEqual(mgr().evaluateGrants(owner, ds({ sensitive: true }), ['read']), []);
});

test('owner CANNOT write / delete / manage a shareable dataset (read-only)', async () => {
  for (const action of ['write', 'delete', 'manage'] as const) {
    const r = await mgr().enforce(owner, undefined, ds({}), action);
    assert.equal(r.ok, false, `owner must be denied ${action}`);
  }
  assert.deepEqual(mgr().evaluateGrants(owner, ds({}), ['write', 'delete', 'manage']), []);
});

test('an owner presenting a (bogus) key still cannot exceed read-only-shareable', async () => {
  const r = await mgr().enforce(owner, 'someid.somesecret', ds({}), 'write');
  assert.equal(r.ok, false); // owner branch decided BEFORE the key branch
});

// Mirrors the peer escalation-proof test: a REAL, validly-minted key that legitimately
// grants 'write' on this exact dataset still cannot escalate an owner principal, because
// the owner branch returns before the key branch is ever reached (the key is never consulted).
test('an owner presenting a REAL key that legitimately grants write still cannot escalate', async () => {
  const crypto = require('crypto');
  const keys = getKeyStore();
  const datasets = new DatasetRegistry('/tmp/nope-owner-authz.json');
  const manager = new AccessManager({ datasets, keys, nodeId: 'self' });
  const d = ds({ id: 'owner-escalate-check' });
  const secret = 'real-write-secret-owner';
  const keyId = 'owner-escalate-key';
  await keys.put({
    keyId,
    secretHash: crypto.createHash('sha256').update(secret).digest('hex'),
    principalType: 'cloud',
    principalId: 'u1',
    node: 'self',
    grants: [{ dataset: d.id, actions: ['write', 'delete', 'manage'] }], // genuinely broad grant
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const realKey = `${keyId}.${secret}`;
  const asCloud = await manager.enforce({ type: 'cloud', userId: 'u1' }, realKey, d, 'write');
  assert.equal(asCloud.ok, true, 'sanity check: the key must be genuinely valid for cloud');
  const asOwner = await manager.enforce(owner, realKey, d, 'write');
  assert.equal(asOwner.ok, false);
});

// ── owner == peer: identical capability proof ────────────────────────────────────
// The brief requires the owner branches be IDENTICAL to the peer branches. Prove it
// directly: for every (visibility, sensitive, action) combination, owner and peer must
// agree exactly on both evaluateGrants and enforce.
test('owner and peer have IDENTICAL evaluateGrants results across the full combination matrix', () => {
  const visibilities: DatasetDescriptor['visibility'][] = ['local-only', 'synced', 'cross-node-readable'];
  const sensitivities = [false, true];
  const actionSets: Array<Array<'read' | 'query' | 'search' | 'write' | 'delete' | 'manage'>> = [
    ['read'], ['query'], ['search'], ['write'], ['delete'], ['manage'],
    ['read', 'query', 'search', 'write', 'delete', 'manage'],
  ];
  const m = mgr();
  for (const visibility of visibilities) {
    for (const sensitive of sensitivities) {
      for (const actions of actionSets) {
        const d = ds({ visibility, sensitive });
        const ownerResult = m.evaluateGrants(owner, d, actions).sort();
        const peerResult = m.evaluateGrants(peer, d, actions).sort();
        assert.deepEqual(
          ownerResult, peerResult,
          `mismatch for visibility=${visibility} sensitive=${sensitive} actions=${actions.join(',')}: owner=${JSON.stringify(ownerResult)} peer=${JSON.stringify(peerResult)}`,
        );
      }
    }
  }
});

test('owner and peer have IDENTICAL enforce() outcomes across the full combination matrix', async () => {
  const visibilities: DatasetDescriptor['visibility'][] = ['local-only', 'synced', 'cross-node-readable'];
  const sensitivities = [false, true];
  const actions: Array<'read' | 'query' | 'search' | 'write' | 'delete' | 'manage'> =
    ['read', 'query', 'search', 'write', 'delete', 'manage'];
  const m = mgr();
  for (const visibility of visibilities) {
    for (const sensitive of sensitivities) {
      for (const action of actions) {
        const d = ds({ visibility, sensitive, id: `matrix-${visibility}-${sensitive}-${action}` });
        const ownerResult = await m.enforce(owner, undefined, d, action);
        const peerResult = await m.enforce(peer, undefined, d, action);
        assert.equal(
          ownerResult.ok, peerResult.ok,
          `ok mismatch for visibility=${visibility} sensitive=${sensitive} action=${action}: owner.ok=${ownerResult.ok} peer.ok=${peerResult.ok}`,
        );
        if (!ownerResult.ok && !peerResult.ok) {
          assert.equal(
            ownerResult.code, peerResult.code,
            `code mismatch for visibility=${visibility} sensitive=${sensitive} action=${action}: owner=${ownerResult.code} peer=${peerResult.code}`,
          );
        }
      }
    }
  }
});
