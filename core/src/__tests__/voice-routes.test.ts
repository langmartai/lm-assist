import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceRoutes } from '../routes/core/voice.routes';
import * as voiceCapability from '../voice/voice-v2-capability';
import * as claudeaiSession from '../utils/claudeai-session';
import type { RouteContext } from '../routes/index';

// GET /voice/claude/capability wires voiceV2Capability() (already unit-tested in
// voice-v2-capability.test.ts) to three live inputs: the LM_HTTPS flag, the claude.ai
// cookie file, and resolveChromePath(). These tests cover the WIRING, not the pure
// decision logic — one deterministic branch (https off — needs no mocking, so it can
// never be flaky regardless of the test machine's cookie file / installed Chrome) plus
// two mocked branches for cookie-missing and all-present.
function capabilityHandler() {
  const routes = createVoiceRoutes({} as RouteContext);
  const route = routes.find((r) => r.method === 'GET' && r.pattern.test('/voice/claude/capability'));
  assert.ok(route, 'GET /voice/claude/capability must be registered');
  return route!.handler;
}

test('LM_HTTPS off -> unavailable, names https (deterministic — no mocking needed)', async () => {
  const prevHttps = process.env.LM_HTTPS;
  try {
    delete process.env.LM_HTTPS;
    const res = await capabilityHandler()({} as any, {} as any);
    assert.equal(res.data.available, false);
    assert.match(res.data.reason, /https/i);
  } finally {
    if (prevHttps === undefined) delete process.env.LM_HTTPS; else process.env.LM_HTTPS = prevHttps;
  }
});

test('LM_HTTPS on + no cookie -> unavailable, names cookie', async () => {
  const prevHttps = process.env.LM_HTTPS;
  const cookieMock = mock.method(claudeaiSession, 'readClaudeAISession', () => null);
  const chromeMock = mock.method(voiceCapability, 'resolveChromePath', () => '/usr/bin/google-chrome');
  try {
    process.env.LM_HTTPS = '1';
    const res = await capabilityHandler()({} as any, {} as any);
    assert.equal(res.data.available, false);
    assert.match(res.data.reason, /cookie/i);
  } finally {
    if (prevHttps === undefined) delete process.env.LM_HTTPS; else process.env.LM_HTTPS = prevHttps;
    cookieMock.mock.restore();
    chromeMock.mock.restore();
  }
});

test('https + cookie + chrome all present -> available', async () => {
  const prevHttps = process.env.LM_HTTPS;
  const cookieMock = mock.method(claudeaiSession, 'readClaudeAISession', () => ({ cookie: 'sessionKey=sk-ant-sid-x' }));
  const chromeMock = mock.method(voiceCapability, 'resolveChromePath', () => '/usr/bin/google-chrome');
  try {
    process.env.LM_HTTPS = 'true';
    const res = await capabilityHandler()({} as any, {} as any);
    assert.equal(res.data.available, true);
    assert.equal(res.data.reason, 'ok');
  } finally {
    if (prevHttps === undefined) delete process.env.LM_HTTPS; else process.env.LM_HTTPS = prevHttps;
    cookieMock.mock.restore();
    chromeMock.mock.restore();
  }
});
