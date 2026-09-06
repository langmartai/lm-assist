/**
 * windows_terminal_create launch flags (2026-09): the Windows launcher could
 * pass NOTHING but resume / skip-permissions / remote-control internally, and
 * the MCP tool exposed none of them — a resume that had to come up on the right
 * model with bypass + /remote-control needed a manual relaunch from cmd.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWindowsClaudeCommand, WINDOWS_PERMISSION_MODE_FLAGS } from '../terminal/windows-cc';

test('bare launch and a plain resume are unchanged', () => {
  assert.equal(buildWindowsClaudeCommand({}), 'claude');
  assert.equal(buildWindowsClaudeCommand({ resume: 'abc-123' }), 'claude --resume abc-123');
});

test('the operator case: resume + model + bypass + remote-control + name in ONE launch', () => {
  const cmd = buildWindowsClaudeCommand({
    resume: '69239dc7-2f78-47c6-ab3f-27a149d3855b', model: 'opus', permissionMode: 'bypassPermissions', remoteControl: true, name: 'ops bugs',
  });
  assert.equal(cmd, 'claude --resume 69239dc7-2f78-47c6-ab3f-27a149d3855b --remote-control --dangerously-skip-permissions --model opus -n "ops bugs"');
});

test('permission modes map to the flag claude accepts; unknown mode ⇒ no flag (no false claim)', () => {
  assert.equal(buildWindowsClaudeCommand({ permissionMode: 'acceptEdits' }), 'claude --permission-mode acceptEdits');
  assert.equal(buildWindowsClaudeCommand({ permissionMode: 'plan' }), 'claude --permission-mode plan');
  assert.equal(buildWindowsClaudeCommand({ permissionMode: 'dontAsk' }), 'claude --permission-mode dontAsk');
  assert.equal(buildWindowsClaudeCommand({ permissionMode: 'default' }), 'claude');
  assert.equal(buildWindowsClaudeCommand({ permissionMode: 'yolo' }), 'claude');
  assert.deepEqual(Object.keys(WINDOWS_PERMISSION_MODE_FLAGS).sort(), ['acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan']);
});

test('skipPermissions (legacy) still means bypass; an explicit permissionMode wins over it', () => {
  assert.equal(buildWindowsClaudeCommand({ skipPermissions: true }), 'claude --dangerously-skip-permissions');
  assert.equal(buildWindowsClaudeCommand({ skipPermissions: true, permissionMode: 'plan' }), 'claude --permission-mode plan');
});

test('model / effort / name are validated: bad values are DROPPED, names are cmd.exe-quoted', () => {
  assert.equal(buildWindowsClaudeCommand({ model: 'claude-opus-4-8[1m]' }), 'claude --model claude-opus-4-8[1m]');
  assert.equal(buildWindowsClaudeCommand({ model: 'opus && del *' }), 'claude');
  assert.equal(buildWindowsClaudeCommand({ effort: 'high' }), 'claude --effort high');
  assert.equal(buildWindowsClaudeCommand({ effort: 'turbo' }), 'claude');
  assert.equal(buildWindowsClaudeCommand({ name: 'a "quoted" name & more' }), 'claude -n "a \\"quoted\\" name & more"');
  assert.equal(buildWindowsClaudeCommand({ name: '   ' }), 'claude');
});

test('remoteControl accepts a string target but only a safe one', () => {
  assert.equal(buildWindowsClaudeCommand({ remoteControl: 'my-target' }), 'claude --remote-control my-target');
  assert.equal(buildWindowsClaudeCommand({ remoteControl: 'x y' }), 'claude --remote-control');
});

test('a resume id outside the session-id charset is refused (it goes into a cmd /k line)', () => {
  assert.throws(() => buildWindowsClaudeCommand({ resume: 'abc & calc' }), /refusing to launch/);
});
