import { test } from 'node:test';
import assert from 'node:assert';
import { decideCookieAction } from '../mcp-server/tools/claudeai-login';

test('cookie already healthy → already-ok (no browser)', () => {
  assert.strictEqual(decideCookieAction({ healthy: true, browserRequested: false, hasDesktopBrowser: true }), 'already-ok');
});
test('unhealthy + browser requested + desktop browser → launch', () => {
  assert.strictEqual(decideCookieAction({ healthy: false, browserRequested: true, hasDesktopBrowser: true }), 'launch');
});
test('unhealthy + desktop browser, no explicit request → launch (auto)', () => {
  assert.strictEqual(decideCookieAction({ healthy: false, browserRequested: false, hasDesktopBrowser: true }), 'launch');
});
test('unhealthy + NO desktop browser → manual', () => {
  assert.strictEqual(decideCookieAction({ healthy: false, browserRequested: false, hasDesktopBrowser: false }), 'manual');
});
test('unhealthy + browser requested but NO desktop browser → manual (cannot launch)', () => {
  assert.strictEqual(decideCookieAction({ healthy: false, browserRequested: true, hasDesktopBrowser: false }), 'manual');
});
