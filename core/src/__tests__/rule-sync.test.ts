import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  readOwnRules, sanitizeBasename, sanitizeHost, routePlacement, applyIngest,
} from '../rules/rule-sync';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function tmp(prefix: string) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test('readOwnRules excludes synced.* + credential-shaped names, hashes the whole file', () => {
  const dir = tmp('ror-');
  fs.writeFileSync(path.join(dir, 'panic-mode.md'), '---\nname: p\nos: linux\n---\nbody');
  fs.writeFileSync(path.join(dir, 'synced.host-a.foo.md'), '---\nname: f\n---\nx'); // excluded (already synced)
  fs.writeFileSync(path.join(dir, 'api_token.md'), 'secret');                       // excluded (credential)
  const got = readOwnRules(dir);
  assert.deepEqual(got.map(r => r.file), ['panic-mode.md']);
  assert.deepEqual(got[0].os, ['linux']);
  assert.equal(got[0].osDependent, true);
  assert.equal(got[0].contentHash, sha('---\nname: p\nos: linux\n---\nbody'));
});

test('sanitizeBasename flattens separators, rejects traversal/absolute', () => {
  assert.equal(sanitizeBasename('foo.md'), 'foo.md');
  assert.equal(sanitizeBasename('sub/foo.md'), 'sub-foo.md');
  assert.equal(sanitizeBasename('../escape.md'), null);
  assert.equal(sanitizeBasename('/etc/passwd.md'), null);
  assert.equal(sanitizeBasename('nope.txt'), null);
});

test('sanitizeHost is dot-free (so synced.<host>. parses)', () => {
  assert.equal(sanitizeHost('gw-117'), 'gw-117');
  assert.equal(sanitizeHost('host.example.com'), 'host-example-com');
  assert.equal(sanitizeHost(''), null);
});

test('routePlacement: empty os or matching platform → active; mismatch → mirror', () => {
  assert.equal(routePlacement([], 'win32'), 'active');
  assert.equal(routePlacement(['win32'], 'win32'), 'active');
  assert.equal(routePlacement(['win32'], 'linux'), 'mirror');
});

test('applyIngest routes a matching-OS rule ACTIVE and a wrong-OS rule INERT', () => {
  const rulesDir = tmp('ai-active-'); const mirrorRoot = tmp('ai-mirror-');
  const rules = [
    { file: 'lin.md', content: '---\nos: linux\n---\nL', contentHash: sha('---\nos: linux\n---\nL'), os: ['linux'] },
    { file: 'win.md', content: '---\nos: windows\n---\nW', contentHash: sha('---\nos: windows\n---\nW'), os: ['win32'] },
    { file: 'all.md', content: '---\nname: a\n---\nA', contentHash: sha('---\nname: a\n---\nA'), os: [] },
  ];
  const res = applyIngest('117', 'linux', rules, 'linux', { rulesDir, mirrorRoot });
  assert.equal(res.applied, 3);
  assert.equal(res.active, 2);  // lin + all
  assert.equal(res.inert, 1);   // win
  assert.ok(fs.existsSync(path.join(rulesDir, 'synced.117.lin.md')));
  assert.ok(fs.existsSync(path.join(rulesDir, 'synced.117.all.md')));
  assert.ok(fs.existsSync(path.join(mirrorRoot, '117', 'win.md')));
  // byte-identical
  assert.equal(fs.readFileSync(path.join(rulesDir, 'synced.117.lin.md'), 'utf-8'), '---\nos: linux\n---\nL');
});

test('applyIngest never clobbers a hand-authored local rule of the same basename', () => {
  const rulesDir = tmp('ai-coexist-'); const mirrorRoot = tmp('ai-coexist-m-');
  fs.writeFileSync(path.join(rulesDir, 'panic-mode.md'), 'LOCAL HAND-AUTHORED');
  applyIngest('117', 'linux', [
    { file: 'panic-mode.md', content: 'FROM 117', contentHash: sha('FROM 117'), os: [] },
  ], 'linux', { rulesDir, mirrorRoot });
  assert.equal(fs.readFileSync(path.join(rulesDir, 'panic-mode.md'), 'utf-8'), 'LOCAL HAND-AUTHORED');
  assert.equal(fs.readFileSync(path.join(rulesDir, 'synced.117.panic-mode.md'), 'utf-8'), 'FROM 117');
});

test('applyIngest removal is set-diff: a file dropped from the source set is deleted (active + mirror)', () => {
  const rulesDir = tmp('ai-rm-'); const mirrorRoot = tmp('ai-rm-m-');
  // first cycle: two rules from 117 (one active, one inert)
  applyIngest('117', 'linux', [
    { file: 'a.md', content: 'A', contentHash: sha('A'), os: [] },
    { file: 'b.md', content: '---\nos: windows\n---\nB', contentHash: sha('---\nos: windows\n---\nB'), os: ['win32'] },
  ], 'linux', { rulesDir, mirrorRoot });
  assert.ok(fs.existsSync(path.join(rulesDir, 'synced.117.a.md')));
  assert.ok(fs.existsSync(path.join(mirrorRoot, '117', 'b.md')));
  // second cycle: 117 now only exports a.md → b.md must be removed from BOTH locations
  const res = applyIngest('117', 'linux', [
    { file: 'a.md', content: 'A', contentHash: sha('A'), os: [] },
  ], 'linux', { rulesDir, mirrorRoot });
  assert.equal(res.removed, 1);
  assert.ok(fs.existsSync(path.join(rulesDir, 'synced.117.a.md')));
  assert.ok(!fs.existsSync(path.join(mirrorRoot, '117', 'b.md')));
});

test('applyIngest only ever touches THIS source-host namespace (other hosts untouched)', () => {
  const rulesDir = tmp('ai-ns-'); const mirrorRoot = tmp('ai-ns-m-');
  fs.writeFileSync(path.join(rulesDir, 'synced.other.keep.md'), 'KEEP');
  applyIngest('117', 'linux', [], 'linux', { rulesDir, mirrorRoot }); // empty export from 117
  assert.ok(fs.existsSync(path.join(rulesDir, 'synced.other.keep.md')), 'other host not swept');
});

test('applyIngest rejects oversize (>64 KB) and traversal filenames', () => {
  const rulesDir = tmp('ai-cap-'); const mirrorRoot = tmp('ai-cap-m-');
  const big = 'x'.repeat(64 * 1024 + 1);
  const res = applyIngest('117', 'linux', [
    { file: 'big.md', content: big, contentHash: sha(big), os: [] },
    { file: '../evil.md', content: 'E', contentHash: sha('E'), os: [] },
  ], 'linux', { rulesDir, mirrorRoot });
  assert.equal(res.applied, 0);
  assert.ok(!fs.existsSync(path.join(rulesDir, 'synced.117.big.md')));
});

test('applyIngest dedups byte-identical re-ingest (no rewrite churn)', () => {
  const rulesDir = tmp('ai-dedup-'); const mirrorRoot = tmp('ai-dedup-m-');
  const rule = { file: 'a.md', content: 'A', contentHash: sha('A'), os: [] as string[] };
  applyIngest('117', 'linux', [rule], 'linux', { rulesDir, mirrorRoot });
  const dest = path.join(rulesDir, 'synced.117.a.md');
  const mtime1 = fs.statSync(dest).mtimeMs;
  const res = applyIngest('117', 'linux', [rule], 'linux', { rulesDir, mirrorRoot });
  assert.equal(res.applied, 1); // counted as present
  assert.equal(fs.statSync(dest).mtimeMs, mtime1, 'unchanged file not rewritten');
});
