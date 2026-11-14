import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootstrapBrowserAuth, resetBrowserToken } from '../api-client';
import { buildVoiceWsUrl, buildClaudeVoiceWsUrl, withFreshVoiceToken } from '../voice-url';

function stubPage(href: string) {
  const u = new URL(href);
  vi.stubGlobal('window', {
    location: { href: u.href, origin: u.origin, protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash },
    __LM_LOCAL_API_PORT__: '3200',
  });
}

/** Seed the api-client token cache the way the dashboard guard does: one bootstrap. */
async function seedToken(token: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ success: true, data: { token, via: 'local', expiresAt: null } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )));
  await bootstrapBrowserAuth({ force: true });
}

beforeEach(() => {
  resetBrowserToken();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  stubPage('http://localhost:3948/cowork');
});

afterEach(() => {
  resetBrowserToken();
  vi.unstubAllGlobals();
});

describe('voice URLs take the token from the runtime bootstrap', () => {
  it('buildVoiceWsUrl on http://localhost carries the cached token', async () => {
    await seedToken('tok-voice');
    expect(buildVoiceWsUrl({ isRemoteNode: false })).toBe('ws://127.0.0.1:3200/voice/stt/ws?token=tok-voice');
    expect(buildClaudeVoiceWsUrl({ isRemoteNode: false })).toBe('ws://127.0.0.1:3200/voice/claude/ws?token=tok-voice');
  });

  it('with nothing cached the URL has no token (and no window global is consulted)', () => {
    (globalThis as any).window.__LM_API_TOKEN__ = 'must-not-be-used';
    expect(buildVoiceWsUrl({ isRemoteNode: false })).toBe('ws://127.0.0.1:3200/voice/stt/ws');
  });

  it('withFreshVoiceToken swaps a stale token for the current one', async () => {
    await seedToken('tok-new');
    expect(withFreshVoiceToken('ws://127.0.0.1:3200/voice/stt/ws?token=tok-old'))
      .toBe('ws://127.0.0.1:3200/voice/stt/ws?token=tok-new');
    expect(withFreshVoiceToken('wss://10.0.0.5:3949/voice/claude/ws'))
      .toBe('wss://10.0.0.5:3949/voice/claude/ws?token=tok-new');
  });

  it('withFreshVoiceToken leaves the URL unchanged when nothing is cached', () => {
    const url = 'ws://127.0.0.1:3200/voice/stt/ws?token=tok-old';
    expect(withFreshVoiceToken(url)).toBe(url);
  });
});
