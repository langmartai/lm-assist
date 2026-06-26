import { test } from 'node:test';
import assert from 'node:assert';
import { buildAuthSnapshot, type AuthSnapshotDeps } from '../monitor/auth-monitor';

function deps(over: Partial<AuthSnapshotDeps>): AuthSnapshotDeps {
  return {
    refreshOAuth: async () => ({ refreshed: false }),
    oauthStatus: () => ({ present: true, expired: false, msUntilExpiry: 3600_000, subscriptionType: 'max', rateLimitTier: 't1' }),
    cookieStatus: () => ({ present: true, hasSessionKey: true, hasCfClearance: true, hasCfBm: true, identity: 'a@b.c' }),
    cookieProbe: async () => ({ ok: true, reason: 'ok' }),
    now: () => 1_000,
    ...over,
  };
}

test('healthy: oauth ok + cookie ok', async () => {
  const s = await buildAuthSnapshot(deps({}));
  assert.strictEqual(s.oauth.present, true);
  assert.strictEqual(s.oauth.expired, false);
  assert.strictEqual(s.cookie.ok, true);
  assert.strictEqual(s.cookie.reason, 'ok');
  assert.strictEqual(s.cookie.identity, 'a@b.c');
  assert.strictEqual(s.checkedAt, 1_000);
});

test('oauth refreshed flag propagates', async () => {
  const s = await buildAuthSnapshot(deps({ refreshOAuth: async () => ({ refreshed: true }) }));
  assert.strictEqual(s.oauth.refreshedThisCheck, true);
});

test('cookie expired → ok:false carries reason, no identity leak of secrets', async () => {
  const s = await buildAuthSnapshot(deps({
    cookieStatus: () => ({ present: true, hasSessionKey: true }),
    cookieProbe: async () => ({ ok: false, reason: 'session_expired', hint: 'recapture' }),
  }));
  assert.strictEqual(s.cookie.ok, false);
  assert.strictEqual(s.cookie.reason, 'session_expired');
  assert.strictEqual(s.cookie.hint, 'recapture');
});

test('oauth absent', async () => {
  const s = await buildAuthSnapshot(deps({ oauthStatus: () => ({ present: false, expired: false }) }));
  assert.strictEqual(s.oauth.present, false);
});

test('cookie not configured', async () => {
  const s = await buildAuthSnapshot(deps({
    cookieStatus: () => ({ present: false }),
    cookieProbe: async () => ({ ok: false, reason: 'session_not_configured' }),
  }));
  assert.strictEqual(s.cookie.configured, false);
  assert.strictEqual(s.cookie.ok, false);
});

test('never throws when a dep throws → degrades', async () => {
  const s = await buildAuthSnapshot(deps({
    refreshOAuth: async () => { throw new Error('net'); },
    oauthStatus: () => { throw new Error('boom'); },
    cookieProbe: async () => { throw new Error('429'); },
  }));
  assert.strictEqual(s.oauth.present, false);   // degraded
  assert.strictEqual(s.cookie.ok, false);
  assert.ok(typeof s.checkedAt === 'number');
});

test('snapshot contains NO token/cookie secret fields', async () => {
  const s = await buildAuthSnapshot(deps({}));
  const json = JSON.stringify(s);
  for (const k of ['accessToken', 'refreshToken', 'sessionKey', 'cf_clearance', 'sk-ant']) {
    assert.ok(!json.includes(k), `snapshot leaked ${k}`);
  }
});
