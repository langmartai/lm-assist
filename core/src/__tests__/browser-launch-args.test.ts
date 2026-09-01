import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrowserArgs } from '../utils/claudeai-browser-launch';

/**
 * The launcher serves more than its original claude.ai-login job: connectors
 * launch their own persistent-profile browsers through it. The start URL must
 * therefore be an option — a LinkedIn or Gmail login window opening on
 * claude.ai reads as "wrong browser" to the operator standing at the machine
 * (measured 2026-09-01: the login flow converged only via a post-launch
 * Page.navigate, with the window first painting claude.ai).
 */

test('chromium args default to the claude.ai start URL (original behavior)', () => {
  const args = buildBrowserArgs('chromium', { port: 9222, userDataDir: '/tmp/p' });
  assert.ok(args.includes('https://claude.ai/'));
  assert.ok(args.includes('--user-data-dir=/tmp/p'));
  assert.ok(args.includes('--remote-debugging-port=9222'));
});

test('chromium args honor a caller start URL and drop the claude.ai default', () => {
  const args = buildBrowserArgs('chromium', {
    port: 9223,
    userDataDir: '/tmp/li',
    startUrl: 'https://www.linkedin.com/feed/',
  });
  assert.ok(args.includes('https://www.linkedin.com/feed/'));
  assert.ok(!args.includes('https://claude.ai/'));
});

test('firefox args honor the start URL too', () => {
  const args = buildBrowserArgs('firefox', {
    port: 9224,
    userDataDir: '/tmp/ff',
    startUrl: 'https://mail.google.com/mail/u/0/',
    headless: true,
  });
  assert.ok(args.includes('https://mail.google.com/mail/u/0/'));
  assert.ok(!args.includes('https://claude.ai/'));
  assert.ok(args.includes('--headless'));
});

test('profile-directory and extraArgs keep their positions', () => {
  const args = buildBrowserArgs('chromium', {
    port: 9222,
    userDataDir: '/tmp/p',
    profileDirectory: 'Profile 1',
    extraArgs: ['--user-agent=x'],
  });
  assert.equal(args[0], '--profile-directory=Profile 1');
  assert.equal(args[args.length - 1], '--user-agent=x');
});
