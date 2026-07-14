import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relPathProblem, filenameProblem } from '../../memory/file-write';

/**
 * relPathProblem — nested-capable filename validation for the Rules browser.
 * Every directory segment must be a safe bare name; the basename is
 * validated by the existing filenameProblem (so protected patterns still
 * apply to the basename only, unchanged for flat filenames).
 */

test('relPathProblem accepts a bare basename (flat, unchanged legacy shape)', () => {
  assert.equal(relPathProblem('a.md'), null);
});

test('relPathProblem accepts one level of nesting', () => {
  assert.equal(relPathProblem('sub/a.md'), null);
});

test('relPathProblem accepts a directory segment with dots/underscores/hyphens/digits', () => {
  assert.equal(relPathProblem('s.u-b_2/x.md'), null);
});

test('relPathProblem accepts multiple nesting levels', () => {
  assert.equal(relPathProblem('nested/dir/deep.md'), null);
});

test('relPathProblem rejects a leading traversal segment', () => {
  assert.equal(relPathProblem('../a.md'), 'BAD_FILENAME');
});

test('relPathProblem rejects a mid-path traversal segment', () => {
  assert.equal(relPathProblem('sub/../a.md'), 'BAD_FILENAME');
});

test('relPathProblem rejects a hidden (dot-prefixed) directory segment', () => {
  assert.equal(relPathProblem('.hidden/a.md'), 'BAD_FILENAME');
});

test('relPathProblem rejects a backslash anywhere (never treated as a separator)', () => {
  assert.equal(relPathProblem('sub\\a.md'), 'BAD_FILENAME');
  assert.equal(relPathProblem('sub\\..\\a.md'), 'BAD_FILENAME');
});

test('relPathProblem rejects a non-.md basename', () => {
  assert.equal(relPathProblem('a.txt'), 'BAD_FILENAME');
  assert.equal(relPathProblem('sub/a.txt'), 'BAD_FILENAME');
});

test('relPathProblem tests protected patterns against the BASENAME, case-insensitively', () => {
  const protectedPatterns = [/^synced\./i];
  assert.equal(relPathProblem('synced.host.md', protectedPatterns), 'PROTECTED');
  assert.equal(relPathProblem('Synced.host.md', protectedPatterns), 'PROTECTED');
  assert.equal(relPathProblem('sub/synced.host.md', protectedPatterns), 'PROTECTED');
  assert.equal(relPathProblem('sub/dir/Synced.HOST.md', protectedPatterns), 'PROTECTED');
  // the directory segment matching "synced." style text must NOT itself trigger PROTECTED —
  // only the basename is tested.
  assert.equal(relPathProblem('plain/ok.md', protectedPatterns), null);
});

test('relPathProblem rejects empty segments (leading/trailing/doubled slash)', () => {
  assert.equal(relPathProblem('//a.md'), 'BAD_FILENAME');
  assert.equal(relPathProblem('sub//a.md'), 'BAD_FILENAME');
  assert.equal(relPathProblem('sub/a.md/'), 'BAD_FILENAME'); // trailing slash -> basename becomes empty
});

test('relPathProblem rejects an empty or non-string relpath', () => {
  assert.equal(relPathProblem(''), 'BAD_FILENAME');
  assert.equal(relPathProblem(undefined as unknown as string), 'BAD_FILENAME');
});

test('relPathProblem rejects control characters and NUL bytes', () => {
  assert.equal(relPathProblem('a\0.md'), 'BAD_FILENAME');
  assert.equal(relPathProblem('sub/a\x01.md'), 'BAD_FILENAME');
  assert.equal(relPathProblem('a\n.md'), 'BAD_FILENAME');
});

test('relPathProblem rejects a "." or ".." directory segment explicitly', () => {
  assert.equal(relPathProblem('./a.md'), 'BAD_FILENAME');
  assert.equal(relPathProblem('sub/./a.md'), 'BAD_FILENAME');
});

test('relPathProblem rejects an absolute path', () => {
  assert.equal(relPathProblem('/etc/passwd.md'), 'BAD_FILENAME');
});

test('relPathProblem rejects a directory segment with disallowed characters', () => {
  assert.equal(relPathProblem('sub dir/a.md'), 'BAD_FILENAME'); // space
  assert.equal(relPathProblem('sub!/a.md'), 'BAD_FILENAME');    // shell metachar
});

// ── back-compat: relPathProblem('a.md') must agree with filenameProblem('a.md') ──

test('relPathProblem agrees with filenameProblem for every flat-filename case', () => {
  const protectedPatterns = [/^synced\./i];
  const cases = ['a.md', 'A_b-9.md', '.hidden.md', 'a.txt', '', 'synced.host.md', 'Synced.Host.md'];
  for (const c of cases) {
    assert.equal(relPathProblem(c, protectedPatterns), filenameProblem(c, protectedPatterns), `mismatch for ${JSON.stringify(c)}`);
  }
});
