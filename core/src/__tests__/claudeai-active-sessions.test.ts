import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDEAI_ACTIVE_SESSIONS_HANDLERS } from '../mcp-server/tools/claudeai-active-sessions';

const realFetch = global.fetch;

function stub(payload: unknown, ok = true): void {
  // @ts-expect-error test stub
  global.fetch = async () => {
    const env = ok ? { success: true, data: payload } : { success: false, error: { message: 'session_expired' } };
    const text = JSON.stringify(env);
    return { ok, status: ok ? 200 : 401, async text() { return text; }, async json() { return env; } };
  };
}

afterEach(() => { global.fetch = realFetch; });

const SAMPLE = [
  {
    updated_at: '2026-06-19T17:29:00Z', expires_at: '2026-07-17T17:29:00Z',
    user_agent: { browser_family: 'Chrome Mobile iOS', browser_version: '149.0', os_family: 'iOS', device_family: 'iPad' },
    location_info: { country: 'SG', city: 'Singapore' }, is_current: true,
  },
  {
    updated_at: '2026-06-16T20:10:00Z', expires_at: '2026-07-14T20:10:00Z',
    user_agent: { browser_family: 'Firefox', browser_version: '141.0', os_family: 'Linux', device_family: 'Other' },
    location_info: { country: 'US', city: 'Ashburn' }, is_current: false,
  },
];

test('claudeai_active_sessions: lists each device with browser + location + current marker', async () => {
  stub(SAMPLE);
  const res = await CLAUDEAI_ACTIVE_SESSIONS_HANDLERS.claudeai_active_sessions({});
  const t = res.content[0].text;
  assert.notEqual(res.isError, true);
  assert.match(t, /iPad/);
  assert.match(t, /Chrome Mobile iOS/);
  assert.match(t, /Singapore/);
  assert.match(t, /current/i);
  assert.match(t, /Firefox/);
  assert.match(t, /Ashburn/);
});

test('claudeai_active_sessions: empty list is stated clearly', async () => {
  stub([]);
  const res = await CLAUDEAI_ACTIVE_SESSIONS_HANDLERS.claudeai_active_sessions({});
  assert.match(res.content[0].text, /no .* sessions|0/i);
});

test('claudeai_active_sessions: a session error is a clean error', async () => {
  stub({}, false);
  const res = await CLAUDEAI_ACTIVE_SESSIONS_HANDLERS.claudeai_active_sessions({});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /session_expired/);
});
