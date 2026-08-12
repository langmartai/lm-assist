/**
 * Rotation persistence + query-key confinement for the local api-token
 * (bl_ff8aad3b fixes 1+3, plus the round-2 review fixes).
 *
 * Fix 1 — the rotation deadline used to be an in-memory setTimeout re-armed
 * from ZERO on every boot, and the accept-ring re-seeded to just [fileToken],
 * so on a fleet that restarts Core more often than ROTATE_MS the token NEVER
 * rotated (measured: a 49-day-old token against a 30-day window). Rotation
 * state now persists in a sidecar (`api-token.meta.json`) next to the token
 * file; the token file itself stays a RAW token string (every other consumer
 * — core.sh, bin/lm-assist.js, ccr-bridge, hooks, web SSR — reads it as-is).
 *
 * Review fix (headline case): on the FIRST boot with this code no sidecar
 * exists, and stamping lastRotatedAt=now would hand the already-49-day-old
 * token ANOTHER full 30-day window. The token file is written only at
 * creation/rotation, so its mtime is an honest lower bound on the token's
 * age: a missing/corrupt sidecar over an EXISTING token file seeds the
 * window from the file mtime — the 49-day token rotates at THIS boot. Only
 * a missing token file (fresh install) or an unreadable stat stamps now.
 *
 * Review fix (grace TTL): the durable ring used to keep a retired token valid
 * for up to two full rotation windows (~60 days) across restarts. Each grace
 * entry now carries retiredAt (sidecar v2) and is dropped once older than
 * GRACE_MS (default 7 days) at load and at rotation. v1 sidecars (bare token
 * strings) load fail-open: entries treated as retired at load time.
 *
 * Fix 3 — `?apiKey=` query acceptance is REMOVED from the HTTP gate entirely
 * (headers only). Verified: no HTTP route exists at /voice/stt/ws or
 * /voice/claude/ws — the voice WS upgrades ride server.on('upgrade') →
 * routeUpgrade and authenticate their own `?token=` inside the upgrade
 * handlers (voice-relay.ts / claude-voice-relay.ts), never traversing the
 * HTTP gate — and no repo consumer sends `?apiKey=` (both voice-url.ts
 * builders send `?token=`).
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
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const RING_SIZE = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

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
/** Grace tokens named in the sidecar, format-agnostic (v1 string / v2 object). */
const metaGraceTokens = (): string[] =>
  (readMetaFile().previous as unknown[]).map((e) => (typeof e === 'string' ? e : (e as { token: string }).token));

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
  assert.ok(metaGraceTokens().includes(old), 'sidecar must persist the retired token');
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

// --- review fix 1: sidecar-less boot seeds the window from the file mtime ----

test('FIRST deploy over a 49-day-old token file (no sidecar) rotates at THIS boot', () => {
  const old = initApiToken(1_000);
  __resetApiTokenState();
  fs.rmSync(apiTokenMetaFilePath()); // pre-sidecar install: token file only
  const writtenAt = Date.now() - 49 * DAY_MS; // the measured fleet incident
  fs.utimesSync(apiTokenFilePath(), new Date(writtenAt), new Date(writtenAt));
  const bootNow = Date.now();
  startApiTokenRotation(bootNow);
  const fresh = readTokenFile();
  assert.notStrictEqual(fresh, old, 'a 49-day-old token must rotate on the FIRST boot with this code');
  assert.ok(isValidToken(old), 'the retired token stays valid through the grace window');
  assert.ok(isValidToken(fresh));
  const meta = readMetaFile();
  assert.strictEqual(meta.lastRotatedAt, bootNow);
  assert.ok(metaGraceTokens().includes(old));
  assert.strictEqual(__armedRotationMs(), ROTATE_MS);
});

test('corrupt sidecar over an aged token file seeds from mtime too and rotates', () => {
  const old = initApiToken(1_000);
  __resetApiTokenState();
  fs.writeFileSync(apiTokenMetaFilePath(), '{ not json !!!');
  const writtenAt = Date.now() - 49 * DAY_MS;
  fs.utimesSync(apiTokenFilePath(), new Date(writtenAt), new Date(writtenAt));
  startApiTokenRotation(Date.now());
  assert.notStrictEqual(readTokenFile(), old, 'corrupt sidecar must not shield an overdue token');
  assert.ok(isValidToken(old));
});

test('missing sidecar with a FRESH token file: no rotation, window seeded from the file mtime', () => {
  const tok = initApiToken(1_000);
  __resetApiTokenState();
  fs.rmSync(apiTokenMetaFilePath());
  const mtime = fs.statSync(apiTokenFilePath()).mtimeMs; // written milliseconds ago
  startApiTokenRotation(Date.now());
  assert.strictEqual(readTokenFile(), tok, 'a fresh token must NOT rotate');
  assert.strictEqual(readMetaFile().lastRotatedAt, mtime, 'window seeds from the file mtime, not now');
  const armed = __armedRotationMs()!;
  assert.ok(armed <= ROTATE_MS && armed > ROTATE_MS - 60_000, `armed ~ROTATE_MS minus file age, got ${armed}`);
});

test('corrupt sidecar with a FRESH token file fails open the same way, never throws', () => {
  const tok = initApiToken(1_000);
  __resetApiTokenState();
  fs.writeFileSync(apiTokenMetaFilePath(), '{ not json !!!');
  const mtime = fs.statSync(apiTokenFilePath()).mtimeMs;
  startApiTokenRotation(Date.now());
  assert.strictEqual(readTokenFile(), tok);
  assert.strictEqual(readMetaFile().lastRotatedAt, mtime);
  const armed = __armedRotationMs()!;
  assert.ok(armed <= ROTATE_MS && armed > ROTATE_MS - 60_000);
});

