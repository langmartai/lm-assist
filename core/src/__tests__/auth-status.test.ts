import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_STATUS_HANDLERS } from '../mcp-server/tools/auth-status';

/**
 * auth_status aggregates the node's credential health: the claude.ai web cookie
 * session (/claude-ai/healthz) and the Claude Code OAuth token
 * (/claude-code/oauth-status). No secrets — presence/validity/expiry only.
 */

const realFetch = global.fetch;

// Route the two workerGet calls by URL to canned envelopes.
function stub(routes: Record<string, unknown>): void {
  // @ts-expect-error test stub
  global.fetch = async (url: string) => {
    const u = String(url);
    const key = Object.keys(routes).find((k) => u.includes(k));
    const payload = key ? { success: true, data: routes[key] } : { success: false, error: 'no route' };
    const text = JSON.stringify(payload);
    return { ok: !!key, status: key ? 200 : 404, async text() { return text; }, async json() { return payload; } };
  };
}

afterEach(() => { global.fetch = realFetch; });

test('auth_status: both healthy → reports logged-in identity + valid OAuth with expiry', async () => {
  stub({
    '/claude-ai/healthz': {
      ok: true, reason: 'ok', sessionConfigured: true,
      identity: { email: 'yi@example.com' },
      cookieFreshness: { hasSessionKey: true, hasCfClearance: true, hasCfBm: true },
    },
    '/claude-code/oauth-status': {
      present: true, expired: false, msUntilExpiry: 23 * 3600 * 1000,
      subscriptionType: 'max', rateLimitTier: 'tier-4', scopes: ['user:inference'],
    },
  });
  const res = await AUTH_STATUS_HANDLERS.auth_status({});
  const t = res.content[0].text;
  assert.notEqual(res.isError, true);
  assert.match(t, /claude\.ai/i);
  assert.match(t, /yi@example\.com/);
  assert.match(t, /Claude Code OAuth/i);
  assert.match(t, /valid/i);
  assert.match(t, /23h/);            // human expiry
  assert.match(t, /max/);            // subscription
});

test('auth_status: claude.ai not configured → shows the reason + hint, not a crash', async () => {
  stub({
    '/claude-ai/healthz': {
      ok: false, reason: 'session_not_configured',
      hint: 'create ~/.claude/claudeai-session.json',
      sessionConfigured: false, cookieFreshness: {},
    },
    '/claude-code/oauth-status': { present: true, expired: false, msUntilExpiry: 60 * 60 * 1000 },
  });
  const res = await AUTH_STATUS_HANDLERS.auth_status({});
  const t = res.content[0].text;
  assert.match(t, /not configured|session_not_configured/i);
  assert.match(t, /claudeai-session\.json/);
});

test('auth_status: expired OAuth is flagged EXPIRED', async () => {
  stub({
    '/claude-ai/healthz': { ok: true, reason: 'ok', sessionConfigured: true, identity: {}, cookieFreshness: {} },
    '/claude-code/oauth-status': { present: true, expired: true, msUntilExpiry: -5000 },
  });
  const res = await AUTH_STATUS_HANDLERS.auth_status({});
  assert.match(res.content[0].text, /expired/i);
});

test('auth_status: which="claude_code" only queries OAuth', async () => {
  let hitHealthz = false;
  // @ts-expect-error test stub
  global.fetch = async (url: string) => {
    const u = String(url);
    if (u.includes('/claude-ai/healthz')) hitHealthz = true;
    const payload = { success: true, data: { present: true, expired: false, msUntilExpiry: 1000 } };
    const text = JSON.stringify(payload);
    return { ok: true, status: 200, async text() { return text; }, async json() { return payload; } };
  };
  const res = await AUTH_STATUS_HANDLERS.auth_status({ which: 'claude_code' });
  assert.equal(hitHealthz, false, 'must not query claude.ai when scoped to claude_code');
  assert.match(res.content[0].text, /Claude Code OAuth/i);
  assert.doesNotMatch(res.content[0].text, /claude\.ai web/i);
});
