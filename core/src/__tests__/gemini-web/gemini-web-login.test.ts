import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  DEFAULT_GEMINI_CDP_PORT,
  GEMINI_DATA_DIR,
  GEMINI_LOGIN_URL,
  geminiProfileDir,
  shouldRedirectToLogin,
} from '../../utils/gemini-web-login';
import { createGeminiWebRoutes } from '../../routes/core/gemini-web.routes';

test('geminiProfileDir, shouldRedirectToLogin, and login routes behave as expected', async () => {
  assert.equal(DEFAULT_GEMINI_CDP_PORT, 9225);
  assert.match(GEMINI_LOGIN_URL, /^https:\/\/accounts\.google\.com\/ServiceLogin\?continue=.*gemini\.google\.com/);
  assert.equal(shouldRedirectToLogin({ loggedIn: false, pageUrl: 'https://gemini.google.com/app' }), true);
  assert.equal(shouldRedirectToLogin({ loggedIn: false, pageUrl: null }), true);
  assert.equal(shouldRedirectToLogin({ loggedIn: true, pageUrl: 'https://gemini.google.com/app' }), false);
  assert.equal(
    shouldRedirectToLogin({ loggedIn: false, pageUrl: 'https://accounts.google.com/v3/signin/identifier' }),
    false,
  );
  assert.equal(
    geminiProfileDir('xiaoqiang3020'),
    path.join(GEMINI_DATA_DIR, 'login-profile', 'xiaoqiang3020'),
  );
  assert.equal(
    geminiProfileDir('a/b:c@example.com'),
    path.join(GEMINI_DATA_DIR, 'login-profile', 'a_b_c_example.com'),
  );
  assert.equal(
    geminiProfileDir(''),
    path.join(GEMINI_DATA_DIR, 'login-profile', 'default'),
  );

  const routes = createGeminiWebRoutes({} as never);
  const loginRoute = routes.find((r) => r.method === 'POST' && r.pattern.test('/gemini-web/browser/login'));
  const statusRoute = routes.find((r) => r.method === 'GET' && r.pattern.test('/gemini-web/browser/login/status'));
  assert.ok(loginRoute, 'POST /gemini-web/browser/login should be registered');
  assert.ok(statusRoute, 'GET /gemini-web/browser/login/status should be registered');

  // Querying an unused debug port reports structured unreachable error rather than throwing.
  const statusRes = (await statusRoute!.handler(
    { method: 'GET', path: '/gemini-web/browser/login/status', params: {}, query: { port: '59999' }, body: {} } as never,
    undefined as never,
  )) as { success: boolean; error?: { code: string }; data?: { ok: boolean; loggedIn: boolean } };

  assert.equal(statusRes.success, false);
  assert.equal(statusRes.error?.code, 'DEBUG_PORT_UNREACHABLE');
  assert.equal(statusRes.data?.loggedIn, false);
});