// --- review fix 2: grace TTL on retired tokens (sidecar v2) ------------------

test('sidecar v2: previous entries carry {token, retiredAt}', () => {
  const a = initApiToken(1_000);
  rotateApiToken(2_000);
  const meta = readMetaFile();
  assert.strictEqual(meta.v, 2);
  assert.deepStrictEqual(meta.previous, [{ token: a, retiredAt: 2_000 }]);
});

test('rotation drops grace entries older than the grace TTL (no two-window survival)', () => {
  const a = initApiToken(1_000);
  const b = rotateApiToken(2_000); // a retired at 2_000
  const later = 2_000 + GRACE_MS + 1;
  const c = rotateApiToken(later);
  assert.ok(!isValidToken(a), 'a token retired a full TTL ago must drop at the next rotation');
  assert.ok(isValidToken(b) && isValidToken(c));
  assert.ok(!metaGraceTokens().includes(a), 'the expired grace token must leave the sidecar too');
});

test('a retired token EXPIRES after the grace TTL across a restart', () => {
  const a = initApiToken(1_000);
  const b = rotateApiToken(2_000);
  __resetApiTokenState(); // simulate a Core restart after the TTL
  assert.strictEqual(initApiToken(2_000 + GRACE_MS + 1), b);
  assert.ok(!isValidToken(a), 'a grace token past the TTL must be dropped at load');
  assert.ok(isValidToken(b));
});

test('v1-format sidecar (bare token strings) loads fail-open: entries treated as retired at load', () => {
  const cur = 'c'.repeat(64);
  const old = 'd'.repeat(64);
  fs.mkdirSync(path.dirname(apiTokenFilePath()), { recursive: true });
  fs.writeFileSync(apiTokenFilePath(), cur + '\n', { mode: 0o600 });
  // Old-format sidecar written by the previous build: previous is string[].
  fs.writeFileSync(apiTokenMetaFilePath(), JSON.stringify({ v: 1, lastRotatedAt: 5_000, previous: [old] }));
  initApiToken(5_000 + 40 * DAY_MS); // load long after — v1 entries carry no retiredAt
  assert.strictEqual(currentApiToken(), cur);
  assert.ok(isValidToken(old), 'v1 grace token must stay valid (fail open: retiredAt = load time)');
});

test('cross-process reseed DROPS a grace token already past the TTL', () => {
  initApiToken(1_000);
  const next = 'b'.repeat(64);
  const stale = 'e'.repeat(64);
  const fileNow = fs.statSync(apiTokenFilePath()).mtimeMs;
  fs.writeFileSync(apiTokenFilePath(), next + '\n', { mode: 0o600 });
  fs.writeFileSync(
    apiTokenMetaFilePath(),
    JSON.stringify({
      v: 2,
      lastRotatedAt: Date.now(),
      previous: [{ token: stale, retiredAt: Date.now() - GRACE_MS - 60_000 }],
    }),
  );
  fs.utimesSync(apiTokenFilePath(), new Date(fileNow + 2_000), new Date(fileNow + 2_000));
  assert.ok(isValidToken(next), 'the other process’ new token must be accepted without a restart');
  assert.ok(!isValidToken(stale), 'a grace token past the TTL must not resurrect via reseed');
});

test('a rotation by ANOTHER process sharing the dataDir is absorbed on an auth miss', () => {
  // Process A seeds its ring…
  const old = initApiToken(1_000);
  // …then process B (dev and prod cores share <dataDir>/api-token) rotates:
  // new raw token file + sidecar carrying the retired token (fresh retiredAt).
  const fileNow = fs.statSync(apiTokenFilePath()).mtimeMs;
  const next = 'b'.repeat(64);
  fs.writeFileSync(apiTokenFilePath(), next + '\n', { mode: 0o600 });
  fs.writeFileSync(
    apiTokenMetaFilePath(),
    JSON.stringify({ v: 2, lastRotatedAt: Date.now(), previous: [{ token: old, retiredAt: Date.now() }] }),
  );
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

// --- fix 3: ?apiKey= removed from the HTTP gate entirely ---------------------
// The voice WS upgrades authenticate their own ?token= INSIDE the upgrade
// handlers (voice-relay.ts / claude-voice-relay.ts) and never traverse the
// HTTP gate, so the gate takes headers only. The cast bridges the signature
// change under review (pre-fix: (header, url) — post-fix: (header)).
const resolveKey = resolveProvidedApiKey as unknown as (
  header: string | string[] | undefined,
  url?: string,
) => string | null;

test('x-api-key header is accepted (string and array forms); nothing → null', () => {
  assert.strictEqual(resolveKey('tok', '/sessions?limit=5'), 'tok');
  assert.strictEqual(resolveKey(['tok2'], '/backlog/list'), 'tok2');
  assert.strictEqual(resolveKey(undefined, '/sessions'), null);
  assert.strictEqual(resolveKey('', '/sessions'), null);
});

test('?apiKey= query is refused EVERYWHERE — including the voice WS upgrade paths', () => {
  assert.strictEqual(resolveKey(undefined, '/sessions?apiKey=leak'), null);
  assert.strictEqual(resolveKey(undefined, '/backlog/list?apiKey=leak&x=1'), null);
  assert.strictEqual(resolveKey(undefined, '/voice/stt/ws?apiKey=leak'), null);
  assert.strictEqual(resolveKey(undefined, '/voice/claude/ws?apiKey=leak'), null);
});

test('header still wins on a voice path (query never consulted)', () => {
  assert.strictEqual(resolveKey('hdr', '/voice/stt/ws?apiKey=qry'), 'hdr');
});
