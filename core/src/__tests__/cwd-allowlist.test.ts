import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isCwdAllowed, parseRootsList, configuredRoots, describeCwdPolicy, CWD_ROOTS_ENV, CWD_ROOTS_FILE } from '../utils/cwd-allowlist';
import { planOpenTab } from '../mcp-server/tools/open-tab-plan';

// Bug #1: the allowlist was hardcoded to `/home/ubuntu`, so agent_execute /
// terminal_open_tab were categorically rejected on any worker whose home is
// not /home/ubuntu (node-b = /home/yi, Windows = C:\Users\yi). The gate must be
// based on the executing worker's OWN home dir.

const WIN = process.platform === 'win32';

test('isCwdAllowed: allows the given home dir and its subdirs', () => {
  assert.equal(isCwdAllowed('/home/yi', '/home/yi', []), true);
  assert.equal(isCwdAllowed('/home/yi/lm-proxy', '/home/yi', []), true);
  assert.equal(isCwdAllowed('/home/yi/a/b/c', '/home/yi', []), true);
});

test('isCwdAllowed: rejects paths outside the given home dir', () => {
  assert.equal(isCwdAllowed('/etc/passwd', '/home/yi', []), false);
  // a DIFFERENT user's home is not the allowlist root
  assert.equal(isCwdAllowed('/home/ubuntu/x', '/home/yi', []), false);
  // no prefix-escape (/home/yixyz must not match root /home/yi)
  assert.equal(isCwdAllowed('/home/yixyz', '/home/yi', []), false);
  assert.equal(isCwdAllowed('', '/home/yi', []), false);
});

test('isCwdAllowed: handles a Windows home dir with backslashes', () => {
  assert.equal(isCwdAllowed('C:\\Users\\yi', 'C:\\Users\\yi', []), true);
  assert.equal(isCwdAllowed('C:\\Users\\yi\\proj', 'C:\\Users\\yi', []), true);
  assert.equal(isCwdAllowed('C:\\Users\\other', 'C:\\Users\\yi', []), false);
});

// Bug #3 (2026-09): on 107 the operator's repos live under C:\home; terminal_open_tab
// refused them while windows_terminal_create (ungated) opened them. A node can now
// declare extra roots — the gate stays, the policy is configurable and self-describing.

test('extra roots: a configured root admits its subtree, nothing else changes', () => {
  assert.equal(isCwdAllowed('C:\\home\\lm-assist', 'C:\\Users\\admin', ['C:\\home']), true);
  assert.equal(isCwdAllowed('C:/home/lm-assist/core', 'C:\\Users\\admin', ['C:\\home']), true);
  assert.equal(isCwdAllowed('C:\\homeless', 'C:\\Users\\admin', ['C:\\home']), false);
  assert.equal(isCwdAllowed('D:\\work', 'C:\\Users\\admin', ['C:\\home']), false);
  assert.equal(isCwdAllowed('/srv/repos/x', '/home/ubuntu', ['/srv/repos']), true);
  assert.equal(isCwdAllowed('/srv/other', '/home/ubuntu', ['/srv/repos']), false);
});

test('extra roots: drive-letter case is irrelevant on Windows only', () => {
  assert.equal(isCwdAllowed('c:\\home\\x', 'C:\\Users\\admin', ['C:\\home']), WIN);
});

test('parseRootsList: `;` or newline separated, comments and blanks dropped (`:` is NOT a separator — Windows paths contain it)', () => {
  assert.deepEqual(parseRootsList('C:\\home;D:\\work'), ['C:\\home', 'D:\\work']);
  assert.deepEqual(parseRootsList('# repos\n/srv/repos\n\n/opt/x # tail comment\n'), ['/srv/repos', '/opt/x']);
  assert.deepEqual(parseRootsList('/a:/b'), ['/a:/b']);
  assert.deepEqual(parseRootsList(undefined), []);
});

test('configuredRoots: env + <dataDir>/cwd-roots file, de-duplicated, never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-roots-'));
  fs.writeFileSync(path.join(dir, CWD_ROOTS_FILE), '/srv/repos\n# c\nC:\\home\n');
  const roots = configuredRoots({ env: { [CWD_ROOTS_ENV]: 'C:\\home;/opt/y' }, dataDir: dir });
  assert.deepEqual(roots, ['C:\\home', '/opt/y', '/srv/repos']);
  assert.deepEqual(configuredRoots({ env: {}, dataDir: path.join(dir, 'nope') }), []);
});

test('describeCwdPolicy: names the home, the extra roots, and BOTH ways to add one', () => {
  const t = describeCwdPolicy('C:\\Users\\admin', ['C:\\home']);
  assert.match(t, /C:\\Users\\admin and below/);
  assert.match(t, /configured roots: C:\\home/);
  assert.match(t, new RegExp(CWD_ROOTS_ENV));
  assert.match(t, new RegExp(CWD_ROOTS_FILE));
});

test('terminal_open_tab refusal carries the policy, not a bare "home and below"', () => {
  const plan = planOpenTab({ command: 'echo hi', cwd: '/definitely/not/allowed/anywhere' });
  assert.ok('error' in plan);
  assert.match(plan.error, /not permitted; allowed: /);
  assert.match(plan.error, new RegExp(CWD_ROOTS_ENV));
});
