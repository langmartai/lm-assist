import { test } from 'node:test';
import assert from 'node:assert';
import { isServerStall } from '../monitor/stall-classify';

test('server errors are retryable', () => {
  for (const s of ['API Error: 529', 'Overloaded', 'Waiting for capacity', 'API Error: 500', 'Internal server error', 'Server is temporarily limiting requests (not your usage limit)']) {
    const r = isServerStall(s);
    assert.strictEqual(r.retryable, true, `expected retryable for: ${s} (got ${r.category})`);
  }
});

test('connection/network errors are retryable (transient — internet dropped)', () => {
  for (const s of ['API Error: Unable to connect to API (ConnectionRefused)', 'API Error: Connection error.']) {
    const r = isServerStall(s);
    assert.strictEqual(r.retryable, true, `expected retryable for: ${s} (got ${r.category})`);
    assert.strictEqual(r.category, 'connection_error');
  }
});

test('user usage-limit and auth are NEVER retryable', () => {
  for (const s of ['Claude usage limit reached', '5-hour limit reached', "You've been rate limited", 'OAuth token has expired', 'Invalid API key', 'Credit balance is too low']) {
    const r = isServerStall(s);
    assert.strictEqual(r.retryable, false, `expected NOT retryable for: ${s} (got ${r.category})`);
  }
});

test('idle/empty text is not retryable', () => {
  assert.strictEqual(isServerStall('').retryable, false);
  assert.strictEqual(isServerStall('> ready for input').retryable, false);
});

test('category is reported', () => {
  assert.strictEqual(isServerStall('API Error: 529').category, 'overloaded');
  assert.strictEqual(isServerStall('Claude usage limit reached').category, 'rate_limit_user');
});
