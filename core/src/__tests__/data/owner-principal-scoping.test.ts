// core/src/__tests__/data/owner-principal-scoping.test.ts
// T3 — THE key security test. Adversarial premise: could `owner` trust leak into the
// GENERAL data routes (get/put/query/delete/catalog/access/sql/sync-trigger) or the
// connector /mcp path, both of which resolve principals via `resolvePrincipal` (NOT
// `resolveSyncPrincipal`)? This file proves it cannot, two ways:
//   1. `resolvePrincipal` is byte-for-byte UNCHANGED for every input combination that
//      matters (hub/peer/local/cloud) — i.e. it still yields 'cloud' for a hub-relayed
//      request, never 'owner'.
//   2. A dataset an `owner` COULD export via the sync-read path is still denied to the
//      identical hub-relayed request when routed through the GENERAL resolver + a
//      general (non-sync) action — i.e. owner-trust does not widen general capability.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AccessManager } from '../../data/access-manager';
import { DatasetRegistry } from '../../data/dataset-registry';
import { getKeyStore } from '../../data/key-store';
import type { DatasetDescriptor } from '../../data/types';

function mgr() {
  return new AccessManager({ datasets: new DatasetRegistry('/tmp/nope-owner-scoping.json'), keys: getKeyStore(), nodeId: 'self' });
}
const req = (headers: Record<string, string>, clientIp?: string) =>
  ({ headers, clientIp } as unknown as import('../../routes/index').ParsedRequest);
const ds = (over: Partial<DatasetDescriptor>): DatasetDescriptor => ({
  id: 'd', backend: 'cache', ownerNode: 'self', visibility: 'cross-node-readable',
  syncMode: 'full', config: { kind: 'cache' }, acl: [], createdAt: '', updatedAt: '', ...over,
});

// ── 1. resolvePrincipal is byte-for-byte unchanged ────────────────────────────────

test('resolvePrincipal(hub-relayed) STILL resolves to cloud, never owner — the general resolver is untouched', () => {
  const p = mgr().resolvePrincipal(req({ 'x-relay-source': 'hub', 'x-lm-user-id': 'u1' }, '10.0.1.42'));
  assert.equal(p.type, 'cloud');
  assert.equal((p as any).userId, 'u1');
  assert.notEqual(p.type, 'owner' as any);
});

test('resolvePrincipal(hub-relayed, no user id) STILL resolves to cloud with userId undefined', () => {
  const p = mgr().resolvePrincipal(req({ 'x-relay-source': 'hub' }, '10.0.1.42'));
  assert.equal(p.type, 'cloud');
  assert.equal((p as any).userId, undefined);
});

test('resolvePrincipal(peer RPC, loopback) is unchanged — still resolves to peer', () => {
  const p = mgr().resolvePrincipal(req({ 'x-relay-source': 'peer', 'x-lm-peer-node': 'gw-b' }, '127.0.0.1'));
  assert.equal(p.type, 'peer');
  assert.equal(p.node, 'gw-b');
});

test('resolvePrincipal(peer RPC forged from non-loopback) is unchanged — still falls to cloud', () => {
  const p = mgr().resolvePrincipal(req({ 'x-relay-source': 'peer', 'x-lm-peer-node': 'gw-b' }, '10.0.1.42'));
  assert.equal(p.type, 'cloud');
});

test('resolvePrincipal(plain loopback, no headers) is unchanged — still resolves to local', () => {
  const p = mgr().resolvePrincipal(req({}, '127.0.0.1'));
  assert.equal(p.type, 'local');
});

test('resolvePrincipal(plain non-loopback, no headers) is unchanged — still resolves to cloud', () => {
  const p = mgr().resolvePrincipal(req({}, '10.0.1.42'));
  assert.equal(p.type, 'cloud');
});

// ── 2. owner-trust does not leak into the general path ────────────────────────────

