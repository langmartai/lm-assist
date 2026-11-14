import { describe, it, expect } from 'vitest';
import nextConfig from '../../../next.config';

// Every dashboard response must refuse third-party framing (clickjacking the cloud-connect
// confirm rebinds the node to another hub account). Allowed ancestors: same origin and the
// LangMart platform, which shows hub-proxied pages in an iframe.

describe('next.config headers(): frame-ancestors', () => {
  it('sends a frame-ancestors CSP on every path', async () => {
    const rules = (await nextConfig.headers!()) as { source: string; headers: { key: string; value: string }[] }[];
    const all = rules.find((r) => r.source === '/:path*');
    expect(all).toBeTruthy();
    const csp = all!.headers.find((h) => h.key.toLowerCase() === 'content-security-policy');
    expect(csp).toBeTruthy();
    const v = csp!.value;
    expect(v).toMatch(/^frame-ancestors /);
    expect(v).toContain("'self'");
    expect(v).toContain('https://langmart.ai');
    expect(v).toContain('https://*.langmart.ai');
    expect(v).toContain('https://*.xeenhub.com');
  });

  it('allows no arbitrary ancestor and adds no fetch directives that would break the app', async () => {
    const rules = (await nextConfig.headers!()) as { source: string; headers: { key: string; value: string }[] }[];
    const v = rules.find((r) => r.source === '/:path*')!.headers.find((h) => h.key === 'Content-Security-Policy')!.value;
    const sources = v.replace(/^frame-ancestors\s+/, '').split(/\s+/);
    for (const s of sources) {
      expect(s === "'self'" || /^https:\/\/(\*\.)?[a-z0-9.-]+\.[a-z]+$/.test(s)).toBe(true);
      expect(s).not.toBe('*');
      expect(s).not.toMatch(/^https?:$|^http:\/\//);
    }
    expect(v).not.toMatch(/default-src|script-src|style-src|;/);
  });
});
