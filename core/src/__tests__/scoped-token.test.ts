import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  mintScopedToken,
  listScopedTokens,
  revokeScopedToken,
  validateScopedRequest,
  scopedTokenFor,
  isKnownScope,
  __resetScopedTokens,
} from '../auth/scoped-token';

let file: string;
beforeEach(() => {
  __resetScopedTokens();
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sct-')), 'scoped-tokens.json');
});

const CONV = '/claude-ai/conversations';
const UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

test('mint returns a prefixed secret and persists it', () => {
  const t = mintScopedToken({ scope: 'claude-ai-chat', label: 'test' }, file, 1000);
  assert.ok(t.token.startsWith('lmsc_'));
  assert.ok(t.id.startsWith('sct_'));
  assert.strictEqual(t.scope, 'claude-ai-chat');
  assert.strictEqual(t.expiresAt, 1000 + 24 * 3600 * 1000);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk.tokens.length, 1);
  assert.strictEqual(onDisk.tokens[0].token, t.token);
});

test('scope allow-list: chat routes pass, everything else fails', () => {
  const t = mintScopedToken({ scope: 'claude-ai-chat' }, file, 1000);
  const ok = (m: string, p: string) => validateScopedRequest(t.token, m, p, file, 2000);
  // Allowed surface
  assert.ok(ok('POST', CONV));
  assert.ok(ok('POST', `${CONV}/${UUID}/completion`));
  assert.ok(ok('POST', `${CONV}/${UUID}/completion/stream`));
  assert.ok(ok('GET', `${CONV}/${UUID}/messages`));
  // Method confusion
  assert.ok(!ok('GET', CONV));                       // list conversations — privacy, excluded
  assert.ok(!ok('DELETE', `${CONV}/${UUID}`));       // delete — excluded
  assert.ok(!ok('GET', `${CONV}/${UUID}`));          // raw read — excluded
  assert.ok(!ok('POST', `${CONV}/${UUID}/title`));   // rename — excluded
  // Anything else on the node
  assert.ok(!ok('GET', '/sessions'));
  assert.ok(!ok('POST', '/agent/execute'));
  assert.ok(!ok('POST', '/auth/scoped-tokens'));     // can't mint more tokens with a scoped token
  // Path smuggling
  assert.ok(!ok('POST', `${CONV}/${UUID}/completion/stream/extra`));
  assert.ok(!ok('POST', `${CONV}/not-a-uuid/completion`));
});

test('expiry: token stops validating after expiresAt and is pruned from list', () => {
  const t = mintScopedToken({ scope: 'claude-ai-chat', ttlMs: 5_000 }, file, 1000);
  assert.ok(validateScopedRequest(t.token, 'POST', CONV, file, 5_999));
  assert.ok(!validateScopedRequest(t.token, 'POST', CONV, file, 6_001));
  assert.strictEqual(listScopedTokens(file, 6_001).length, 0);
});

test('revoke by id kills the token immediately', () => {
  const t = mintScopedToken({ scope: 'claude-ai-chat' }, file, 1000);
  assert.ok(validateScopedRequest(t.token, 'POST', CONV, file, 2000));
  assert.strictEqual(revokeScopedToken(t.id, file), true);
  assert.ok(!validateScopedRequest(t.token, 'POST', CONV, file, 2000));
  assert.strictEqual(revokeScopedToken(t.id, file), false); // already gone
});

test('list never exposes the secret', () => {
  mintScopedToken({ scope: 'claude-ai-chat', label: 'panel' }, file, 1000);
  const infos = listScopedTokens(file, 2000);
  assert.strictEqual(infos.length, 1);
  assert.ok(!('token' in infos[0]));
  assert.strictEqual(infos[0].label, 'panel');
});

test('persistence survives an in-memory reset (process restart)', () => {
  const t = mintScopedToken({ scope: 'claude-ai-chat' }, file, 1000);
  __resetScopedTokens(file); // simulate restart — reload from disk
  assert.ok(validateScopedRequest(t.token, 'POST', CONV, file, 2000));
});

test('garbage inputs never validate', () => {
  mintScopedToken({ scope: 'claude-ai-chat' }, file, 1000);
  assert.ok(!validateScopedRequest(undefined, 'POST', CONV, file, 2000));
  assert.ok(!validateScopedRequest('', 'POST', CONV, file, 2000));
  assert.ok(!validateScopedRequest('lmsc_deadbeef', 'POST', CONV, file, 2000));
  assert.ok(!validateScopedRequest('not-a-scoped-token', 'POST', CONV, file, 2000));
});

test('ttl is clamped to the 7-day max', () => {
  const t = mintScopedToken({ scope: 'claude-ai-chat', ttlMs: 365 * 24 * 3600 * 1000 }, file, 0);
  assert.strictEqual(t.expiresAt, 7 * 24 * 3600 * 1000);
});

test('mint cap refuses the 51st live token', () => {
  for (let i = 0; i < 50; i++) mintScopedToken({ scope: 'claude-ai-chat' }, file, 1000);
  assert.throws(() => mintScopedToken({ scope: 'claude-ai-chat' }, file, 1000), /cap/);
  // …but expired ones free slots
  __resetScopedTokens(file);
  assert.doesNotThrow(() => mintScopedToken({ scope: 'claude-ai-chat' }, file, 999 * 24 * 3600 * 1000));
});

test('isKnownScope', () => {
  assert.ok(isKnownScope('claude-ai-chat'));
  assert.ok(!isKnownScope('everything'));
  assert.ok(!isKnownScope(undefined));
});

test('named-list route is in scope; listPrefix binds at mint and resolves via scopedTokenFor', () => {
  const t = mintScopedToken({ scope: 'claude-ai-chat', listPrefix: 'Chart chat — ' }, file, 1000);
  assert.ok(validateScopedRequest(t.token, 'GET', `${CONV}/named`, file, 2000));
  const info = scopedTokenFor(t.token, file, 2000);
  assert.ok(info);
  assert.equal(info!.listPrefix, 'Chart chat — ');
  assert.ok(!('token' in (info as object)));
  // survives persistence round-trip
  __resetScopedTokens(file);
  assert.equal(scopedTokenFor(t.token, file, 2000)!.listPrefix, 'Chart chat — ');
});

test('scopedTokenFor rejects unknown/expired/non-scoped tokens', () => {
  const t = mintScopedToken({ scope: 'claude-ai-chat', ttlMs: 5_000 }, file, 1000);
  assert.equal(scopedTokenFor(t.token, file, 2000)!.listPrefix, undefined);
  assert.equal(scopedTokenFor(t.token, file, 7000), null);        // expired
  assert.equal(scopedTokenFor('lmsc_nope', file, 2000), null);    // unknown
  assert.equal(scopedTokenFor('full-ring-token', file, 2000), null);
});

test('empty listPrefix refuses to mint', () => {
  assert.throws(() => mintScopedToken({ scope: 'claude-ai-chat', listPrefix: '  ' }, file, 1000), /listPrefix/);
});
