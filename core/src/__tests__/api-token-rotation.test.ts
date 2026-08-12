/**
 * Rotation persistence + query-key confinement for the local api-token
 * (bl_ff8aad3b fixes 1+3).
 *
 * Fix 1 — the rotation deadline used to be an in-memory setTimeout re-armed
 * from ZERO on every boot, and the accept-ring re-seeded to just [fileToken],
 * so on a fleet that restarts Core more often than ROTATE_MS the token NEVER
 * rotated (measured: a 49-day-old token against a 30-day window). Rotation
 * state now persists in a sidecar (`api-token.meta.json`) next to the token
 * file; the token file itself stays a RAW token string (every other consumer
 * — core.sh, bin/lm-assist.js, ccr-bridge, hooks, web SSR — reads it as-is).
 *
 * Fix 3 — `?apiKey=` query acceptance is confined to the voice WS upgrade
 * paths (browsers cannot set headers on a WS upgrade); every other route must
 * send `x-api-key` so tokens stop landing in URLs / logs / timing entries.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  initApiToken,
  currentApiToken,
  isValidToken,
  rotateApiToken,
  startApiTokenRotation,
  apiTokenFilePath,
  apiTokenMetaFilePath,
  resolveProvidedApiKey,
  __resetApiTokenState,
  __armedRotationMs,
} from '../auth/api-token';

// Defaults from api-token.ts (no env overrides in this test process).
const ROTATE_MS = 30 * 24 * 60 * 60 * 1000;
const RING_SIZE = 3;

let dir: string;
beforeEach(() => {
  __resetApiTokenState();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-token-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
});
after(() => {
  __resetApiTokenState();
  delete process.env.LM_ASSIST_DATA_DIR;
});

const readTokenFile = () => fs.readFileSync(apiTokenFilePath(), 'utf8').trim();
const readMetaFile = () => JSON.parse(fs.readFileSync(apiTokenMetaFilePath(), 'utf8'));

test('fresh boot mints a token, stamps lastRotatedAt in the sidecar, keeps the token file raw', () => {
  const t = initApiToken(1_000);
  assert.match(t, /^[0-9a-f]{64}$/);
  // Token file stays a RAW token string — external consumers cat/trim it.
  assert.strictEqual(readTokenFile(), t);
  const meta = readMetaFile();
  assert.strictEqual(meta.lastRotatedAt, 1_000);
  assert.deepStrictEqual(meta.previous, []);
});

test('overdue at boot rotates IMMEDIATELY; the old token stays in the grace ring', () => {
  const old = initApiToken(1_000);
  __resetApiTokenState(); // restart with a stale lastRotatedAt on disk
  const bootNow = 1_000 + ROTATE_MS + 60_000;
  startApiTokenRotation(bootNow);
  const fresh = readTokenFile();
  assert.notStrictEqual(fresh, old, 'token file must carry a NEW token');
  assert.strictEqual(currentApiToken(), fresh);
  assert.ok(isValidToken(old), 'pre-rotation token must stay valid through the grace window');
  assert.ok(isValidToken(fresh));
  const meta = readMetaFile();
  assert.strictEqual(meta.lastRotatedAt, bootNow);
  assert.ok(meta.previous.includes(old), 'sidecar must persist the retired token');
  // Next full window armed after the catch-up rotation.
  assert.strictEqual(__armedRotationMs(), ROTATE_MS);
});

test('not overdue at boot arms the REMAINING window, not a fresh one, and does not rotate', () => {
  const tok = initApiToken(1_000);
  __resetApiTokenState();
  const bootNow = 1_000 + 10_000; // 10s into the window
  startApiTokenRotation(bootNow);
  assert.strictEqual(readTokenFile(), tok, 'must NOT rotate inside the window');
  assert.strictEqual(__armedRotationMs(), ROTATE_MS - 10_000);
});

test('old ring token still accepted after rotation + restart simulation', () => {
  const a = initApiToken(1_000);
  const b = rotateApiToken(2_000);
  assert.ok(isValidToken(a) && isValidToken(b));
  __resetApiTokenState(); // simulate a Core restart
  assert.strictEqual(initApiToken(3_000), b, 'file token is current after restart');
  assert.ok(isValidToken(a), 'persisted grace ring must survive the restart');
  assert.ok(isValidToken(b));
  // The restart must not restart the rotation window either.
  __resetApiTokenState();
  startApiTokenRotation(2_000 + 5_000);
  assert.strictEqual(__armedRotationMs(), ROTATE_MS - 5_000);
});

test('ring stays capped at RING_SIZE across rotations and restarts', () => {
  const t0 = initApiToken(1_000);
  const t1 = rotateApiToken(2_000);
  const t2 = rotateApiToken(3_000);
  const t3 = rotateApiToken(4_000);
  assert.ok(!isValidToken(t0), 'aged-out token must be rejected');
  assert.ok(isValidToken(t1) && isValidToken(t2) && isValidToken(t3));
  const meta = readMetaFile();
  assert.ok(meta.previous.length <= RING_SIZE - 1);
  __resetApiTokenState();
  initApiToken(5_000);
  assert.ok(!isValidToken(t0));
  assert.ok(isValidToken(t1) && isValidToken(t2) && isValidToken(t3));
});

test('corrupt sidecar fails open: treated as fresh, stamped now, never throws', () => {
  const tok = initApiToken(1_000);
  __resetApiTokenState();
  fs.writeFileSync(apiTokenMetaFilePath(), '{ not json !!!');
  const bootNow = 1_000 + ROTATE_MS * 2; // would be long overdue if meta were readable
  assert.strictEqual(initApiToken(bootNow), tok);
  startApiTokenRotation(bootNow);
  assert.strictEqual(readTokenFile(), tok, 'corrupt meta must NOT force a rotation');
  assert.strictEqual(__armedRotationMs(), ROTATE_MS, 'window restarts from now (pre-sidecar behavior)');
  assert.strictEqual(readMetaFile().lastRotatedAt, bootNow, 'fresh stamp persisted for the next boot');
});

test('missing sidecar (legacy upgrade) fails open the same way', () => {
  const tok = initApiToken(1_000);
  __resetApiTokenState();
  fs.rmSync(apiTokenMetaFilePath());
  startApiTokenRotation(9_999_999);
  assert.strictEqual(readTokenFile(), tok);
  assert.strictEqual(__armedRotationMs(), ROTATE_MS);
  assert.strictEqual(readMetaFile().lastRotatedAt, 9_999_999);
});

test('a rotation by ANOTHER process sharing the dataDir is absorbed on an auth miss', () => {
  // Process A seeds its ring…
  const old = initApiToken(1_000);
  // …then process B (dev and prod cores share <dataDir>/api-token) rotates:
  // new raw token file + sidecar carrying the retired token.
  const fileNow = fs.statSync(apiTokenFilePath()).mtimeMs;
  const next = 'b'.repeat(64);
  fs.writeFileSync(apiTokenFilePath(), next + '\n', { mode: 0o600 });
  fs.writeFileSync(apiTokenMetaFilePath(), JSON.stringify({ v: 1, lastRotatedAt: 2_000, previous: [old] }));
  // Force a distinct mtime so the change is observable regardless of fs timestamp granularity.
  fs.utimesSync(apiTokenFilePath(), new Date(fileNow + 2_000), new Date(fileNow + 2_000));
  assert.ok(isValidToken(next), 'the other process’ new token must be accepted without a restart');
  assert.ok(isValidToken(old), 'our pre-rotation token stays in the grace ring');
});

test('sidecar and token files are written 0600', () => {
  initApiToken(1_000);
  rotateApiToken(2_000);
  assert.strictEqual(fs.statSync(apiTokenFilePath()).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(apiTokenMetaFilePath()).mode & 0o777, 0o600);
});

// --- fix 3: ?apiKey= confinement -------------------------------------------

test('x-api-key header is accepted on any path (array form too)', () => {
  assert.strictEqual(resolveProvidedApiKey('tok', '/sessions?limit=5'), 'tok');
  assert.strictEqual(resolveProvidedApiKey(['tok2'], '/backlog/list'), 'tok2');
});

test('?apiKey= is REFUSED on normal routes', () => {
  assert.strictEqual(resolveProvidedApiKey(undefined, '/sessions?apiKey=leak'), null);
  assert.strictEqual(resolveProvidedApiKey(undefined, '/backlog/list?apiKey=leak&x=1'), null);
  assert.strictEqual(resolveProvidedApiKey(undefined, '/voice/stt/ws-not-really?apiKey=leak'), null);
  assert.strictEqual(resolveProvidedApiKey(undefined, '/voice/stt/ws/extra?apiKey=leak'), null);
});

test('?apiKey= is accepted ONLY on the voice WS upgrade paths', () => {
  assert.strictEqual(resolveProvidedApiKey(undefined, '/voice/stt/ws?apiKey=tok'), 'tok');
  assert.strictEqual(resolveProvidedApiKey(undefined, '/voice/claude/ws?apiKey=tok'), 'tok');
  assert.strictEqual(resolveProvidedApiKey(undefined, '/voice/stt/ws'), null); // no key at all
});

test('header wins over query even on a voice path', () => {
  assert.strictEqual(resolveProvidedApiKey('hdr', '/voice/stt/ws?apiKey=qry'), 'hdr');
});
