import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { rotateNow } from '../../utils/log-rotate';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'logrot-')), 'core.log');
}

test('leaves a file under the ceiling untouched', () => {
  const f = tmpFile();
  const body = 'line\n'.repeat(100); // 500 bytes
  fs.writeFileSync(f, body);
  rotateNow(f, 10_000, 2_000);
  assert.equal(fs.readFileSync(f, 'utf8'), body);
});

test('truncates an oversized file, keeping the recent tail', () => {
  const f = tmpFile();
  // 2000 numbered lines, each ~10 bytes ⇒ ~20 KB, well over the 4 KB ceiling.
  const lines = Array.from({ length: 2000 }, (_, i) => `line${String(i).padStart(5, '0')}`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const before = fs.statSync(f).size;

  rotateNow(f, 4_000, 1_000); // max 4 KB, keep last 1 KB

  const after = fs.readFileSync(f, 'utf8');
  assert.ok(fs.statSync(f).size < before, 'file shrank');
  assert.ok(after.startsWith('--- lm-assist log rotated'), 'starts with rotation banner');
  // The very last line must survive; an early line must be gone.
  assert.ok(after.includes('line01999'), 'kept the most recent line');
  assert.ok(!after.includes('line00000'), 'dropped the oldest line');
  // After the banner, content resumes at a clean line boundary (no partial line).
  const afterBanner = after.slice(after.indexOf('\n') + 1);
  assert.match(afterBanner.split('\n')[0], /^line\d{5}$/, 'tail starts at a line boundary');
});

test('is a no-op when the log file does not exist', () => {
  const f = path.join(os.tmpdir(), 'logrot-does-not-exist-xyz', 'core.log');
  assert.doesNotThrow(() => rotateNow(f, 4_000, 1_000));
});
