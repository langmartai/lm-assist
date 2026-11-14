import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { renderToStaticMarkup } from 'react-dom/server';

// The layout's providers and client widgets are irrelevant to what the HTML
// carries; render them as bare passthroughs so the test sees only the layout's
// own markup.
const passthrough = ({ children }: { children?: unknown }) => children ?? null;
const empty = () => null;
vi.mock('@/contexts/ThemeContext', () => ({ ThemeProvider: passthrough }));
vi.mock('@/contexts/AppModeContext', () => ({ AppModeProvider: passthrough }));
vi.mock('@/components/SessionExpiredOverlay', () => ({ SessionExpiredOverlay: empty }));
vi.mock('@/components/ChunkErrorReloader', () => ({ ChunkErrorReloader: empty }));
vi.mock('@/components/RouteTracker', () => ({ RouteTracker: empty }));
vi.mock('@/app/globals.css', () => ({}));

/** Occurrences of `needle` in `hay` — the test reports a COUNT, never the value. */
function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

describe('root layout carries no credential', () => {
  const saved = { dir: process.env.LM_ASSIST_DATA_DIR, port: process.env.LM_LOCAL_API_PORT };
  let dir = '';
  // A random stand-in for the Core token, written where the old layout read it from.
  const sentinel = randomBytes(32).toString('hex');

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lm-web-layout-'));
    writeFileSync(path.join(dir, 'api-token'), sentinel + '\n', { mode: 0o600 });
    process.env.LM_ASSIST_DATA_DIR = dir;
    process.env.LM_LOCAL_API_PORT = '3200';
  });

  afterAll(() => {
    if (saved.dir === undefined) delete process.env.LM_ASSIST_DATA_DIR; else process.env.LM_ASSIST_DATA_DIR = saved.dir;
    if (saved.port === undefined) delete process.env.LM_LOCAL_API_PORT; else process.env.LM_LOCAL_API_PORT = saved.port;
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders the Core port but never the token', async () => {
    const { default: RootLayout } = await import('@/app/layout');
    const html = renderToStaticMarkup(RootLayout({ children: null }) as any);

    expect(count(html, sentinel)).toBe(0);
    expect(html.includes('__LM_API_TOKEN__')).toBe(false);
    expect(html.includes('__LM_LOCAL_API_PORT__')).toBe(true);
    expect(html.includes('"3200"')).toBe(true);
  });
});
