import { test } from 'node:test';
import assert from 'node:assert';
import { startNativeExecutor } from '../mission/mission-controller';

const mission = {
  id: 'mission_x',
  title: 'T',
  objective: 'do it',
  env: { isolation: 'worktree', repo: 'r', host: 'h', resources: [] },
  binding: null,
} as any;

test('startNativeExecutor launches, discovers the cse, returns a native binding', async () => {
  const deps = {
    ensureWorktree: async () => '/wt/mission_x',
    launch: async () => ({ sessionId: 'uuid-123', terminal: 'lmcc-1' }),
    listAccount: async () => [{ sid: 'cse_NEW', status: 'active' }],
    baseline: ['cse_OLD'],
    drive: async () => {},
  };
  const b = await startNativeExecutor(mission, { go: true, env: 'worktree', host: 'h', repo: 'r', branch: 'mission/mission_x' }, deps);
  assert.strictEqual(b.sessionId, 'uuid-123');
  assert.strictEqual(b.kind, 'worker');
  assert.strictEqual(b.ccr?.cse, 'cse_NEW');
  assert.strictEqual(b.ccr?.sid, 'session_NEW');
});

test('no new cse discovered -> binding without ccr (local-only fallback)', async () => {
  const deps = {
    ensureWorktree: async () => '/wt',
    launch: async () => ({ sessionId: 'uuid-9', terminal: 't' }),
    listAccount: async () => [{ sid: 'cse_OLD' }],
    baseline: ['cse_OLD'],
    drive: async () => {},
  };
  const b = await startNativeExecutor(mission, { go: true, env: 'worktree', host: 'h', repo: 'r', branch: 'b' }, deps);
  assert.strictEqual(b.sessionId, 'uuid-9');
  assert.strictEqual(b.ccr, undefined);
});
