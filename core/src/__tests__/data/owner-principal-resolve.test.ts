// core/src/__tests__/data/owner-principal-resolve.test.ts
// T3: hub-relayed cross-node sync reads should be trusted as this node's OWN OWNER —
// the hub's relayApiRequest already verifies caller-owns-target before relaying, so
// x-relay-source:hub on a SYNC-READ route is a trustworthy "my own owner" signal —
// PROVIDED it also arrives over loopback (127.0.0.1), because that is how a GENUINE
// hub relay actually reaches this node: api-relay-handler's makeLocalRequest dispatches
// via hostname:'127.0.0.1' (see makeLocalRequest in hub-client/api-relay-handler.ts).
// Core binds 0.0.0.0, so a non-loopback caller could otherwise just SET x-relay-source:hub
// on a direct request and claim owner trust — the header alone is NOT sufficient, exactly
// the same reasoning that makes the existing `peer` branch require loopback too.
// This resolver (resolveSyncPrincipal) is SYNC-SCOPED ONLY — it must never be confused
// with the general resolvePrincipal (see owner-principal-scoping.test.ts for that proof).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AccessManager } from '../../data/access-manager';
import { DatasetRegistry } from '../../data/dataset-registry';
import { getKeyStore } from '../../data/key-store';

function mgr() {
  return new AccessManager({ datasets: new DatasetRegistry('/tmp/nope-owner-resolve.json'), keys: getKeyStore(), nodeId: 'self' });
}
const req = (headers: Record<string, string>, clientIp?: string) =>
  ({ headers, clientIp } as unknown as import('../../routes/index').ParsedRequest);

test('a hub-relayed sync request over LOOPBACK resolves to an owner principal (the genuine relay path)', () => {
  const p = mgr().resolveSyncPrincipal(req({ 'x-relay-source': 'hub' }, '127.0.0.1'));
  assert.equal(p.type, 'owner');
});

test('a hub-relayed sync request over IPv6 loopback (::1) also resolves to owner', () => {
  const p = mgr().resolveSyncPrincipal(req({ 'x-relay-source': 'hub' }, '::1'));
  assert.equal(p.type, 'owner');
});

// ── THE decisive adversarial test ─────────────────────────────────────────────────
// Core binds 0.0.0.0. A direct, non-loopback caller who simply SETS x-relay-source:hub
// on their own request (bypassing the real relay entirely) must NOT get owner trust —
// it must fall through to resolvePrincipal, which resolves an unrecognized non-loopback
// caller to plain `cloud` (deny-by-default: KEY_REQUIRED on a keyless read).
test('SECURITY: x-relay-source:hub from a NON-LOOPBACK clientIp does NOT yield owner — falls through to cloud', () => {
  const p = mgr().resolveSyncPrincipal(req({ 'x-relay-source': 'hub' }, '10.0.1.50'));
  assert.equal(p.type, 'cloud');
  assert.notEqual(p.type, 'owner' as any);
});

test('SECURITY: x-relay-source:hub with NO clientIp at all does NOT yield owner (undefined is not loopback)', () => {
  const p = mgr().resolveSyncPrincipal(req({ 'x-relay-source': 'hub' }));
  assert.notEqual(p.type, 'owner' as any);
});

test('resolveSyncPrincipal delegates a peer RPC to the normal peer principal (unchanged)', () => {
  const p = mgr().resolveSyncPrincipal(req({ 'x-relay-source': 'peer', 'x-lm-peer-node': 'gw-b' }, '127.0.0.1'));
  assert.equal(p.type, 'peer');
  assert.equal(p.node, 'gw-b');
});

test('resolveSyncPrincipal delegates a plain loopback caller to local (unchanged)', () => {
  const p = mgr().resolveSyncPrincipal(req({}, '127.0.0.1'));
  assert.equal(p.type, 'local');
});

test('resolveSyncPrincipal delegates a plain non-loopback, non-relayed caller to cloud (unchanged)', () => {
  const p = mgr().resolveSyncPrincipal(req({}, '10.0.1.42'));
  assert.equal(p.type, 'cloud');
});

test('CRITICAL: only the literal header value x-relay-source:hub (over loopback) yields owner — near-miss values fall through', () => {
  for (const bogus of ['Hub', 'HUB', 'hub ', ' hub', 'hubx', 'true', '1']) {
    const p = mgr().resolveSyncPrincipal(req({ 'x-relay-source': bogus }, '127.0.0.1'));
    assert.notEqual(p.type, 'owner', `header value ${JSON.stringify(bogus)} must NOT yield owner`);
  }
});

test('CRITICAL: an absent x-relay-source header never yields owner, regardless of other headers or loopback', () => {
  const p = mgr().resolveSyncPrincipal(req({ 'x-lm-user-id': 'someone', 'x-lm-peer-node': 'gw-b' }, '127.0.0.1'));
  assert.notEqual(p.type, 'owner');
});
