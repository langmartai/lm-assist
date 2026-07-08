import { test } from 'node:test';
import assert from 'node:assert';
import { classifyScreen } from '../terminal/cc-classify';

// Reproduces the confirmed bug: a session recovers from an earlier auth hiccup
// (keeps working — a later tool call succeeds), then hits a real, current
// server-side rate limit. Both banners remain visible in the same captured
// screen. The CURRENT state is the rate limit; auth_error is stale.
test('a later rate_limit_server banner beats an earlier stale auth_error banner', () => {
  const text = [
    '❯ Cross pin . Color use grey color not white',
    '  ⎿  Not logged in · Please run /login',
    '',
    '❯ continue',
    '',
    '● Read(some/file.ts)',
    '  ⎿  Read 45 lines',
    '',
    '● API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
    '',
    '❯ ',
  ].join('\n');
  const cls = classifyScreen(text);
  assert.strictEqual(cls.state, 'rate_limit_server', `expected rate_limit_server, got ${cls.state} (${cls.detail})`);
});

// Recency, not a fixed "rate_limit_server > auth_error" rule: swap the order
// and the auth_error (now the later/current one) must win instead.
test('a later auth_error banner beats an earlier stale rate_limit_server banner', () => {
  const text = [
    '● API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
    '',
    '❯ continue',
    '',
    '● Read(some/file.ts)',
    '  ⎿  Read 45 lines',
    '',
    '❯ Cross pin . Color use grey color not white',
    '  ⎿  Not logged in · Please run /login',
    '',
    '❯ ',
  ].join('\n');
  const cls = classifyScreen(text);
  assert.strictEqual(cls.state, 'auth_error', `expected auth_error, got ${cls.state} (${cls.detail})`);
});

test('a later server_error banner beats an earlier stale overloaded banner', () => {
  const text = ['API Error: 529 Overloaded', '...', 'API Error: 500 Internal server error'].join('\n');
  const cls = classifyScreen(text);
  assert.strictEqual(cls.state, 'server_error');
});

test('a later overloaded banner beats an earlier stale server_error banner', () => {
  const text = ['API Error: 500 Internal server error', '...', 'API Error: 529 Overloaded'].join('\n');
  const cls = classifyScreen(text);
  assert.strictEqual(cls.state, 'overloaded');
});

// Single-category regression guard — each banner alone still classifies as before.
test('single-banner text still classifies correctly per category', () => {
  assert.strictEqual(classifyScreen('Please run /login').state, 'auth_error');
  assert.strictEqual(classifyScreen('Server is temporarily limiting requests (not your usage limit)').state, 'rate_limit_server');
  assert.strictEqual(classifyScreen('Claude usage limit reached').state, 'rate_limit_user');
  assert.strictEqual(classifyScreen('API Error: 529').state, 'overloaded');
  assert.strictEqual(classifyScreen('API Error: 500').state, 'server_error');
});

// folder_trust is unconditional top priority — untouched by the recency fix.
test('folder_trust still wins even if an error banner is also present', () => {
  const text = ['API Error: Server is temporarily limiting requests (not your usage limit)', 'Is this a project you created or one you trust?'].join('\n');
  const cls = classifyScreen(text);
  assert.strictEqual(cls.state, 'folder_trust');
});

test('idle prompt with no banners is still idle', () => {
  const text = ['some prior output', '❯ ', 'bypass permissions on (shift+tab to cycle)'].join('\n');
  assert.strictEqual(classifyScreen(text).state, 'idle');
});
