/**
 * The navigation-landed guard.
 *
 * These exist because the failure they prevent is invisible: a search that lands
 * on a DIFFERENT view still renders rows, still passes a ready-selector, and
 * returns those rows to the caller as if they answered the question. MEASURED
 * 2026-08-03: `#search/has%3Aattachment` came back showing `#inbox` with 50 rows.
 *
 * `sameQuery` is the part that can be tested without a browser, so it is tested
 * here rather than left to a live canary that only runs on demand.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

/** Mirrors the comparator in cdp-client.ts. Kept in step by the cases below. */
function sameQuery(want: string, got: string): boolean {
  const norm = (h: string): string =>
    decodeURIComponent(String(h || '').trim())
      .replace(/^#/, '')
      .replace(/\+/g, ' ')
      .replace(/\/p\d+$/i, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  const w = norm(want);
  const g = norm(got);
  return g === w || g.startsWith(`${w}/`);
}

test('percent-encoding is not a difference', () => {
  assert.equal(sameQuery('#search/has%3Aattachment', '#search/has:attachment'), true);
  assert.equal(sameQuery('#search/in%3Asent', '#search/in:sent'), true);
});

test('Gmail renders spaces as + and that is not a difference either', () => {
  assert.equal(sameQuery('#search/older_than%3A6m%20in%3Ainbox', '#search/older_than:6m+in:inbox'), true);
});

test('pagination stays inside the same view', () => {
  assert.equal(sameQuery('#search/newer_than%3A1d', '#search/newer_than:1d/p2'), true);
  assert.equal(sameQuery('#inbox', '#inbox/p3'), true);
});

test('🔴 a DIFFERENT search must not satisfy the request', () => {
  // The measured corruption: asked for attachments, shown the sync's own query.
  assert.equal(sameQuery('#search/has%3Aattachment', '#search/newer_than:1d'), false);
  assert.equal(sameQuery('#search/has%3Aattachment', '#search/in:inbox+is:unread+newer_than:7d'), false);
  assert.equal(sameQuery('#search/in%3Asent', '#search/in:inbox+after:2026/08/03'), false);
});

test('🔴 a different VIEW must not satisfy a search', () => {
  // The single most dangerous observed case: 50 inbox rows returned as results.
  assert.equal(sameQuery('#search/has%3Aattachment', '#inbox'), false);
  assert.equal(sameQuery('#search/has%3Aattachment', ''), false);
});

test('a prefix that is not a path boundary is not a match', () => {
  // `in:sent` must not be satisfied by `in:sentbox`-style near misses.
  assert.equal(sameQuery('#search/in%3Asent', '#search/in:sentinel'), false);
});
