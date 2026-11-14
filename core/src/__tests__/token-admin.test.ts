/**
 * `cli.js token …` — explicit operator commands. Runs ONLY against an mkdtemp
 * LM_ASSIST_DATA_DIR: a rotate-now on a live data dir would cut off every Core and
 * client sharing it. Output is checked to contain no secret (includes === false).
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTokenCommand } from '../auth/token-admin';
import { apiTokenFilePath, isValidToken, currentApiToken, __resetApiTokenState } from '../auth/api-token';
import { assistConfigPath } from '../auth/lan-access';

let dir = '';
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-admin-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
});
beforeEach(() => {
  __resetApiTokenState();
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
});
after(() => {
  __resetApiTokenState();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function run(argv: string[]): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await runTokenCommand(argv, (l) => lines.push(l), (l) => lines.push(l));
  return { code, text: lines.join('\n') };
}

const readTok = () => fs.readFileSync(apiTokenFilePath(), 'utf8').trim();
const LAN_KEY = 'b'.repeat(64);
function seedAssistConfig(): void {
  fs.writeFileSync(assistConfigPath(), JSON.stringify({ lanEnabled: true, lanAuthEnabled: true, lanAccessToken: LAN_KEY, hubUrl: 'wss://hub.example' }), { mode: 0o644 });
}

test('rotate --now: exit 0, token file changes, old token dead, output carries no secret', async () => {
  fs.writeFileSync(apiTokenFilePath(), 'c'.repeat(64) + '\n', { mode: 0o600 });
  const old = readTok();
  const r = await run(['rotate', '--now']);
  const fresh = readTok();
  assert.equal(r.code, 0);
  assert.notEqual(fresh, old);
  assert.equal(r.text.includes(old), false, 'old token must not be printed');
  assert.equal(r.text.includes(fresh), false, 'new token must not be printed');
  assert.match(r.text, /tokens revoked:\s+\d+/);
  assert.match(r.text, /Restart any OLDER Core/);
  assert.equal(isValidToken(old), false);
});

test('rotate --now --lan-key also regenerates the LAN key, without printing it', async () => {
  seedAssistConfig();
  const r = await run(['rotate', '--now', '--lan-key']);
  assert.equal(r.code, 0);
  const cfg = JSON.parse(fs.readFileSync(assistConfigPath(), 'utf8'));
  assert.notEqual(cfg.lanAccessToken, LAN_KEY);
  assert.equal(r.text.includes(cfg.lanAccessToken), false);
  assert.equal(r.text.includes(LAN_KEY), false);
});

test('rotate without --now refuses with exit 2 and changes nothing', async () => {
  fs.writeFileSync(apiTokenFilePath(), 'c'.repeat(64) + '\n', { mode: 0o600 });
  const r = await run(['rotate']);
  assert.equal(r.code, 2);
  assert.equal(readTok(), 'c'.repeat(64));
});

test('lan-key --regenerate: new key, other fields kept, file 0600; without the flag exit 2', async () => {
  seedAssistConfig();
  assert.equal((await run(['lan-key'])).code, 2);
  const r = await run(['lan-key', '--regenerate']);
  assert.equal(r.code, 0);
  const cfg = JSON.parse(fs.readFileSync(assistConfigPath(), 'utf8'));
  assert.match(cfg.lanAccessToken, /^[0-9a-f]{64}$/);
  assert.notEqual(cfg.lanAccessToken, LAN_KEY);
  assert.equal(cfg.lanEnabled, true);
  assert.equal(cfg.lanAuthEnabled, true);
  assert.equal(cfg.hubUrl, 'wss://hub.example');
  if (process.platform !== 'win32') assert.equal(fs.statSync(assistConfigPath()).mode & 0o777, 0o600);
  assert.equal(r.text.includes(cfg.lanAccessToken), false);
});

test('lan-key --regenerate does not claim to sign devices out: it says they keep access until rotate --now', async () => {
  seedAssistConfig();
  currentApiToken(); // a node that has a ring token (inits the file in the temp dir)
  const before = readTok();
  const r = await run(['lan-key', '--regenerate']);
  assert.equal(r.code, 0);
  // It does NOT revoke the ring token, so it must not say every browser signs in again.
  assert.equal(readTok(), before, 'lan-key alone leaves the ring token alone');
  assert.ok(isValidToken(before), 'a device holding the ring token keeps access');
  assert.doesNotMatch(r.text, /every LAN browser must sign in again/);
  assert.match(r.text, /KEEP ACCESS/);
  assert.match(r.text, /token rotate --now/);
});

test('status prints state but never a token or the LAN key', async () => {
  seedAssistConfig();
  fs.writeFileSync(apiTokenFilePath(), 'd'.repeat(64) + '\n', { mode: 0o600 });
  const r = await run(['status']);
  assert.equal(r.code, 0);
  assert.equal(r.text.includes('d'.repeat(64)), false);
  assert.equal(r.text.includes(LAN_KEY), false);
  assert.match(r.text, /LAN key configured:\s+yes/);
  assert.match(r.text, /lanAuthEnabled:\s+true/);
  assert.match(r.text, /grace tokens:\s+\d+/);
  assert.match(r.text, /revoked tokens:\s+\d+/);
});

test('status is read-only: on an empty data dir it writes nothing', async () => {
  const r = await run(['status']);
  assert.equal(r.code, 0);
  assert.deepEqual(fs.readdirSync(dir), [], 'status must not create a token, meta or config file');
  assert.match(r.text, /token file written:\s+missing/);
});

test('unknown subcommand → exit 2', async () => {
  assert.equal((await run(['frobnicate'])).code, 2);
  assert.equal((await run([])).code, 2);
});
