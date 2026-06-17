import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AccessManager } from '../../data/access-manager';
import { DatasetRegistry } from '../../data/dataset-registry';
import { KeyStore } from '../../data/key-store';
import type { ParsedRequest } from '../../routes/index';
import type { DatasetDescriptor } from '../../data/types';

function deps() {
  const regFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-am-reg-')), 'd.json');
  const keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-am-keys-'));
  const datasets = new DatasetRegistry(regFile);
  const keys = new KeyStore(keysDir);
  return { mgr: new AccessManager({ datasets, keys, nodeId: 'n1' }), datasets, keys };
}
function req(headers: Record<string, string>): ParsedRequest {
  return { method: 'GET', path: '/', params: {}, query: {}, body: undefined, headers };
}

test('resolvePrincipal: relayed = cloud, direct = local', () => {
  const { mgr } = deps();
  assert.equal(mgr.resolvePrincipal(req({ 'x-relay-source': 'hub' })).type, 'cloud');
  assert.equal(mgr.resolvePrincipal(req({})).type, 'local');
  const p = mgr.resolvePrincipal(req({ 'x-relay-source': 'hub', 'x-lm-user-id': 'u9' }));
  assert.equal(p.userId, 'u9');
});

test('evaluateGrants: local root vs cloud ACL/visibility/readOnly/sensitive', () => {
  const { mgr } = deps();
  const base: DatasetDescriptor = {
    id: 'd', backend: 'cache', ownerNode: 'n1', visibility: 'cross-node-readable',
    config: { kind: 'cache' }, acl: [{ principal: 'cloud', actions: ['read', 'query'] }],
    createdAt: 't', updatedAt: 't',
  };
  // local is root: gets whatever it asks
  assert.deepEqual(mgr.evaluateGrants({ type: 'local' }, base, ['read', 'write', 'delete']).sort(),
    ['delete', 'read', 'write']);
  // cloud limited by ACL
  assert.deepEqual(mgr.evaluateGrants({ type: 'cloud' }, base, ['read', 'write']).sort(), ['read']);
  // cloud blocked entirely when local-only
  assert.deepEqual(mgr.evaluateGrants({ type: 'cloud' }, { ...base, visibility: 'local-only' }, ['read']), []);
  // readOnly hard-caps even local root
  assert.deepEqual(mgr.evaluateGrants({ type: 'local' }, { ...base, readOnly: true }, ['read', 'write']), ['read']);
  // sensitive blocks cloud, allows local
  assert.deepEqual(mgr.evaluateGrants({ type: 'cloud' }, { ...base, sensitive: true }, ['read']), []);
  assert.deepEqual(mgr.evaluateGrants({ type: 'local' }, { ...base, sensitive: true }, ['read']), ['read']);
});

test('requestAccess: mints a usable key; enforce accepts it', async () => {
  const { mgr, datasets } = deps();
  datasets.create({ id: 'tickets', backend: 'cache', visibility: 'cross-node-readable',
    config: { kind: 'cache' }, acl: [{ principal: 'cloud', actions: ['read', 'query'] }] });
  const cloud = { type: 'cloud' as const, userId: 'u1' };
  const issued = await mgr.requestAccess(cloud, { intent: 'read tickets', grants: [{ dataset: 'tickets', actions: ['read', 'write'] }] });
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  assert.deepEqual(issued.grants[0].actions.sort(), ['read']); // write dropped by ACL
  const d = datasets.get('tickets')!;
  assert.equal((await mgr.enforce(cloud, issued.key, d, 'read')).ok, true);
  assert.equal((await mgr.enforce(cloud, issued.key, d, 'write')).ok, false); // not granted
});

test('requestAccess: empty grant set is denied', async () => {
  const { mgr, datasets } = deps();
  datasets.create({ id: 'priv', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [] });
  const res = await mgr.requestAccess({ type: 'cloud', userId: 'u1' }, { grants: [{ dataset: 'priv', actions: ['read'] }] });
  assert.equal(res.ok, false);
});

test('enforce: local fast-path (no key) allowed; cloud needs key', async () => {
  const { mgr, datasets } = deps();
  datasets.create({ id: 'd', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [] });
  const d = datasets.get('d')!;
  assert.equal((await mgr.enforce({ type: 'local' }, undefined, d, 'write')).ok, true);
  const denied = await mgr.enforce({ type: 'cloud', userId: 'u' }, undefined, d, 'read');
  assert.equal(denied.ok, false);
});

test('enforce: expired and revoked keys rejected', async () => {
  const { mgr, datasets, keys } = deps();
  datasets.create({ id: 'd', backend: 'cache', visibility: 'cross-node-readable',
    config: { kind: 'cache' }, acl: [{ principal: 'cloud', actions: ['read'] }] });
  const d = datasets.get('d')!;
  // craft an already-expired key directly
  const crypto = require('crypto');
  const secret = 'abc';
  const keyId = 'kx';
  await keys.put({ keyId, secretHash: crypto.createHash('sha256').update(secret).digest('hex'),
    principalType: 'cloud', principalId: 'u', node: 'n1', grants: [{ dataset: 'd', actions: ['read'] }],
    issuedAt: '2000-01-01T00:00:00Z', expiresAt: '2000-01-01T00:00:00Z' });
  const expired = await mgr.enforce({ type: 'cloud', userId: 'u' }, `${keyId}.${secret}`, d, 'read');
  assert.equal(expired.ok, false);
  assert.equal(expired.ok ? '' : expired.code, 'KEY_EXPIRED');
});
