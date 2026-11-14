import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Static guards for the Stage-1 browser-auth fix: the node's Core token must not
// come back into the page through a window global, a second reader of the token
// file, the deleted token-serving routes, or a LAN key built into a URL.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      out.push(...sourceFiles(p));
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const files = sourceFiles(SRC).map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join('/'), text: readFileSync(f, 'utf8') }));

describe('no Core token reaches the page', () => {
  it('walks a non-trivial tree', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('no source mentions the removed window.__LM_API_TOKEN__ global', () => {
    expect(files.filter((f) => f.text.includes('__LM_API_TOKEN__')).map((f) => f.rel)).toEqual([]);
  });

  it("only lib/server-auth.ts reads the 'api-token' file", () => {
    const readers = files.filter((f) => /['"`]api-token['"`]/.test(f.text)).map((f) => f.rel);
    expect(readers).toEqual(['lib/server-auth.ts']);
  });

  it('the token-serving routes are gone', () => {
    expect(existsSync(path.join(SRC, 'app/api/auth/token/route.ts'))).toBe(false);
    expect(existsSync(path.join(SRC, 'app/api/auth/cloud-verify/route.ts'))).toBe(false);
  });

  it('no source builds a /auth?token= link', () => {
    expect(files.filter((f) => f.text.includes('/auth?token=')).map((f) => f.rel)).toEqual([]);
  });
});
