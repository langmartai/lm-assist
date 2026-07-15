/**
 * Content-registry model (assist-content design §2a/§3): id grammar, override caps.
 * Docs are override-only deltas over code defaults; ids are enumerated from the code
 * (bootstrap.<section> / guide.<topic>) with unknown-but-valid ids allowed as scratch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_REGISTRY_DATASET,
  CONTENT_HISTORY_CAP,
  MAX_CONTENT_OVERRIDE_BYTES,
  MAX_BLURB_OVERRIDE_BYTES,
  validateContentId,
  validateContentOverride,
  validateBlurbOverride,
} from '../mcp-server/registry/content-model';

test('dataset id + caps match the design brief', () => {
  assert.equal(CONTENT_REGISTRY_DATASET, 'assist-content-registry');
  assert.equal(CONTENT_HISTORY_CAP, 20);
  assert.equal(MAX_CONTENT_OVERRIDE_BYTES, 16384);
  assert.equal(MAX_BLURB_OVERRIDE_BYTES, 300);
});

test('id grammar accepts the code-enumerated shapes + valid scratch ids', () => {
  for (const id of [
    'bootstrap.header',
    'guide.index',
    'guide.orientation',
    'guide.cross-node',
    'guide.claude-ai',
    'guide.mission-controller',
    'guide.machine-access',
    'guide.zz-e2e-probe', // unknown but valid (scratch/mixed-version)
    'guide.a.b',          // dotted sub-keys allowed for future nesting
  ]) {
    assert.equal(validateContentId(id).ok, true, `${id} should validate`);
  }
});

test('id grammar rejects malformed ids', () => {
  for (const id of [
    'header',              // no group prefix
    'tools.header',        // unknown group
    'bootstrap',           // bare group
    'bootstrap.',          // empty key
    'guide..x',            // double dot
    'guide.x.',            // trailing dot
    'guide.x-',            // trailing hyphen
    'guide.-x',            // key must start alphanumeric
    'Guide.x',             // case-sensitive lowercase
    'guide.x y',           // whitespace
    `guide.${'x'.repeat(120)}`, // too long
    '',
  ]) {
    const v = validateContentId(id);
    assert.equal(v.ok, false, `${JSON.stringify(id)} should be rejected`);
    if (!v.ok) assert.equal(v.code, 'INVALID_INPUT');
  }
});

test('contentOverride: null clears, non-empty string within cap, oversize refused', () => {
  assert.equal(validateContentOverride(null).ok, true);
  assert.equal(validateContentOverride('# rewritten').ok, true);
  const empty = validateContentOverride('');
  assert.equal(empty.ok, false);
  const big = validateContentOverride('x'.repeat(MAX_CONTENT_OVERRIDE_BYTES + 1));
  assert.equal(big.ok, false);
  if (!big.ok) assert.equal(big.code, 'OVERRIDE_TOO_LARGE');
  // byte-counted, not char-counted (astral chars are 4 bytes)
  const multibyte = validateContentOverride('🙂'.repeat(Math.ceil(MAX_CONTENT_OVERRIDE_BYTES / 4) + 10));
  assert.equal(multibyte.ok, false);
});

test('blurbOverride: single line within cap; newlines and oversize refused', () => {
  assert.equal(validateBlurbOverride(null).ok, true);
  assert.equal(validateBlurbOverride('one crisp line').ok, true);
  assert.equal(validateBlurbOverride('').ok, false);
  const nl = validateBlurbOverride('two\nlines');
  assert.equal(nl.ok, false);
  const big = validateBlurbOverride('b'.repeat(MAX_BLURB_OVERRIDE_BYTES + 1));
  assert.equal(big.ok, false);
  if (!big.ok) assert.equal(big.code, 'BLURB_TOO_LARGE');
});
