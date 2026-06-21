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
  assert.equal(isEnrollExempt('POST', '/hub/login', '10.0.1.117'), false);
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
