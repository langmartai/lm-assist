import { test } from 'node:test';
import assert from 'node:assert';
import { buildLaunchCmd } from '../terminal/cc';

const base = {
  cwd: '/x',
  model: null,
  extraFlags: [] as string[],
  skipPermissions: true,
  remoteControl: true,
  cols: 200,
  rows: 50,
  readyPattern: 'ctx:',
  readyTimeoutMs: 1,
  autoAcceptTrust: true,
};

test('buildLaunchCmd: no extras → no system-prompt/mcp flags', () => {
  const cmd = buildLaunchCmd({ ...base } as never);
  assert.ok(!cmd.includes('--append-system-prompt-file'), 'should not add system-prompt flag');
  assert.ok(!cmd.includes('--mcp-config'), 'should not add mcp-config flag');
  // sanity: still has the base flags
  assert.ok(cmd.includes('--dangerously-skip-permissions'));
  assert.ok(cmd.includes('--remote-control'));
});

test('buildLaunchCmd: with both extras → both flags + quoted paths', () => {
  const cmd = buildLaunchCmd({
    ...base,
    appendSystemPromptFile: '/tmp/sp.txt',
    mcpConfigPath: '/tmp/mcp.json',
  } as never);
  assert.ok(cmd.includes('--append-system-prompt-file'), 'has system-prompt flag');
  assert.ok(cmd.includes('/tmp/sp.txt'), 'has system-prompt path');
  assert.ok(cmd.includes('--mcp-config'), 'has mcp-config flag');
  assert.ok(cmd.includes('/tmp/mcp.json'), 'has mcp-config path');
});

test('buildLaunchCmd: only system-prompt extra → only that flag', () => {
  const cmd = buildLaunchCmd({ ...base, appendSystemPromptFile: '/tmp/sp.txt' } as never);
  assert.ok(cmd.includes('--append-system-prompt-file'));
  assert.ok(!cmd.includes('--mcp-config'));
});
