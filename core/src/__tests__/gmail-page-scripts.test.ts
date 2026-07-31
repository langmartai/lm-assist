/**
 * The test the code has been claiming exists.
 *
 * `JS_COMPOSE` and `JS_BODY_TARGET` carry the comment "Exported ONLY so the unit
 * tests can compile this exact string — a template typo here is otherwise
 * invisible until it reaches a live browser as PAGE_EVAL_ERROR." No such test was
 * ever written, and the hazard is real: every one of these constants is a
 * TypeScript template literal that assembles JavaScript by string interpolation,
 * so a stray backtick, an unbalanced brace, or a `\n` that becomes a literal
 * newline inside a string produces code that compiles as TypeScript, ships, and
 * only fails when a browser tries to run it.
 *
 * MEASURED 2026-07-30, both while building this connector: a `\n` inside a TS
 * template became a real newline and threw SyntaxError page-side; and a patch
 * truncated `'^move to$'` mid-literal, producing a file that still type-checked.
 *
 * These tests COMPILE each script the way cdp-client's evaluate() does — as the
 * body of an async function — without running it. Compilation is the whole
 * point: it catches the syntax class of bug at `npm test` instead of in front of
 * a live mailbox. Nothing here touches a browser, so it cannot be skipped into
 * uselessness on a machine without Chrome.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import { JS_LIB } from '../gmail/compose';
import {
  JS_VISIBLE,
  JS_UTIL,
  JS_ATTACH,
  JS_THREAD_FULL,
  JS_LABELS,
  JS_ATTACHMENTS_IN_THREAD,
} from '../gmail/extractors';
import { JS_LANDMARKS, JS_COMPOSE, JS_BODY_TARGET } from '../gmail/selfcheck';

/** The exact wrapper cdp-client.evaluate() uses: `(async()=>{ <expr> })()`. */
const AsyncFunction = Object.getPrototypeOf(async function () {
  /* probe */
}).constructor as new (body: string) => unknown;

/** Every page script that ships, with whether it is a standalone body or a fragment. */
const SCRIPTS: Array<{ name: string; src: string; standalone: boolean }> = [
  { name: 'JS_LIB', src: JS_LIB, standalone: false },
  { name: 'JS_VISIBLE', src: JS_VISIBLE, standalone: false },
  { name: 'JS_UTIL', src: JS_UTIL, standalone: false },
  { name: 'JS_ATTACH', src: JS_ATTACH, standalone: false },
  { name: 'JS_THREAD_FULL', src: JS_THREAD_FULL, standalone: true },
  { name: 'JS_LABELS', src: JS_LABELS, standalone: true },
  { name: 'JS_ATTACHMENTS_IN_THREAD', src: JS_ATTACHMENTS_IN_THREAD, standalone: true },
  { name: 'JS_LANDMARKS', src: JS_LANDMARKS, standalone: true },
  { name: 'JS_COMPOSE', src: JS_COMPOSE, standalone: true },
  { name: 'JS_BODY_TARGET', src: JS_BODY_TARGET, standalone: true },
];

for (const { name, src, standalone } of SCRIPTS) {
  test(`${name} compiles as an async function body`, () => {
    assert.ok(typeof src === 'string' && src.length > 0, `${name} is empty — an interpolation produced nothing`);
    try {
      // eslint-disable-next-line no-new
      new AsyncFunction(src);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      assert.fail(`${name} is not valid JavaScript: ${msg}\n--- first 400 chars ---\n${src.slice(0, 400)}`);
    }
  });

  test(`${name} carries no unresolved template interpolation`, () => {
    // A `${` surviving into the emitted script means a nested template literal
    // lost an escape — the script would reference an undefined page-side symbol.
    assert.ok(!src.includes('${'), `${name} still contains an unresolved \${...} interpolation`);
  });

  if (standalone) {
    test(`${name} returns a value`, () => {
      // evaluate() reads r.result.value; a body that never returns yields
      // undefined, which every caller of these scripts would misread as a
      // legitimately empty page rather than a broken script.
      assert.match(src, /\breturn\b/, `${name} never returns — its caller would read undefined as "empty"`);
    });
  }
}

test('the selfcheck scripts embed the shared library rather than reimplementing it', () => {
  // selfcheck exists to test the code that ships. A canary that reimplements
  // __scope()/__bodyEl() tests the copy, which is how the empty-body bug
  // survived: the resolver was wrong and its private twin agreed with it.
  for (const [name, src] of [
    ['JS_COMPOSE', JS_COMPOSE],
    ['JS_BODY_TARGET', JS_BODY_TARGET],
  ] as const) {
    assert.ok(src.includes('__scope') || src.includes('__bodyEl'), `${name} does not use the shared resolvers`);
  }
});
