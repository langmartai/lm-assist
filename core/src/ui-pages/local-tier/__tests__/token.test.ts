import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadOrCreateSecret,
  mintViewToken,
  verifyViewToken,
  mintEntryToken,
  verifyEntryToken,
  __initLocalUiSecret,
} from '../token';

let base: string;
beforeEach(() => {
  // Isolated HOME per test: the secret + single-use ledger never leak across cases
  // and never touch the developer's real ~/.lm-assist.
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'lvt-'));
  __initLocalUiSecret(base);
});

const secretPath = () => path.join(base, '.lm-assist', 'local-ui-secret');

test('loadOrCreateSecret persists 32 bytes at 0600 and is stable across loads', () => {
  const s = loadOrCreateSecret(base);
  assert.equal(s.length, 32);
  assert.ok(fs.existsSync(secretPath()));
  assert.equal(fs.statSync(secretPath()).mode & 0o777, 0o600);
  assert.deepEqual(loadOrCreateSecret(base), s); // same secret, not a fresh mint
});

test('loadOrCreateSecret repairs loose perms to 0600 on load', () => {
  loadOrCreateSecret(base);
  fs.chmodSync(secretPath(), 0o644);
  loadOrCreateSecret(base);
  assert.equal(fs.statSync(secretPath()).mode & 0o777, 0o600);
});

test('view token round-trips its uiId', () => {
  const t = mintViewToken('backlog');
  assert.ok(t.startsWith('lvt1.'));
  assert.deepEqual(verifyViewToken(t), { uiId: 'backlog' });
});

test('an expired view token verifies to null', () => {
  // A negative ttl stamps an already-past expiry — deterministic, no sleeping.
  assert.equal(verifyViewToken(mintViewToken('backlog', -1000)), null);
});

test('a forged or byte-flipped mac verifies to null', () => {
  const a = mintViewToken('backlog');
  const b = mintViewToken('other');
  const [pfx, payloadA, macA] = a.split('.');
  const payloadB = b.split('.')[1];
  // Right mac, wrong payload — signature no longer covers this body.
  assert.equal(verifyViewToken(`${pfx}.${payloadB}.${macA}`), null);
  // Flip a byte in the mac itself.
  const mac = Buffer.from(macA, 'base64url');
  mac[0] ^= 0x01;
  assert.equal(verifyViewToken(`${pfx}.${payloadA}.${mac.toString('base64url')}`), null);
});

test('malformed and wrong-prefix tokens verify to null without throwing', () => {
  assert.equal(verifyViewToken(''), null);
  assert.equal(verifyViewToken('garbage'), null);
  assert.equal(verifyViewToken('lvt1.only-two'), null);
  assert.equal(verifyViewToken('lvt1..'), null);
  assert.equal(verifyViewToken(mintEntryToken('backlog')), null); // entry ≠ view
});

test('entry token is single-use', () => {
  const t = mintEntryToken('backlog');
  assert.ok(t.startsWith('let1.'));
  assert.deepEqual(verifyEntryToken(t), { uiId: 'backlog' });
  assert.equal(verifyEntryToken(t), null); // replay refused inside its window
});

test('a view token is not accepted as an entry token', () => {
  assert.equal(verifyEntryToken(mintViewToken('backlog')), null);
});

test('prefix-swapped token is rejected (kind is bound into the MAC)', () => {
  // Domain separation: flipping the type prefix on a genuinely-signed token must not verify
  // as the other kind — otherwise a URL-borne entry token could be replayed as a view token.
  const view = mintViewToken('backlog');       // lvt1.<payload>.<mac>
  const asEntry = 'let1.' + view.slice('lvt1.'.length);
  assert.equal(verifyEntryToken(asEntry), null);
  const entry = mintEntryToken('backlog');      // let1.<payload>.<mac>
  const asView = 'lvt1.' + entry.slice('let1.'.length);
  assert.equal(verifyViewToken(asView), null);
});
