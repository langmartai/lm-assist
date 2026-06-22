import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ingestRecords } from '../memory/ingest';

function tmpProjectDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ing-'));
  const projDir = path.join(root, '-home-x');
  fs.mkdirSync(path.join(projDir, 'memory'), { recursive: true });
  return projDir;
}

test('writes a record file under memory/<sourceHost>/', () => {
  const projDir = tmpProjectDir();
  const n = ingestRecords(projDir, 'gw4-home', [
    { file: 'fact.md', content: '---\nname: fact\ndescription: d\ntype: project\n---\nbody', contentHash: 'h1' },
  ]);
  assert.equal(n, 1);
  const f = path.join(projDir, 'memory', 'gw4-home', 'fact.md');
  assert.ok(fs.existsSync(f));
  assert.match(fs.readFileSync(f, 'utf-8'), /name: fact/);
});

test('skips an unchanged file (same contentHash sidecar)', () => {
  const projDir = tmpProjectDir();
  const rec = { file: 'fact.md', content: 'x', contentHash: 'h1' };
  assert.equal(ingestRecords(projDir, 'gw4-home', [rec]), 1);
  assert.equal(ingestRecords(projDir, 'gw4-home', [rec]), 0); // dedup by hash
});

test('re-writes when contentHash changes', () => {
  const projDir = tmpProjectDir();
  assert.equal(ingestRecords(projDir, 'gw4-home', [{ file: 'fact.md', content: 'v1', contentHash: 'h1' }]), 1);
  assert.equal(ingestRecords(projDir, 'gw4-home', [{ file: 'fact.md', content: 'v2', contentHash: 'h2' }]), 1);
  assert.equal(fs.readFileSync(path.join(projDir, 'memory', 'gw4-home', 'fact.md'), 'utf-8'), 'v2');
});

test('rejects path traversal in the record file name', () => {
  const projDir = tmpProjectDir();
  assert.equal(ingestRecords(projDir, 'gw4-home', [{ file: '../evil.md', content: 'x', contentHash: 'h' }]), 0);
  assert.ok(!fs.existsSync(path.join(projDir, 'evil.md')));
  assert.equal(ingestRecords(projDir, 'gw4-home', [{ file: 'sub/evil.md', content: 'x', contentHash: 'h' }]), 0);
});

test('rejects a non-.md or dotfile record name', () => {
  const projDir = tmpProjectDir();
  assert.equal(ingestRecords(projDir, 'gw4-home', [{ file: 'note.txt', content: 'x', contentHash: 'h' }]), 0);
  assert.equal(ingestRecords(projDir, 'gw4-home', [{ file: '.hashes.json', content: 'x', contentHash: 'h' }]), 0);
});

test('rejects a malicious sourceHost (traversal / separators)', () => {
  const projDir = tmpProjectDir();
  assert.equal(ingestRecords(projDir, '..', [{ file: 'a.md', content: 'x', contentHash: 'h' }]), 0);
  assert.equal(ingestRecords(projDir, 'a/b', [{ file: 'a.md', content: 'x', contentHash: 'h' }]), 0);
  assert.ok(!fs.existsSync(path.join(projDir, 'a.md')));
});
