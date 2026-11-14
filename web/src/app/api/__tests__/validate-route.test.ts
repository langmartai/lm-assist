import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/validate/route';

let dir = '';
const saved = process.env.LM_ASSIST_DATA_DIR;
const key = randomBytes(32).toString('hex');

function writeConfig(cfg: object) {
  writeFileSync(path.join(dir, 'assist-config.json'), JSON.stringify(cfg), { mode: 0o600 });
}
async function validate(token: unknown): Promise<boolean> {
  const res = await POST(new NextRequest('http://localhost:3948/api/auth/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }));
  return (await res.json()).valid;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lm-web-validate-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.LM_ASSIST_DATA_DIR; else process.env.LM_ASSIST_DATA_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/auth/validate', () => {
  it('with LAN access switched off, no key is valid (it used to answer true)', async () => {
    writeConfig({ lanAuthEnabled: false, lanAccessToken: key });
    expect(await validate(key)).toBe(false);
    expect(await validate('anything')).toBe(false);
  });

  it('accepts the configured key and rejects a wrong one', async () => {
    writeConfig({ lanAuthEnabled: true, lanAccessToken: key });
    expect(await validate(key)).toBe(true);
    expect(await validate(key.slice(0, -1) + (key.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(await validate('short')).toBe(false);
  });

  it('rejects a same-length key with multi-byte characters instead of throwing', async () => {
    writeConfig({ lanAccessToken: key });
    expect(await validate('é'.repeat(key.length))).toBe(false);
  });

  it('reads the config from LM_ASSIST_DATA_DIR (as Core does)', async () => {
    expect(await validate(key)).toBe(false); // no file there yet
    writeConfig({ lanAccessToken: key });
    expect(await validate(key)).toBe(true);
  });
});
