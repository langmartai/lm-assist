import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeKeypack, decodeKeypack, assertHubUrlResolvesSafe } from '../hub-client/enroll-code';

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
// --- SSRF hardening v2: complete the internal-range denylist (the prefix check missed these) ---
test('rejects RFC1918 / CGNAT / other-cloud-metadata / IPv6-internal IP-literal hubUrls', () => {
  for (const url of [
    'ws://10.0.0.1', 'ws://10.255.255.255:8086', 'ws://172.16.0.1', 'ws://172.31.255.1',
    'wss://192.168.1.1', 'ws://100.64.0.1', 'ws://100.100.100.200', // Alibaba metadata (in 100.64/10)
    'ws://192.0.0.192',                                              // Oracle metadata (192.0.0.0/24)
    'ws://0.0.0.0', 'ws://[fc00::1]', 'wss://[fe80::1]',
    'ws://[::ffff:169.254.169.254]',                                 // IPv4-mapped link-local
    'ws://[::ffff:10.0.0.1]',                                        // IPv4-mapped RFC1918
  ]) {
    const bad = 'lmkp_' + Buffer.from(JSON.stringify({ v: 1, hubUrl: url, token: 'x' })).toString('base64url');
    assert.throws(() => decodeKeypack(bad), /not allowed/, `should reject ${url}`);
  }
});
test('rejects the metadata hostname with a trailing-dot bypass', () => {
  const bad = 'lmkp_' + Buffer.from(JSON.stringify({ v: 1, hubUrl: 'ws://metadata.google.internal.', token: 'x' })).toString('base64url');
  assert.throws(() => decodeKeypack(bad), /not allowed/);
});
test('rejects alternative IP encodings that normalize to internal (decimal/hex/octal/IPv4-mapped-hex)', () => {
  for (const url of [
    'ws://0xA9FEA9FE',            // hex → 169.254.169.254
    'ws://0251.0376.0251.0376',  // octal → 169.254.169.254
    'ws://[::ffff:a9fe:a9fe]',   // hex IPv4-mapped → 169.254.169.254
    'ws://[0:0:0:0:0:ffff:0a00:0001]', // expanded IPv4-mapped → 10.0.0.1
  ]) {
    const bad = 'lmkp_' + Buffer.from(JSON.stringify({ v: 1, hubUrl: url, token: 'x' })).toString('base64url');
    assert.throws(() => decodeKeypack(bad), /not allowed/, `should reject ${url}`);
  }
});
test('still ACCEPTS loopback (dev) + public hubUrls (no over-block)', () => {
  for (const url of ['ws://localhost:8086', 'ws://127.0.0.1:8086', 'wss://[::1]:8086', 'wss://assist-api.langmart.ai', 'wss://203.0.113.5']) {
    const k = { v: 1 as const, hubUrl: url, token: 't'.repeat(8) };
    assert.deepEqual(decodeKeypack(encodeKeypack(k)), k, `should accept ${url}`);
  }
});
// --- DNS-rebinding guard: assertHubUrlResolvesSafe (resolve the host, reject internal) ---
const fakeLookup = (...addrs: string[]) => async () => addrs.map((address) => ({ address }));
test('assertHubUrlResolvesSafe: a NAME resolving to an internal IP is rejected', async () => {
  await assert.rejects(assertHubUrlResolvesSafe('wss://evil.example.com', fakeLookup('10.0.0.5')), /resolves to an internal address/);
  await assert.rejects(assertHubUrlResolvesSafe('wss://evil.example.com', fakeLookup('1.2.3.4', '169.254.169.254')), /resolves to an internal address/);
});
test('assertHubUrlResolvesSafe: a NAME resolving to public (or loopback) passes', async () => {
  await assertHubUrlResolvesSafe('wss://hub.example.com', fakeLookup('203.0.113.5')); // public → ok
  await assertHubUrlResolvesSafe('ws://localhost:8086', fakeLookup('127.0.0.1'));      // loopback → ok (dev)
});
test('assertHubUrlResolvesSafe: an internal IP-LITERAL is rejected before any DNS lookup', async () => {
  let called = false;
  const spy = (async () => { called = true; return [{ address: '8.8.8.8' }]; }) as unknown as Parameters<typeof assertHubUrlResolvesSafe>[1];
  await assert.rejects(assertHubUrlResolvesSafe('ws://10.0.0.1', spy), /not allowed/);
  assert.equal(called, false, 'no DNS lookup for an IP literal');
});
test('assertHubUrlResolvesSafe: a host that does not resolve is rejected', async () => {
  await assert.rejects(assertHubUrlResolvesSafe('wss://nx.example.com', (async () => { throw new Error('ENOTFOUND'); })), /does not resolve/);
  await assert.rejects(assertHubUrlResolvesSafe('wss://empty.example.com', (async () => [])), /does not resolve/);
});
