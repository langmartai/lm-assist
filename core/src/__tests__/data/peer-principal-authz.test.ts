// core/src/__tests__/data/peer-principal-authz.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AccessManager } from '../../data/access-manager';
import { DatasetRegistry } from '../../data/dataset-registry';
import { getKeyStore } from '../../data/key-store';
import type { DatasetDescriptor, Principal } from '../../data/types';

function mgr() {
  return new AccessManager({ datasets: new DatasetRegistry('/tmp/nope-authz.json'), keys: getKeyStore(), nodeId: 'self' });
}
const ds = (over: Partial<DatasetDescriptor>): DatasetDescriptor => ({
  id: 'd', backend: 'cache', ownerNode: 'self', visibility: 'cross-node-readable',
  syncMode: 'full', config: { kind: 'cache' }, acl: [], createdAt: '', updatedAt: '', ...over,
});
const peer: Principal = { type: 'peer', node: 'gw-b' };

test('peer may READ a shareable, non-sensitive dataset — no key needed', async () => {
  const r = await mgr().enforce(peer, undefined, ds({ visibility: 'cross-node-readable' }), 'read');
  assert.equal(r.ok, true);
  assert.deepEqual(mgr().evaluateGrants(peer, ds({ visibility: 'synced' }), ['read', 'query', 'search']).sort(), ['query', 'read', 'search']);
});

test('peer CANNOT read a local-only dataset', async () => {
  const r = await mgr().enforce(peer, undefined, ds({ visibility: 'local-only' }), 'read');
  assert.equal(r.ok, false);
  assert.deepEqual(mgr().evaluateGrants(peer, ds({ visibility: 'local-only' }), ['read']), []);
});

test('peer CANNOT read a sensitive dataset even if cross-node-readable', async () => {
  const r = await mgr().enforce(peer, undefined, ds({ sensitive: true }), 'read');
  assert.equal(r.ok, false);
  assert.deepEqual(mgr().evaluateGrants(peer, ds({ sensitive: true }), ['read']), []);
});

test('peer CANNOT write / delete / manage a shareable dataset (read-only)', async () => {
  for (const action of ['write', 'delete', 'manage'] as const) {
    const r = await mgr().enforce(peer, undefined, ds({}), action);
    assert.equal(r.ok, false, `peer must be denied ${action}`);
  }
  assert.deepEqual(mgr().evaluateGrants(peer, ds({}), ['write', 'delete', 'manage']), []);
});

test('a peer presenting a (bogus) key still cannot exceed read-only-shareable', async () => {
  const r = await mgr().enforce(peer, 'someid.somesecret', ds({}), 'write');
  assert.equal(r.ok, false); // peer branch decided BEFORE the key branch
});

// Addition beyond the brief's 5 tests: the case above uses a BOGUS key (never even looked up).
// Adversarial review needs the stronger claim proven too — that a REAL, validly-minted key
// which legitimately grants 'write' on this exact dataset STILL cannot escalate a peer, because
// the peer branch returns before the key branch is ever reached (the key is never consulted).
test('a peer presenting a REAL key that legitimately grants write still cannot escalate', async () => {
  const crypto = require('crypto');
  const keys = getKeyStore();
  const datasets = new DatasetRegistry('/tmp/nope-authz.json');
  const manager = new AccessManager({ datasets, keys, nodeId: 'self' });
  const d = ds({ id: 'escalate-check' });
  const secret = 'real-write-secret';
  const keyId = 'escalate-key';
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
  // Sanity: the SAME key, presented by a CLOUD principal, actually works (proves it's a real grant,
  // not a dud — so denial for the peer below is the peer branch acting, not a broken key).
  const asCloud = await manager.enforce({ type: 'cloud', userId: 'u1' }, realKey, d, 'write');
  assert.equal(asCloud.ok, true, 'sanity check: the key must be genuinely valid for cloud');
  // The identical key, presented by a peer, must still be denied write.
  const asPeer = await manager.enforce(peer, realKey, d, 'write');
  assert.equal(asPeer.ok, false);
  assert.equal(asPeer.ok ? '' : asPeer.code, 'PEER_READ_ONLY'); // denied by the peer branch, not a key check
});
