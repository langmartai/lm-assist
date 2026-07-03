// core/src/__tests__/data/peer-principal-resolve.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AccessManager } from '../../data/access-manager';
import { DatasetRegistry } from '../../data/dataset-registry';
import { getKeyStore } from '../../data/key-store';

function mgr() {
  return new AccessManager({ datasets: new DatasetRegistry('/tmp/nope-datasets.json'), keys: getKeyStore(), nodeId: 'self' });
}
const req = (headers: Record<string, string>, clientIp?: string) =>
  ({ headers, clientIp } as unknown as import('../../routes/index').ParsedRequest);

test('a loopback peer RPC resolves to a scoped peer principal (NOT local root)', () => {
  const p = mgr().resolvePrincipal(req({ 'x-relay-source': 'peer', 'x-lm-peer-node': 'gw-b' }, '127.0.0.1'));
  assert.equal(p.type, 'peer');
  assert.equal(p.node, 'gw-b');
});

test('a forged x-relay-source:peer from a non-loopback origin falls to cloud (never local/peer)', () => {
  const p = mgr().resolvePrincipal(req({ 'x-relay-source': 'peer', 'x-lm-peer-node': 'gw-b' }, '10.0.1.42'));
  assert.equal(p.type, 'cloud');
});

test('a peer source with no node id is not honored as peer', () => {
  const p = mgr().resolvePrincipal(req({ 'x-relay-source': 'peer' }, '127.0.0.1'));
  assert.notEqual(p.type, 'peer');
});

test('hub relay still resolves to cloud; plain loopback still resolves to local', () => {
  assert.equal(mgr().resolvePrincipal(req({ 'x-relay-source': 'hub' }, '127.0.0.1')).type, 'cloud');
  assert.equal(mgr().resolvePrincipal(req({}, '127.0.0.1')).type, 'local');
});
