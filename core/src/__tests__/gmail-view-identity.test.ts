/**
 * viewIdentity(): what a view ANSWERS TO, from its hash.
 *
 * 🔴 The bug this pins down: deriving identity from segment 1 made the
 * landed-guard demand that the Sent view answer to the word "label" — and it
 * refused a page that was exactly where it was asked to go, with the absurd
 * error `asked for #label/sent but the page is showing #label/sent`. Checks
 * with an `in:` fallback silently routed around it, so a green suite was not
 * evidence the label route worked. MEASURED 2026-08-05 on 117 via
 * /gmail/threads?label=sent.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { viewIdentity } from '../gmail/cdp-client';

test('plain views answer to their own segment', () => {
  assert.equal(viewIdentity('#inbox'), 'inbox');
  assert.equal(viewIdentity('#drafts'), 'drafts');
  assert.equal(viewIdentity('#sent'), 'sent');
});

test('🔴 a label route answers to the NAME, never the word "label"', () => {
  // The measured failure: this returned 'label', which "Sent Mail" can never match.
  assert.equal(viewIdentity('#label/sent'), 'sent');
  assert.equal(viewIdentity('#label/Work'), 'work');
});

test('nested labels keep their full path as the name', () => {
  assert.equal(viewIdentity('#label/Parent/Child'), 'parent/child');
});

test('Gmail label-hash encoding: percent-escapes and + for spaces', () => {
  // Real shape from the left nav: #label/4%29+DB:+AUTHORITIES/ACRA
  assert.equal(viewIdentity('#label/4%29+DB:+AUTHORITIES/ACRA'), '4) db: authorities/acra');
});

test('a malformed escape degrades to comparable text instead of throwing', () => {
  assert.equal(viewIdentity('#label/bad%zzname'), 'bad%zzname');
});

test('a bare "#label" with no name stays "label" (nothing better to answer to)', () => {
  assert.equal(viewIdentity('#label'), 'label');
});
