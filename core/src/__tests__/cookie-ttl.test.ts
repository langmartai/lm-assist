import { test } from 'node:test';
import assert from 'node:assert';
import { cdpExpiresToMs } from '../utils/claudeai-browser-launch';
import { describeCookieTtl } from '../utils/claudeai-session';

// ── cdpExpiresToMs ────────────────────────────────────────────────────────────

test('cdpExpiresToMs: persistent cookie seconds→ms', () =>
  assert.strictEqual(cdpExpiresToMs({ expires: 1800000000, session: false }), 1800000000000));

test('cdpExpiresToMs: session cookie → null', () =>
  assert.strictEqual(cdpExpiresToMs({ expires: 1800000000, session: true }), null));

test('cdpExpiresToMs: -1 / 0 → null', () => {
  assert.strictEqual(cdpExpiresToMs({ expires: -1, session: false }), null);
  assert.strictEqual(cdpExpiresToMs({ expires: 0, session: false }), null);
});

test('cdpExpiresToMs: undefined → null', () =>
  assert.strictEqual(cdpExpiresToMs(undefined), null));

// ── describeCookieTtl ────────────────────────────────────────────────────────

test('describeCookieTtl: no sessionKey', () =>
  assert.strictEqual(describeCookieTtl(null, false, 0), 'no sessionKey'));

test('describeCookieTtl: unknown (legacy file)', () =>
  assert.match(describeCookieTtl(undefined, true, 0), /unknown/));

test('describeCookieTtl: session cookie (null)', () =>
  assert.match(describeCookieTtl(null, true, 0), /no fixed expiry/));

test('describeCookieTtl: days+hours', () =>
  assert.match(describeCookieTtl(0 + 3 * 86400000 + 5 * 3600000, true, 0), /3d 5h/));

test('describeCookieTtl: expired', () =>
  assert.match(describeCookieTtl(1000, true, 2000), /EXPIRED/));
