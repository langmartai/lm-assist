/**
 * A mission leader validates `env.repo` for a node that may run a different OS.
 *
 * Measured on stage 2026-07-28: creating a mission for the Windows node was
 * rejected by the Linux leader with
 *
 *   400 INVALID_REPO: env.repo must be an absolute path — got "C:\home\lm-assist"
 *
 * because `path.isAbsolute` is `path.posix.isAbsolute` on Linux. It was therefore
 * impossible to place a mission on a repo path on the Windows node at all.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isAbsoluteRepoPath } from '../../mission/repo-path';

test('🔴 THE REGRESSION: a Windows drive path is absolute, even on a Linux leader', () => {
  assert.equal(isAbsoluteRepoPath('C:\\home\\lm-assist'), true);
});

test('POSIX absolute paths still pass', () => {
  assert.equal(isAbsoluteRepoPath('/home/ubuntu/lm-assist'), true);
  assert.equal(isAbsoluteRepoPath('/'), true);
});

test('Windows variants: any drive letter, forward slashes, UNC shares', () => {
  assert.equal(isAbsoluteRepoPath('D:\\ws\\proj'), true);
  assert.equal(isAbsoluteRepoPath('C:/home/lm-assist'), true);
  assert.equal(isAbsoluteRepoPath('\\\\server\\share\\repo'), true);
});

test('genuinely relative paths are still refused — the guard keeps its purpose', () => {
  // The refusal exists because a relative repo resolves against Core's install
  // directory and fails later as a confusing git ENOENT.
  assert.equal(isAbsoluteRepoPath('lm-assist'), false);
  assert.equal(isAbsoluteRepoPath('./lm-assist'), false);
  assert.equal(isAbsoluteRepoPath('../lm-assist'), false);
  assert.equal(isAbsoluteRepoPath('home/ubuntu/lm-assist'), false);
});

test('a bare drive letter with no separator is NOT absolute', () => {
  // "C:foo" is drive-RELATIVE on Windows — it resolves against that drive's cwd.
  assert.equal(isAbsoluteRepoPath('C:foo'), false);
});

test('empty string is not absolute', () => {
  assert.equal(isAbsoluteRepoPath(''), false);
});
