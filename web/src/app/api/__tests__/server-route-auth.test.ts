import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { GET, POST, PUT } from '@/app/api/server/route';

// PUT/POST /api/server change who may reach the dashboard (and can run core.sh), so
// they demand a same-origin Origin plus a Core token that Core itself vouches for.

const WEB = 'http://10.0.0.5:3948';
let dir = '';
const saved = { dir: process.env.LM_ASSIST_DATA_DIR, port: process.env.LM_LOCAL_API_PORT };

function req(method: string, headers: Record<string, string>, body?: unknown): NextRequest {
  return new NextRequest(`${WEB}/api/server`, {
    method,
    headers: { host: '10.0.0.5:3948', 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Core's GET /auth/check, answering `status` (or throwing when Core is down). */
function stubCoreCheck(status: number | 'down') {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
    if (status === 'down') throw new TypeError('fetch failed');
    return status === 200
      ? new Response(JSON.stringify({ success: true, data: { valid: true } }), { status: 200 })
      : new Response(JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED' } }), { status });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lm-web-server-route-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
  process.env.LM_LOCAL_API_PORT = '3200';
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (saved.dir === undefined) delete process.env.LM_ASSIST_DATA_DIR; else process.env.LM_ASSIST_DATA_DIR = saved.dir;
  if (saved.port === undefined) delete process.env.LM_LOCAL_API_PORT; else process.env.LM_LOCAL_API_PORT = saved.port;
  rmSync(dir, { recursive: true, force: true });
});

describe('PUT /api/server', () => {
  it('403 without an Origin', async () => {
    const fetchFn = stubCoreCheck(200);
    const res = await PUT(req('PUT', { 'x-api-key': 'k' }, { lanAuthEnabled: false }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('ORIGIN_REQUIRED');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('403 for a cross-origin caller', async () => {
    stubCoreCheck(200);
    const res = await PUT(req('PUT', { origin: 'http://evil.example', 'x-api-key': 'k' }, { lanAuthEnabled: false }));
    expect(res.status).toBe(403);
  });

  it('403 when the Origin port differs from the Host port', async () => {
    stubCoreCheck(200);
    const res = await PUT(req('PUT', { origin: 'http://10.0.0.5:3848', 'x-api-key': 'k' }, { lanAuthEnabled: false }));
    expect(res.status).toBe(403);
  });

  it('401 same-origin without a key', async () => {
    const fetchFn = stubCoreCheck(200);
    const res = await PUT(req('PUT', { origin: WEB }, { lanAuthEnabled: false }));
    expect(res.status).toBe(401);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('401 when Core rejects the key', async () => {
    stubCoreCheck(401);
    const res = await PUT(req('PUT', { origin: WEB, 'x-api-key': 'wrong' }, { lanAuthEnabled: false }));
    expect(res.status).toBe(401);
  });

  it('503 (fail closed) when Core is down', async () => {
    stubCoreCheck('down');
    const res = await PUT(req('PUT', { origin: WEB, 'x-api-key': 'k' }, { lanAuthEnabled: false }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('CORE_UNREACHABLE');
  });

  it('an authorized call asks Core, then writes the setting to the data dir (0600)', async () => {
    const fetchFn = stubCoreCheck(200);
    const res = await PUT(req('PUT', { origin: WEB, 'x-api-key': 'good' }, { lanAuthEnabled: false }));
    expect(res.status).toBe(200);
    expect((await res.json()).config.lanAuthEnabled).toBe(false);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3200/auth/check');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('good');

    const file = path.join(dir, 'assist-config.json');
    expect(JSON.parse(readFileSync(file, 'utf8')).lanAuthEnabled).toBe(false);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('POST /api/server', () => {
  // Only the refusals: an authorized POST would run a core.sh on this machine.
  it('is gated exactly like PUT', async () => {
    stubCoreCheck(200);
    expect((await POST(req('POST', {}, { action: 'start' }))).status).toBe(403);
    expect((await POST(req('POST', { origin: 'http://evil.example', 'x-api-key': 'k' }, { action: 'start' }))).status).toBe(403);
    expect((await POST(req('POST', { origin: WEB }, { action: 'start' }))).status).toBe(401);
    stubCoreCheck(401);
    expect((await POST(req('POST', { origin: WEB, 'x-api-key': 'wrong' }, { action: 'start' }))).status).toBe(401);
    stubCoreCheck('down');
    expect((await POST(req('POST', { origin: WEB, 'x-api-key': 'k' }, { action: 'start' }))).status).toBe(503);
  });
});

describe('GET /api/server', () => {
  it('stays public and discloses no filesystem path', async () => {
    const fetchFn = stubCoreCheck(200);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty('tierAgentDir');
    expect(body).toHaveProperty('coreShExists');
    expect(body.lanAuthEnabled).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
