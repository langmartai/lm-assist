import { test } from 'node:test';
import assert from 'node:assert';
import { getHubHttpUrl, hubFetch, proxyFetch, proxyPost, proxyGet } from '../hub-client/hub-proxy';

// Capture the last fetch call without depending on the box's hub config (base URL varies).
type Captured = { url: string; init: any };
function withMockFetch(response: { ok: boolean; status?: number; json?: unknown }, fn: (cap: () => Captured) => Promise<void>) {
  const orig = globalThis.fetch;
  let last: Captured = { url: '', init: undefined };
  (globalThis as any).fetch = async (url: any, init: any) => {
    last = { url: String(url), init };
    return { ok: response.ok, status: response.status ?? (response.ok ? 200 : 500), json: async () => response.json ?? {} } as any;
  };
  return (async () => { try { await fn(() => last); } finally { (globalThis as any).fetch = orig; } })();
}

test('getHubHttpUrl converts ws/wss → http/https (never leaves a ws scheme)', () => {
  const u = getHubHttpUrl();
  // Empty (unconfigured) or an http(s) URL — an unconverted ws/wss would start with "ws".
  assert.ok(!u.startsWith('ws'), `expected no ws scheme, got: ${u}`);
});

test('proxyFetch addresses the peer by the gatewayId in the machine-proxy path + Bearer auth', async () => {
  await withMockFetch({ ok: true, json: { ok: 1 } }, async (cap) => {
    const out = await proxyFetch('gw4-abc123', '/data/ds/export');
    assert.deepEqual(out, { ok: 1 });
    const { url, init } = cap();
    assert.ok(url.endsWith('/api/tier-agent/machines/gw4-abc123/proxy/data/ds/export'), `url was: ${url}`);
    assert.match(String(init.headers.Authorization), /^Bearer /);
  });
});

test('proxyFetch merges extraHeaders (e.g. access-key)', async () => {
  await withMockFetch({ ok: true }, async (cap) => {
    await proxyFetch('gw4-x', '/data/d/fetch', { extraHeaders: { 'x-lm-access-key': 'k.secret' } });
    assert.equal(cap().init.headers['x-lm-access-key'], 'k.secret');
  });
});

test('proxyPost sends POST + JSON body + content-type', async () => {
  await withMockFetch({ ok: true, json: { data: [] } }, async (cap) => {
    await proxyPost('gw4-y', '/data/d/export', { since: '2026-01-01' });
    const { url, init } = cap();
    assert.ok(url.endsWith('/api/tier-agent/machines/gw4-y/proxy/data/d/export'));
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.body, JSON.stringify({ since: '2026-01-01' }));
  });
});

test('proxyGet delegates to a GET proxyFetch (no body)', async () => {
  await withMockFetch({ ok: true }, async (cap) => {
    await proxyGet('gw4-z', '/sessions/s1/exists');
    const { url, init } = cap();
    assert.ok(url.endsWith('/api/tier-agent/machines/gw4-z/proxy/sessions/s1/exists'));
    assert.ok(init.method === undefined || init.method === 'GET');
    assert.equal(init.body, undefined);
  });
});

test('helpers throw on a non-2xx hub response', async () => {
  await withMockFetch({ ok: false, status: 502 }, async () => {
    await assert.rejects(() => proxyFetch('gw4-a', '/x'), /returned 502/);
    await assert.rejects(() => proxyPost('gw4-a', '/x', {}), /returned 502/);
    await assert.rejects(() => hubFetch('/api/tier-agent/machines'), /Hub returned 502/);
  });
});
