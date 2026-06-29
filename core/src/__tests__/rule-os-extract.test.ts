import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOs, normalizeOsList, extractRule, ExtractInput } from '../rules/rule-extract';

function inp(content: string, platform?: string): ExtractInput {
  return { node: 'n', project: '(user)', source: 'live', scope: 'user', relpath: 'r.md',
    content, mtimeMs: 1, size: content.length, platform };
}

test('parseOs reads a block list', () => {
  assert.deepEqual(parseOs('---\nname: x\nos:\n  - windows\n  - linux\n---\nbody'), ['windows', 'linux']);
});
test('parseOs reads an inline flow list', () => {
  assert.deepEqual(parseOs('---\nos: [mac, "linux"]\n---\nb'), ['mac', 'linux']);
});
test('parseOs reads a scalar', () => {
  assert.deepEqual(parseOs('---\nos: windows\n---\nb'), ['windows']);
});
test('parseOs absent → []', () => {
  assert.deepEqual(parseOs('---\nname: x\n---\nb'), []);
  assert.deepEqual(parseOs('no frontmatter at all'), []);
});
test('normalizeOsList maps friendly → canonical + dedups', () => {
  assert.deepEqual(normalizeOsList(['Windows', 'win', 'win32']), ['win32']);
  assert.deepEqual(normalizeOsList(['mac', 'macos', 'osx', 'darwin']), ['darwin']);
  assert.deepEqual(normalizeOsList(['linux']), ['linux']);
});
test('normalizeOsList keeps an unknown token verbatim (lowercased)', () => {
  assert.deepEqual(normalizeOsList(['FreeBSD']), ['freebsd']);
});
test('extractRule: absent os → applies to all platforms (active everywhere, not osDependent)', () => {
  for (const p of ['win32', 'darwin', 'linux']) {
    const r = extractRule(inp('---\nname: x\n---\nbody', p));
    assert.deepEqual(r.os, []);
    assert.equal(r.osDependent, false);
    assert.equal(r.active, true, `should be active on ${p}`);
  }
});
test('extractRule: os: windows is active only on win32', () => {
  const c = '---\nname: x\nos: windows\n---\nbody';
  assert.equal(extractRule(inp(c, 'win32')).active, true);
  assert.equal(extractRule(inp(c, 'linux')).active, false);
  assert.equal(extractRule(inp(c, 'darwin')).active, false);
  assert.equal(extractRule(inp(c, 'win32')).osDependent, true);
  assert.deepEqual(extractRule(inp(c, 'win32')).os, ['win32']);
});
test('extractRule: multi-os linux+darwin active on either, inert on win32', () => {
  const c = '---\nos:\n  - linux\n  - osx\n---\nbody';
  assert.equal(extractRule(inp(c, 'linux')).active, true);
  assert.equal(extractRule(inp(c, 'darwin')).active, true);
  assert.equal(extractRule(inp(c, 'win32')).active, false);
});
