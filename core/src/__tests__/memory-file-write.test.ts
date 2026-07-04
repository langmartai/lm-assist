import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  sha256, filenameProblem, writeMdFile, deleteMdFile,
  appendIndexLine, removeIndexLines,
} from '../memory/file-write';

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'mfw-')); }
const PROTECTED = [/^_cross-project\.md$/i, /^_hosts\.md$/i];

test('filenameProblem rejects traversal, separators, dotfiles, non-md', () => {
  assert.equal(filenameProblem('ok-file.md'), null);
  assert.equal(filenameProblem('MEMORY.md'), null);
  assert.equal(filenameProblem('../evil.md'), 'BAD_FILENAME');
  assert.equal(filenameProblem('a/b.md'), 'BAD_FILENAME');
  assert.equal(filenameProblem('a\\b.md'), 'BAD_FILENAME');
  assert.equal(filenameProblem('.hashes.json'), 'BAD_FILENAME');
  assert.equal(filenameProblem('.dot.md'), 'BAD_FILENAME');
  assert.equal(filenameProblem('note.txt'), 'BAD_FILENAME');
  assert.equal(filenameProblem('spaced name.md'), 'BAD_FILENAME');
  assert.equal(filenameProblem('_hosts.md', PROTECTED), 'PROTECTED');
  assert.equal(filenameProblem('_cross-project.md', PROTECTED), 'PROTECTED');
  assert.equal(filenameProblem('synced.gw1.foo.md', [/^synced\./]), 'PROTECTED');
});

test('writeMdFile writes and returns the new hash', () => {
  const dir = tmpDir();
  const r = writeMdFile(dir, 'a.md', 'hello');
  assert.equal(r.ok, true);
  assert.equal(r.hash, sha256('hello'));
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf-8'), 'hello');
});

test('writeMdFile mustNotExist → EXISTS on second write', () => {
  const dir = tmpDir();
  assert.equal(writeMdFile(dir, 'a.md', 'x', { mustNotExist: true }).ok, true);
  const r = writeMdFile(dir, 'a.md', 'y', { mustNotExist: true });
  assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'EXISTS' });
});

test('writeMdFile expectedHash mismatch → HASH_MISMATCH, file untouched', () => {
  const dir = tmpDir();
  writeMdFile(dir, 'a.md', 'v1');
  const r = writeMdFile(dir, 'a.md', 'v2', { expectedHash: sha256('OTHER') });
  assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'HASH_MISMATCH' });
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf-8'), 'v1');
  // correct hash succeeds
  assert.equal(writeMdFile(dir, 'a.md', 'v2', { expectedHash: sha256('v1') }).ok, true);
  // expectedHash against a missing file also mismatches
  const r2 = writeMdFile(dir, 'gone.md', 'x', { expectedHash: sha256('v1') });
  assert.deepEqual({ ok: r2.ok, code: r2.code }, { ok: false, code: 'HASH_MISMATCH' });
});

test('deleteMdFile honors NOT_FOUND, hash guard, protection', () => {
  const dir = tmpDir();
  assert.equal(deleteMdFile(dir, 'a.md').code, 'NOT_FOUND');
  writeMdFile(dir, 'a.md', 'v1');
  assert.equal(deleteMdFile(dir, 'a.md', { expectedHash: sha256('nope') }).code, 'HASH_MISMATCH');
  assert.equal(deleteMdFile(dir, '_hosts.md', { protectedPatterns: PROTECTED }).code, 'PROTECTED');
  assert.equal(deleteMdFile(dir, 'a.md', { expectedHash: sha256('v1') }).ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'a.md')), false);
});

test('appendIndexLine creates MEMORY.md and appends with clean newlines', () => {
  const dir = tmpDir();
  appendIndexLine(dir, '- [A](a.md) — hook');
  appendIndexLine(dir, '- [B](b.md) — hook2');
  const idx = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf-8');
  assert.match(idx, /\- \[A\]\(a\.md\) — hook\n/);
  assert.match(idx, /\- \[B\]\(b\.md\) — hook2\n$/);
});

test('removeIndexLines removes only lines linking the filename', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'MEMORY.md'),
    '# Index\n- [A](a.md) — keep?\n- [B](b.md) — other\n- [A2](./a.md) — dotted\n');
  const n = removeIndexLines(dir, 'a.md');
  assert.equal(n, 2);
  const idx = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf-8');
  assert.equal(idx.includes('a.md'), false);
  assert.equal(idx.includes('(b.md)'), true);
  assert.equal(removeIndexLines(dir, 'zzz.md'), 0);     // no-op
  assert.equal(removeIndexLines(tmpDir(), 'a.md'), 0);  // no MEMORY.md → 0, no throw
});
