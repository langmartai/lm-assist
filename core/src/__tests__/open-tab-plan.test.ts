import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { planOpenTab } from '../mcp-server/tools/open-tab-plan';

// Bug #2: handleTerminalOpenTab forwarded only command/cwd/title/kind, dropping
// sshTarget and tmuxSession — so wt-ssh/tmux kinds always failed "requires X"
// even when the caller supplied them.
// Bug #3: there was no Windows-native kind, so a command could not be run on a
// win32 node. Default (no kind) now routes to the platform-neutral
// /terminal/local (tmux on Linux, wt on Windows).

test('planOpenTab: no kind -> platform-neutral /terminal/local', () => {
  const plan = planOpenTab({ command: 'echo hi' });
  assert.ok(!('error' in plan), 'should not be an error');
  if ('error' in plan) return;
  assert.equal(plan.route, '/terminal/local');
  assert.equal(plan.body.command, 'echo hi');
  assert.equal(plan.body.kind, undefined);
});

test('planOpenTab: explicit wt-ssh kind forwards sshTarget (bug #2)', () => {
  const plan = planOpenTab({ command: 'whoami', kind: 'wt-ssh', sshTarget: 'localhost' });
  assert.ok(!('error' in plan));
  if ('error' in plan) return;
  assert.equal(plan.route, '/terminal/tabs');
  assert.equal(plan.body.kind, 'wt-ssh');
  assert.equal(plan.body.sshTarget, 'localhost');
});

test('planOpenTab: explicit tmux kind forwards tmuxSession (bug #2)', () => {
  const plan = planOpenTab({ command: 'ls', kind: 'tmux', tmuxSession: 'work' });
  assert.ok(!('error' in plan));
  if ('error' in plan) return;
  assert.equal(plan.route, '/terminal/tabs');
  assert.equal(plan.body.tmuxSession, 'work');
});

test('planOpenTab: missing command -> error', () => {
  const plan = planOpenTab({});
  assert.ok('error' in plan);
});

test('planOpenTab: cwd outside the worker home -> error', () => {
  const plan = planOpenTab({ command: 'x', cwd: '/etc/nope' });
  assert.ok('error' in plan);
});

test('planOpenTab: cwd under the worker home is allowed', () => {
  const plan = planOpenTab({ command: 'x', cwd: path.join(os.homedir(), 'proj') });
  assert.ok(!('error' in plan));
});
