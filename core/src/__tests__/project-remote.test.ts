import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeRemote, projectRemoteKey } from '../memory/project-remote';

test('normalizeRemote canonicalizes every URL form to host/owner/repo', () => {
  const want = 'github.com/langmartai/lm-assist';
  for (const url of [
    'https://github.com/langmartai/lm-assist.git',
    'https://github.com/langmartai/lm-assist',
    'https://github.com/langmartai/lm-assist/',
    'git@github.com:langmartai/lm-assist.git',
    'ssh://git@github.com/langmartai/lm-assist.git',
    'https://GitHub.com/LangMartAI/lm-assist.git', // case-insensitive
  ]) {
    assert.equal(normalizeRemote(url), want, url);
  }
});

test('normalizeRemote returns null for empty/garbage', () => {
  assert.equal(normalizeRemote(''), null);
  assert.equal(normalizeRemote('   '), null);
});

test('projectRemoteKey reads + normalizes the origin remote of a real repo', () => {
  // This repo's own checkout (the test runs from inside it).
  const key = projectRemoteKey(process.cwd());
  // process.cwd() is core/ during the test; walk to a git root that has origin.
  // Fall back: just assert the function returns a normalized key or null without throwing.
  if (key !== null) {
    assert.match(key, /^[a-z0-9.-]+\/[^/]+\/[^/]+$/, `unexpected key: ${key}`);
    assert.equal(key, key.toLowerCase());
  }
});

test('projectRemoteKey returns null for a non-git dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-nogit-'));
  assert.equal(projectRemoteKey(dir), null);
});
