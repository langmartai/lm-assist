import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureSignpostFor, SIGNPOST_FILE, POINTER_LINE } from '../memory/cross-project-signpost';

function tmpMem(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-'));
  const mem = path.join(d, 'memory');
  fs.mkdirSync(mem, { recursive: true });
  return mem;
}

test('writes the file + a single MEMORY.md pointer, idempotently', () => {
  const dir = tmpMem();
  const r1 = ensureSignpostFor(dir, 'CONTENT-V1');
  assert.equal(r1.wroteFile, true);
  assert.equal(r1.wrotePointer, true);
  assert.equal(fs.readFileSync(path.join(dir, SIGNPOST_FILE), 'utf-8'), 'CONTENT-V1');
  assert.match(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf-8'), new RegExp(`\\(${SIGNPOST_FILE}\\)`));

  const r2 = ensureSignpostFor(dir, 'CONTENT-V1'); // same content → no writes
  assert.equal(r2.wroteFile, false);
  assert.equal(r2.wrotePointer, false);
  const idx = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf-8');
  assert.equal(idx.split(SIGNPOST_FILE).length - 1, 1); // pointer appears exactly once
});

test('changed content rewrites the file but keeps one pointer', () => {
  const dir = tmpMem();
  ensureSignpostFor(dir, 'V1');
  const r = ensureSignpostFor(dir, 'V2');
  assert.equal(r.wroteFile, true);
  assert.equal(r.wrotePointer, false);
  assert.equal(fs.readFileSync(path.join(dir, SIGNPOST_FILE), 'utf-8'), 'V2');
});

test('preserves an existing user MEMORY.md, appending the pointer once', () => {
  const dir = tmpMem();
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# My Index\n\n- [Note](note.md) — a thing\n');
  ensureSignpostFor(dir, 'V1');
  const idx = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf-8');
  assert.match(idx, /My Index/);
  assert.match(idx, /note\.md/);
  assert.ok(idx.includes(POINTER_LINE), 'managed pointer line present');
  assert.equal(idx.split(SIGNPOST_FILE).length - 1, 1);
});
