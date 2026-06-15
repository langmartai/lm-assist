import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCwdAllowed } from '../utils/cwd-allowlist';

// Bug #1: the allowlist was hardcoded to `/home/ubuntu`, so agent_execute /
// terminal_open_tab were categorically rejected on any worker whose home is
// not /home/ubuntu (yitest = /home/yi, Windows = C:\Users\yi). The gate must be
// based on the executing worker's OWN home dir.

test('isCwdAllowed: allows the given home dir and its subdirs', () => {
  assert.equal(isCwdAllowed('/home/yi', '/home/yi'), true);
  assert.equal(isCwdAllowed('/home/yi/lm-proxy', '/home/yi'), true);
  assert.equal(isCwdAllowed('/home/yi/a/b/c', '/home/yi'), true);
});

test('isCwdAllowed: rejects paths outside the given home dir', () => {
  assert.equal(isCwdAllowed('/etc/passwd', '/home/yi'), false);
  // a DIFFERENT user's home is not the allowlist root
  assert.equal(isCwdAllowed('/home/ubuntu/x', '/home/yi'), false);
  // no prefix-escape (/home/yixyz must not match root /home/yi)
  assert.equal(isCwdAllowed('/home/yixyz', '/home/yi'), false);
  assert.equal(isCwdAllowed('', '/home/yi'), false);
});

test('isCwdAllowed: handles a Windows home dir with backslashes', () => {
  assert.equal(isCwdAllowed('C:\\Users\\yi', 'C:\\Users\\yi'), true);
  assert.equal(isCwdAllowed('C:\\Users\\yi\\proj', 'C:\\Users\\yi'), true);
  assert.equal(isCwdAllowed('C:\\Users\\other', 'C:\\Users\\yi'), false);
});
