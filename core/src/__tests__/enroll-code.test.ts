import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeKeypack, decodeKeypack } from '../hub-client/enroll-code';

test('round-trips a keypack', () => {
  const k = { v: 1 as const, hubUrl: 'wss://assist-api.langmart.ai', token: 'a'.repeat(64) };
  const code = encodeKeypack(k);
  assert.ok(code.startsWith('lmkp_'));
  assert.deepEqual(decodeKeypack(code), k);
});
test('accepts ws://localhost for local/dev hubs', () => {
  const k = { v: 1 as const, hubUrl: 'ws://localhost:8086', token: 't'.repeat(8) };
  assert.deepEqual(decodeKeypack(encodeKeypack(k)), k);
});
test('rejects a bad prefix', () => {
  assert.throws(() => decodeKeypack('nope_xxx'), /prefix/);
});
test('rejects malformed encoding', () => {
  assert.throws(() => decodeKeypack('lmkp_@@@not-base64@@@'), /encoding|shape/);
});
test('rejects a keypack missing the token', () => {
  const bad = 'lmkp_' + Buffer.from(JSON.stringify({ v: 1, hubUrl: 'wss://x' })).toString('base64url');
  assert.throws(() => decodeKeypack(bad), /shape/);
});
test('encode rejects incomplete input', () => {
  assert.throws(() => encodeKeypack({ v: 1, hubUrl: '', token: 't' } as any));
});
// --- SSRF hardening: hubUrl must be ws://host or wss://host ---
test('rejects a non-ws hubUrl scheme (http SSRF)', () => {
  const bad = 'lmkp_' + Buffer.from(JSON.stringify({ v: 1, hubUrl: 'http://169.254.169.254/latest', token: 'x' })).toString('base64url');
  assert.throws(() => decodeKeypack(bad), /ws:\/\/ or wss:\/\/|hubUrl/);
});
test('rejects file:// and javascript: hubUrls', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,x']) {
    const bad = 'lmkp_' + Buffer.from(JSON.stringify({ v: 1, hubUrl: url, token: 'x' })).toString('base64url');
    assert.throws(() => decodeKeypack(bad), /hubUrl/);
  }
});
test('rejects a host-less ws hubUrl', () => {
  const bad = 'lmkp_' + Buffer.from(JSON.stringify({ v: 1, hubUrl: 'ws://', token: 'x' })).toString('base64url');
  assert.throws(() => decodeKeypack(bad), /hubUrl|encoding/);
});
test('encode rejects a non-ws hubUrl scheme', () => {
  assert.throws(() => encodeKeypack({ v: 1, hubUrl: 'http://evil.com', token: 't' } as any), /ws:\/\/ or wss:\/\//);
});
test('rejects an oversized keypack', () => {
  assert.throws(() => decodeKeypack('lmkp_' + 'A'.repeat(9000)), /too large/);
});
test('rejects link-local / cloud-metadata hubUrls even over ws', () => {
  for (const url of ['ws://169.254.169.254:80', 'wss://169.254.169.254', 'ws://metadata.google.internal']) {
    const bad = 'lmkp_' + Buffer.from(JSON.stringify({ v: 1, hubUrl: url, token: 'x' })).toString('base64url');
    assert.throws(() => decodeKeypack(bad), /not allowed/);
  }
});
