import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decodePath } from '../utils/path-utils';

// Regression: 2026-07-15 outage — decodePathWithFilesystemCheck froze partIndex forever
// on a REPEATED path segment (executor worktree bucket ...-worktrees-mission-mission-<id>),
// pegging Core at 100% CPU during MemoryCache boot scan AND at runtime. The decoder must
// TERMINATE on every input, repeated segments included.

function encoded(p: string): string {
  return p.replace(/[/.]/g, '-');
}

test('decoder terminates on repeated segments over real directories (the outage input shape)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-'));
  try {
    // Mirror the outage: <repo>/.claude/worktrees/mission-mission_x — 'mission' repeats
    fs.mkdirSync(path.join(base, 'repo', '.claude', 'worktrees'), { recursive: true });
    const enc = encoded(path.join(base, 'repo', '.claude', 'worktrees', 'mission-mission_4b368ed0'));
    const start = Date.now();
    const out = decodePath(enc);
    assert.ok(Date.now() - start < 2000, 'decode must not spin');
    assert.ok(out.startsWith(base), `decoded under the tmp base: ${out}`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('decoder terminates on repeated segments with a nonexistent root', () => {
  const start = Date.now();
  const out = decodePath('-no-such-root-x-x-x-y');
  assert.ok(Date.now() - start < 2000, 'decode must not spin');
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
});

test('decoder still resolves a real dashed directory correctly', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dec2-'));
  try {
    fs.mkdirSync(path.join(base, 'lm-assist'), { recursive: true });
    const out = decodePath(encoded(path.join(base, 'lm-assist')));
    assert.equal(out, path.join(base, 'lm-assist'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