test('a hub-relayed request routed through the GENERAL resolver + a general write action is denied — owner-trust does not leak to writes/general routes', async () => {
  const m = mgr();
  // Loopback: this is exactly how a GENUINE hub relay arrives (api-relay-handler's
  // makeLocalRequest dials hostname:'127.0.0.1') — using the SAME request object for both
  // resolvers below is the point: one request, two different resolution paths.
  const hubReq = req({ 'x-relay-source': 'hub' }, '127.0.0.1');
  // This is what happens on every OTHER route (get/put/query/delete/catalog/access/sql/sync-trigger,
  // and the connector /mcp path): resolvePrincipal (NOT resolveSyncPrincipal).
  const generalPrincipal = m.resolvePrincipal(hubReq);
  assert.equal(generalPrincipal.type, 'cloud'); // confirm it's the keyless-cloud path

  const shareable = ds({ visibility: 'cross-node-readable', acl: [] }); // no ACL granted to cloud
  // Read via the general principal without a key must be denied (KEY_REQUIRED) — the same
  // dataset that an `owner` principal (via resolveSyncPrincipal) could freely read on the
  // 4 sync routes is NOT freely readable through the general path.
  const generalRead = await m.enforce(generalPrincipal, undefined, shareable, 'read');
  assert.equal(generalRead.ok, false);
  assert.equal(generalRead.ok ? '' : generalRead.code, 'KEY_REQUIRED');

  // Meanwhile the SAME dataset IS freely readable by the sync-scoped owner principal —
  // proving the two paths behave differently by design, not by accident.
  const syncPrincipal = m.resolveSyncPrincipal(hubReq);
  assert.equal(syncPrincipal.type, 'owner');
  const syncRead = await m.enforce(syncPrincipal, undefined, shareable, 'read');
  assert.equal(syncRead.ok, true);
});

test('a hub-relayed request cannot write via the general resolver even though owner is grantable via resolveSyncPrincipal', async () => {
  const m = mgr();
  const hubReq = req({ 'x-relay-source': 'hub' }, '127.0.0.1'); // loopback — the genuine relay path
  const generalPrincipal = m.resolvePrincipal(hubReq); // cloud
  const d = ds({ visibility: 'cross-node-readable', acl: [{ principal: 'cloud', actions: ['read', 'write'] }] });

  // Even with an ACL that WOULD grant cloud write (if keyed), a keyless cloud caller is denied.
  const generalWrite = await m.enforce(generalPrincipal, undefined, d, 'write');
  assert.equal(generalWrite.ok, false);

  // And the owner principal (sync-scoped) is read-only regardless — confirms owner can never write.
  const syncPrincipal = m.resolveSyncPrincipal(hubReq);
  const ownerWrite = await m.enforce(syncPrincipal, undefined, d, 'write');
  assert.equal(ownerWrite.ok, false);
});

// ── 3. loopback-spoof boundary — a direct non-loopback caller cannot forge owner trust ──
// Core binds 0.0.0.0. A genuine hub relay always arrives over loopback (api-relay-handler's
// makeLocalRequest dials hostname:'127.0.0.1'). If resolveSyncPrincipal trusted the header
// alone, a non-loopback attacker hitting this node's port directly could set
// x-relay-source:hub themselves and claim owner trust on a shareable dataset with no key —
// this is the loopback guard that closes that hole (mirrors the existing `peer` guard).

test('SECURITY: a direct non-loopback caller cannot forge owner trust by setting x-relay-source:hub — resolves to cloud and is denied a keyless read', async () => {
  const m = mgr();
  const spoofed = req({ 'x-relay-source': 'hub' }, '10.0.1.50'); // NOT loopback — never touched the relay
  const p = m.resolveSyncPrincipal(spoofed);
  assert.equal(p.type, 'cloud'); // NOT owner
  assert.notEqual(p.type, 'owner' as any);

  const shareable = ds({ visibility: 'cross-node-readable', acl: [] });
  const read = await m.enforce(p, undefined, shareable, 'read');
  assert.equal(read.ok, false, 'a spoofed hub header from a non-loopback origin must be denied a keyless read');
  assert.equal(read.ok ? '' : read.code, 'KEY_REQUIRED');
});

// ── 4. PrincipalType surface — 'owner' must exist without breaking the existing union ──

test('the owner PrincipalType is additive: cloud/local/peer resolution and enforcement paths are all still reachable and correct', () => {
  const m = mgr();
  assert.equal(m.resolvePrincipal(req({}, '127.0.0.1')).type, 'local');
  assert.equal(m.resolvePrincipal(req({ 'x-relay-source': 'hub' }, '127.0.0.1')).type, 'cloud');
  assert.equal(m.resolvePrincipal(req({ 'x-relay-source': 'peer', 'x-lm-peer-node': 'x' }, '127.0.0.1')).type, 'peer');
  assert.equal(m.resolvePrincipal(req({}, '10.0.1.5')).type, 'cloud');
});
