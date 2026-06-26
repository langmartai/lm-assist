import { test } from 'node:test';
import assert from 'node:assert';
import { renewBufferMs, isTokenExpired } from '../utils/claude-oauth';

test('renewBufferMs: 15min interval → 20min', () => assert.strictEqual(renewBufferMs(15), 20 * 60_000));
test('renewBufferMs: custom margin', () => assert.strictEqual(renewBufferMs(15, 0), 15 * 60_000));
test('renewBufferMs: floors interval at 1', () => assert.strictEqual(renewBufferMs(0), 5 * 60_000));
test('proactive buffer renews a token expiring within the window', () => {
  const creds: any = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 18 * 60_000, scopes: [] };
  assert.strictEqual(isTokenExpired(creds, renewBufferMs(15)), true);  // 18min < 20min buffer → renew
});
test('proactive buffer leaves a token with ample life alone', () => {
  const creds: any = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60 * 60_000, scopes: [] };
  assert.strictEqual(isTokenExpired(creds, renewBufferMs(15)), false); // 60min > 20min → no renew
});
