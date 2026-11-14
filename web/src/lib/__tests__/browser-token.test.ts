import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  bootstrapBrowserAuth,
  isCoreUrl,
  peekBrowserToken,
  resetBrowserToken,
  workerFetch,
} from '../api-client';

// --- a minimal browser: window.location, localStorage, fetch -------------------

function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  };
}

function stubPage(href: string, extra: Record<string, unknown> = {}) {
  const u = new URL(href);
  vi.stubGlobal('window', {
    location: {
      href: u.href, origin: u.origin, protocol: u.protocol, host: u.host,
      hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash,
    },
    __LM_LOCAL_API_PORT__: '3200',
    ...extra,
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const grant = (token: string | null) => json(200, { success: true, data: { token, via: 'local', expiresAt: null } });
const refuse = (status: number, code: string) => json(status, { success: false, error: { code, message: code } });

type Call = { url: string; init: RequestInit };
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return handler(url, init);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}
const tokenCalls = (calls: Call[]) => calls.filter((c) => c.url.endsWith('/auth/browser-token'));
const headerOf = (c: Call, name: string) => (c.init.headers as Record<string, string> | undefined)?.[name];

let storage: Storage;

beforeEach(() => {
  resetBrowserToken();
  storage = makeStorage();
  vi.stubGlobal('localStorage', storage);
  stubPage('http://localhost:3948/sessions');
});

afterEach(() => {
  resetBrowserToken();
  vi.unstubAllGlobals();
});

// --- bootstrap ------------------------------------------------------------------

describe('bootstrapBrowserAuth', () => {
  it('asks this node\'s Core with the client header, and no LAN key when none is stored', async () => {
    const calls = stubFetch(() => grant('tok-A'));
    const r = await bootstrapBrowserAuth();
    expect(r).toEqual({ status: 'ok', token: 'tok-A' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:3200/auth/browser-token');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.cache).toBe('no-store');
    expect(calls[0].init.credentials).toBe('omit');
    expect(headerOf(calls[0], 'X-LM-Client')).toBe('web');
    expect(headerOf(calls[0], 'X-LM-LAN-Key')).toBeUndefined();
    expect(peekBrowserToken()).toBe('tok-A');
  });

  it('sends the stored LAN key', async () => {
    storage.setItem('assist_access_key', 'lan-key-1');
    const calls = stubFetch(() => grant('tok-A'));
    await bootstrapBrowserAuth();
    expect(headerOf(calls[0], 'X-LM-LAN-Key')).toBe('lan-key-1');
  });

  it('dedupes concurrent callers into one request and caches the grant', async () => {
    const calls = stubFetch(() => new Promise((r) => setTimeout(() => r(grant('tok-A')), 10)));
    const rs = await Promise.all([bootstrapBrowserAuth(), bootstrapBrowserAuth(), bootstrapBrowserAuth()]);
    expect(rs.map((r) => r.token)).toEqual(['tok-A', 'tok-A', 'tok-A']);
    await bootstrapBrowserAuth();
    expect(calls).toHaveLength(1);
  });

  it('treats a null token (Core auth switched off) as not-needed', async () => {
    stubFetch(() => grant(null));
    expect(await bootstrapBrowserAuth()).toEqual({ status: 'not-needed', token: null });
  });

  it('is a no-op on a hub-proxied page', async () => {
    stubPage('https://assist.langmart.ai/w/abc/assist/sessions');
    const calls = stubFetch(() => grant('tok-A'));
    expect(await bootstrapBrowserAuth()).toEqual({ status: 'not-needed', token: null });
    expect(calls).toHaveLength(0);
  });

  it('is a no-op on a hub host', async () => {
    stubPage('https://assist.xeenhub.com/sessions');
    const calls = stubFetch(() => grant('tok-A'));
    expect(await bootstrapBrowserAuth()).toEqual({ status: 'not-needed', token: null });
    expect(calls).toHaveLength(0);
  });

  it('uses the same-origin /_coreapi base behind the HTTPS terminator', async () => {
    stubPage('https://10.0.0.5:3949/sessions');
    const calls = stubFetch(() => grant('tok-A'));
    await bootstrapBrowserAuth();
    expect(calls[0].url).toBe('/_coreapi/auth/browser-token');
  });

  it('maps 401 LAN_KEY_INVALID to lan-key-invalid and other 4xx to denied', async () => {
    storage.setItem('assist_access_key', 'stale');
    stubFetch(() => refuse(401, 'LAN_KEY_INVALID'));
    expect((await bootstrapBrowserAuth()).status).toBe('lan-key-invalid');

    resetBrowserToken();
    storage.removeItem('assist_access_key');
    stubFetch(() => refuse(401, 'UNAUTHORIZED'));
    expect((await bootstrapBrowserAuth()).status).toBe('denied');

    resetBrowserToken();
    stubFetch(() => refuse(403, 'ORIGIN_NOT_ALLOWED'));
    expect((await bootstrapBrowserAuth()).status).toBe('denied');
  });

  it('caches a refusal, but asks again at once when the stored key changes or on reset', async () => {
    storage.setItem('assist_access_key', 'stale');
    const calls = stubFetch((_u, init) =>
      (init.headers as Record<string, string>)['X-LM-LAN-Key'] === 'fresh' ? grant('tok-B') : refuse(401, 'LAN_KEY_INVALID'));

    expect((await bootstrapBrowserAuth()).status).toBe('lan-key-invalid');
    expect((await bootstrapBrowserAuth()).status).toBe('lan-key-invalid');
    expect(tokenCalls(calls)).toHaveLength(1); // second answer came from the denial cache

    storage.setItem('assist_access_key', 'fresh');
    expect(await bootstrapBrowserAuth()).toEqual({ status: 'ok', token: 'tok-B' });
    expect(tokenCalls(calls)).toHaveLength(2);

    storage.setItem('assist_access_key', 'stale');
    resetBrowserToken();
    expect((await bootstrapBrowserAuth()).status).toBe('lan-key-invalid');
    resetBrowserToken();
    expect((await bootstrapBrowserAuth()).status).toBe('lan-key-invalid');
    expect(tokenCalls(calls)).toHaveLength(4);
  });

  it('force bypasses the caches', async () => {
    const calls = stubFetch(() => grant('tok-A'));
    await bootstrapBrowserAuth();
    await bootstrapBrowserAuth({ force: true });
    expect(calls).toHaveLength(2);
  });

  it('never caches unreachable (network error or 5xx)', async () => {
    let calls = stubFetch(() => { throw new TypeError('Failed to fetch'); });
    expect((await bootstrapBrowserAuth()).status).toBe('unreachable');
    expect((await bootstrapBrowserAuth()).status).toBe('unreachable');
    expect(calls).toHaveLength(2);

    calls = stubFetch(() => refuse(500, 'INTERNAL'));
    expect(await bootstrapBrowserAuth()).toEqual({ status: 'unreachable', token: null });
    calls = stubFetch(() => grant('tok-A'));
    expect(await bootstrapBrowserAuth()).toEqual({ status: 'ok', token: 'tok-A' });
    expect(calls).toHaveLength(1);
  });

  it('refreshes a token 60 s before a numeric expiresAt (the Stage-2 seam)', async () => {
    let n = 0;
    const calls = stubFetch(() => {
      n++;
      return json(200, { success: true, data: { token: `tok-${n}`, via: 'local', expiresAt: Date.now() + 30_000 } });
    });
    expect((await bootstrapBrowserAuth()).token).toBe('tok-1');
    // Already inside the 60 s lead window, so the next call must ask again.
    expect((await bootstrapBrowserAuth()).token).toBe('tok-2');
    expect(calls).toHaveLength(2);
  });
});

// --- which URLs may carry the token ------------------------------------------------

describe('isCoreUrl', () => {
  it('accepts this node\'s Core and same-origin URLs', () => {
    expect(isCoreUrl('http://127.0.0.1:3200/sessions')).toBe(true);
    expect(isCoreUrl('http://localhost:3200/sessions')).toBe(true);
    expect(isCoreUrl('/api/server')).toBe(true);
    expect(isCoreUrl('http://localhost:3948/api/server')).toBe(true);
  });

  it('accepts Core on the page\'s own LAN host', () => {
    stubPage('http://10.0.0.5:3948/sessions');
    expect(isCoreUrl('http://10.0.0.5:3200/health')).toBe(true);
    expect(isCoreUrl('http://10.0.0.9:3200/health')).toBe(false);
  });

  it('rejects hub URLs, other ports and non-http Core look-alikes', () => {
    expect(isCoreUrl('https://assist-api.langmart.ai/api/machines')).toBe(false);
    expect(isCoreUrl('http://assist-api.langmart.ai:3200/x')).toBe(false);
    expect(isCoreUrl('http://127.0.0.1:3100/sessions')).toBe(false);
    expect(isCoreUrl('https://127.0.0.1:3200/sessions')).toBe(false);
    expect(isCoreUrl('http://localhost:8081/api/machines')).toBe(false);
  });

  it('treats /_coreapi as Core behind the HTTPS terminator', () => {
    stubPage('https://10.0.0.5:3949/sessions');
    expect(isCoreUrl('/_coreapi/sessions')).toBe(true);
    expect(isCoreUrl('https://assist-api.langmart.ai/x')).toBe(false);
  });
});

// --- attaching the token ----------------------------------------------------------

describe('workerFetch', () => {
  it('attaches x-api-key to Core URLs only', async () => {
    const calls = stubFetch((url) => (url.endsWith('/auth/browser-token') ? grant('tok-A') : json(200, { ok: true })));
    await workerFetch('http://127.0.0.1:3200/hub/status');
    await workerFetch('https://assist-api.langmart.ai/api/machines');

    const core = calls.find((c) => c.url === 'http://127.0.0.1:3200/hub/status') as Call;
    const hub = calls.find((c) => c.url.startsWith('https://assist-api.')) as Call;
    expect(headerOf(core, 'x-api-key')).toBe('tok-A');
    expect(headerOf(hub, 'x-api-key')).toBeUndefined();
  });

  it('lets a caller header still win (the existing merge order)', async () => {
    const calls = stubFetch((url) => (url.endsWith('/auth/browser-token') ? grant('tok-A') : json(200, {})));
    await workerFetch('http://127.0.0.1:3200/x', { headers: { 'x-api-key': 'explicit' } });
    expect(headerOf(calls[calls.length - 1], 'x-api-key')).toBe('explicit');
  });

  it('on a 401 re-bootstraps and retries ONCE with the new token', async () => {
    let issued = 0;
    const calls = stubFetch((url, init) => {
      if (url.endsWith('/auth/browser-token')) { issued++; return grant(`tok-${issued}`); }
      return (init.headers as Record<string, string>)['x-api-key'] === 'tok-2' ? json(200, { ok: true }) : refuse(401, 'UNAUTHORIZED');
    });
    const res = await workerFetch('http://127.0.0.1:3200/hub/config', { method: 'PUT', body: '{"a":1}' });
    expect(res.status).toBe(200);
    const coreCalls = calls.filter((c) => c.url.endsWith('/hub/config'));
    expect(coreCalls.map((c) => headerOf(c, 'x-api-key'))).toEqual(['tok-1', 'tok-2']);
    expect(peekBrowserToken()).toBe('tok-2');
  });

  it('does not retry when Core hands back the same token', async () => {
    const calls = stubFetch((url) => (url.endsWith('/auth/browser-token') ? grant('tok-A') : refuse(401, 'UNAUTHORIZED')));
    const res = await workerFetch('http://127.0.0.1:3200/x');
    expect(res.status).toBe(401);
    expect(calls.filter((c) => c.url.endsWith('/x'))).toHaveLength(1);
  });

  it('never retries a stream body', async () => {
    let issued = 0;
    const calls = stubFetch((url) => {
      if (url.endsWith('/auth/browser-token')) { issued++; return grant(`tok-${issued}`); }
      return refuse(401, 'UNAUTHORIZED');
    });
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('x')); c.close(); } });
    const res = await workerFetch('http://127.0.0.1:3200/upload', { method: 'POST', body });
    expect(res.status).toBe(401);
    expect(calls.filter((c) => c.url.endsWith('/upload'))).toHaveLength(1);
    // The dead token was still dropped, so the next call uses the re-fetched one.
    expect(peekBrowserToken()).toBe('tok-2');
  });

  it('does not re-bootstrap on a 401 from a non-Core URL', async () => {
    const calls = stubFetch((url) => (url.endsWith('/auth/browser-token') ? grant('tok-A') : refuse(401, 'NOPE')));
    await workerFetch('https://assist-api.langmart.ai/api/x');
    expect(tokenCalls(calls)).toHaveLength(0);
  });
});
