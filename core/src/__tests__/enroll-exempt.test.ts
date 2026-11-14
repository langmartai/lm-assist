import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEnrollExempt } from '../auth/enroll-exempt';

test('exempts only POST /hub/login from strict loopback', () => {
  assert.equal(isEnrollExempt('POST', '/hub/login', '127.0.0.1'), true);
  assert.equal(isEnrollExempt('POST', '/hub/login', '::ffff:127.0.0.1'), true);
});
test('does NOT exempt minting (/hub/enroll/create) — token required', () => {
  assert.equal(isEnrollExempt('POST', '/hub/enroll/create', '::1'), false);
  assert.equal(isEnrollExempt('POST', '/hub/enroll/create', '127.0.0.1'), false);
});
test('does NOT exempt a LAN interface ip', () => {
  assert.equal(isEnrollExempt('POST', '/hub/login', '192.0.2.17'), false);
});
test('does NOT exempt other paths or methods', () => {
  assert.equal(isEnrollExempt('POST', '/hub/status', '127.0.0.1'), false);
  assert.equal(isEnrollExempt('GET', '/hub/login', '127.0.0.1'), false);
  assert.equal(isEnrollExempt('POST', '/hub/logout', '127.0.0.1'), false);
});
test('handles missing address', () => {
  assert.equal(isEnrollExempt('POST', '/hub/login', undefined), false);
});
test('does NOT exempt when a browser Origin is present (anti-CSRF)', () => {
  assert.equal(isEnrollExempt('POST', '/hub/login', '127.0.0.1', 'https://evil.com'), false);
  assert.equal(isEnrollExempt('POST', '/hub/enroll/create', '127.0.0.1', 'http://localhost:3000'), false);
  assert.equal(isEnrollExempt('POST', '/hub/login', '127.0.0.1', ['https://evil.com']), false);
});
test('still exempt when Origin is absent/empty (CLI/curl)', () => {
  assert.equal(isEnrollExempt('POST', '/hub/login', '127.0.0.1', undefined), true);
  assert.equal(isEnrollExempt('POST', '/hub/login', '127.0.0.1', ''), true);
});
test('does NOT exempt a loopback socket behind a proxy hop (web /_coreapi rewrite)', () => {
  // Next's proxy always adds x-forwarded-host — possibly EMPTY; presence is what counts.
  assert.equal(isEnrollExempt('POST', '/hub/login', '127.0.0.1', undefined, { 'x-forwarded-host': '10.0.1.42:3948' }), false);
  assert.equal(isEnrollExempt('POST', '/hub/login', '127.0.0.1', undefined, { 'x-forwarded-host': '' }), false);
  assert.equal(isEnrollExempt('POST', '/hub/login', '127.0.0.1', undefined, { 'x-forwarded-for': '10.0.1.42' }), false);
});
test('does NOT exempt a relayed request (x-relay-source)', () => {
  assert.equal(isEnrollExempt('POST', '/hub/login', '127.0.0.1', undefined, { 'x-relay-source': 'hub' }), false);
});
test('a clean loopback CLI call with ordinary headers stays exempt', () => {
  assert.equal(isEnrollExempt('POST', '/hub/login', '127.0.0.1', undefined, { host: '127.0.0.1:3200', 'content-type': 'application/json' }), true);
  // The HTTPS terminator's in-process marker is not a proxy hop.
  assert.equal(isEnrollExempt('POST', '/hub/login', '127.0.0.1', undefined, { 'x-forwarded-proto': 'https' }), true);
});
