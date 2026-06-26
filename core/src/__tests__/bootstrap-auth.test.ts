import { test } from 'node:test';
import assert from 'node:assert';
import { authSnapshotIsStale, formatAuthBlock } from '../mcp-server/tools/guide';
import type { AuthSnapshot } from '../monitor/auth-monitor';

const snap = (over: Partial<AuthSnapshot> = {}): AuthSnapshot => ({
  checkedAt: 1000,
  oauth: { present: true, expired: false, msUntilExpiry: 3600_000, refreshedThisCheck: false },
  cookie: { configured: true, ok: true, reason: 'ok', identity: 'a@b.c' },
  ...over,
});

test('isStale: null → stale', () => assert.strictEqual(authSnapshotIsStale(null, 0, 15), true));
test('isStale: fresh within 2x interval → not stale', () => {
  assert.strictEqual(authSnapshotIsStale(snap({ checkedAt: 0 }), 10 * 60_000, 15), false);
});
test('isStale: older than 2x interval → stale', () => {
  assert.strictEqual(authSnapshotIsStale(snap({ checkedAt: 0 }), 31 * 60_000, 15), true);
});
test('formatAuthBlock: healthy shows valid + ok, no secrets, no fix hint', () => {
  const b = formatAuthBlock(snap(), 'node-A');
  assert.match(b, /OAuth:.*valid/i);
  assert.match(b, /cookie:.*ok/i);
  assert.ok(!/claudeai_login/.test(b));
});
test('formatAuthBlock: dead cookie shows reason + claudeai_login hint', () => {
  const b = formatAuthBlock(snap({ cookie: { configured: true, ok: false, reason: 'session_expired' } }), 'node-A');
  assert.match(b, /session_expired/);
  assert.match(b, /claudeai_login/);
});
test('formatAuthBlock: absent oauth shows none', () => {
  const b = formatAuthBlock(snap({ oauth: { present: false, expired: false, refreshedThisCheck: false } }), 'node-A');
  assert.match(b, /OAuth:.*(none|—)/i);
});
test('formatAuthBlock: unprobed cookie renders without hard-fail hint', () => {
  const b = formatAuthBlock(snap({ cookie: { configured: true, ok: false, reason: 'unprobed' } }), 'node-A');
  assert.match(b, /not live-checked/i);
  assert.ok(!/claudeai_login/.test(b), 'no claudeai_login hint for unprobed');
});
