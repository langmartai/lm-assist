import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/auth/cloud-connect/route';

// The popup fallback must not bind anything: any page can navigate a browser here.

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/auth/cloud-connect', () => {
  it('303s to the settings confirm card with the key in the FRAGMENT and makes no Core call', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    const res = await GET(new NextRequest('http://localhost:3948/api/auth/cloud-connect?key=k&hubUrl=wss://assist-api.langmart.ai'));

    expect(res.status).toBe(303);
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith('/settings#')).toBe(true);
    const frag = new URLSearchParams(loc.slice('/settings#'.length));
    expect(frag.get('cloudConnect')).toBe('1');
    expect(frag.get('key')).toBe('k');
    expect(frag.get('hubUrl')).toBe('wss://assist-api.langmart.ai');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('400 without a key', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    const res = await GET(new NextRequest('http://localhost:3948/api/auth/cloud-connect'));
    expect(res.status).toBe(400);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
