import { test } from 'node:test';
import assert from 'node:assert';
import { resolveClaudeBinary, getClaudeBinaryPath } from '../utils/process-utils';

test('prefers ~/.local/bin/claude when it exists (117 case)', () => {
  const got = resolveClaudeBinary('/home/ubuntu', (p) => p === '/home/ubuntu/.local/bin/claude');
  assert.equal(got, '/home/ubuntu/.local/bin/claude');
});

test('falls through to /usr/bin/claude when ~/.local is absent (123 npm-global case)', () => {
  // The bug: old code returned the non-existent ~/.local/bin/claude here.
  const got = resolveClaudeBinary('/home/yi', (p) => p === '/usr/bin/claude');
  assert.equal(got, '/usr/bin/claude');
});

test('uses /usr/local/bin/claude before /usr/bin when both exist', () => {
  const got = resolveClaudeBinary('/home/yi', (p) => p === '/usr/local/bin/claude' || p === '/usr/bin/claude');
  assert.equal(got, '/usr/local/bin/claude');
});

test('falls back to bare "claude" (PATH) when no candidate exists', () => {
  assert.equal(resolveClaudeBinary('/home/x', () => false), 'claude');
});

test('getClaudeBinaryPath never returns a non-existent absolute path', () => {
  const p = getClaudeBinaryPath();
  if (p === 'claude' || process.platform === 'win32') return; // PATH fallback is fine
  const fs = require('fs');
  assert.ok(fs.existsSync(p), `getClaudeBinaryPath returned a non-existent path: ${p}`);
});
