import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { KeyStore } from '../../data/key-store';
import type { AccessKey } from '../../data/types';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'lm-keys-')); }
function key(id: string): AccessKey {
  return { keyId: id, secretHash: 'h', principalType: 'cloud', node: 'n',
    grants: [{ dataset: 'd', actions: ['read'] }], issuedAt: 't', expiresAt: 't' };
}

test('key store: put/get/revoke', async () => {
  const ks = new KeyStore(tmp());
  await ks.put(key('k1'));
  assert.equal(ks.get('k1')?.keyId, 'k1');
  assert.equal(ks.get('nope'), undefined);
  assert.equal(await ks.revoke('k1'), true);
  assert.equal(ks.get('k1')?.revoked, true);
  assert.equal(await ks.revoke('nope'), false);
});

test('key store: audit append + list', async () => {
  const ks = new KeyStore(tmp());
  await ks.appendAudit({ at: '2026-01-01T00:00:00Z', event: 'issue', keyId: 'k1', principalType: 'local' });
  await ks.appendAudit({ at: '2026-01-01T00:00:01Z', event: 'deny', principalType: 'cloud', dataset: 'd', action: 'write' });
  const log = ks.listAudit();
  assert.equal(log.length, 2);
  assert.equal(log[0].event, 'issue');
  assert.equal(log[1].action, 'write');
});
