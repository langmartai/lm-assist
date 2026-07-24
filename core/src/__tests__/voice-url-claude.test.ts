import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { buildClaudeVoiceWsUrlFromParts, type VoiceWsUrlInput } from '../voice/voice-url';

function input(over: Partial<VoiceWsUrlInput>): VoiceWsUrlInput {
  return {
    isRemoteNode: false,
    appMode: 'local',
    pageProtocol: 'http:',
    pageHost: 'localhost:3948',
    pageHostname: 'localhost',
    coreBaseUrl: 'http://127.0.0.1:3200',
    token: 'tok',
    ...over,
  };
}

test('remote/hub-proxied node → null (mic hidden, no dead URL)', () => {
  assert.equal(buildClaudeVoiceWsUrlFromParts(input({ isRemoteNode: true })), null);
  assert.equal(
    buildClaudeVoiceWsUrlFromParts(input({ isRemoteNode: true, pageProtocol: 'https:', pageHost: '10.0.1.117:3949', pageHostname: '10.0.1.117' })),
    null,
    'remote wins even on a secure page',
  );
});

test('https page + local mode → same-origin wss with token (the LM_HTTPS terminator path)', () => {
  const url = buildClaudeVoiceWsUrlFromParts(
    input({ pageProtocol: 'https:', pageHost: '10.0.1.117:3949', pageHostname: '10.0.1.117', coreBaseUrl: '/_coreapi' }),
  );
  assert.equal(url, 'wss://10.0.1.117:3949/voice/claude/ws?token=tok');
});

test('https page + local mode without token → no query string', () => {
  const url = buildClaudeVoiceWsUrlFromParts(
    input({ pageProtocol: 'https:', pageHost: 'localhost:3949', coreBaseUrl: '/_coreapi', token: '' }),
  );
  assert.equal(url, 'wss://localhost:3949/voice/claude/ws');
});

test('https page + hub mode → null (hub origin has no terminator)', () => {
  const url = buildClaudeVoiceWsUrlFromParts(
    input({ pageProtocol: 'https:', appMode: 'hub', pageHost: 'langmart.ai', pageHostname: 'langmart.ai', coreBaseUrl: '' }),
  );
  assert.equal(url, null);
});

test('http page + localhost → direct core ws URL (existing working path preserved)', () => {
  assert.equal(
    buildClaudeVoiceWsUrlFromParts(input({})),
    'ws://127.0.0.1:3200/voice/claude/ws?token=tok',
  );
  assert.equal(
    buildClaudeVoiceWsUrlFromParts(input({ pageHostname: '127.0.0.1', pageHost: '127.0.0.1:3948' })),
    'ws://127.0.0.1:3200/voice/claude/ws?token=tok',
  );
});

test('http page + LAN IP → null (insecure context: getUserMedia cannot exist)', () => {
  assert.equal(
    buildClaudeVoiceWsUrlFromParts(input({ pageHost: '10.0.1.117:3948', pageHostname: '10.0.1.117' })),
    null,
  );
});

test('token is URL-encoded', () => {
  const url = buildClaudeVoiceWsUrlFromParts(input({ token: 'a b&c' }));
  assert.equal(url, 'ws://127.0.0.1:3200/voice/claude/ws?token=a%20b%26c');
});

test('non-http core base on an http page → null (defensive)', () => {
  assert.equal(buildClaudeVoiceWsUrlFromParts(input({ coreBaseUrl: '/_coreapi' })), null);
});

// Same guard as voice-url.test.ts (belt and suspenders — re-asserted here since this is
// the test file that owns the new function added to the shared block).
test('shared voice-url logic is byte-identical between core and web copies', () => {
  // compiled location: core/dist-test/__tests__/voice-url-claude.test.js → repo root is 3 dirs up
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const read = (rel: string) => {
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const begin = src.indexOf('===BEGIN SHARED VOICE URL LOGIC===');
    const end = src.indexOf('// ===END SHARED VOICE URL LOGIC===');
    assert.ok(begin >= 0 && end > begin, `markers present in ${rel}`);
    // start AFTER the begin-marker line (its trailing text names the other file, so it differs)
    const afterBegin = src.indexOf('\n', begin) + 1;
    return src.slice(afterBegin, end);
  };
  const coreCopy = read('core/src/voice/voice-url.ts');
  const webCopy = read('web/src/lib/voice-url.ts');
  assert.equal(webCopy, coreCopy, 'edit both files together — see header comments');
});
