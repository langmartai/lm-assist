import { test } from 'node:test';
import assert from 'node:assert';
import { findRemoteStalls } from '../monitor/stall-detect-remote';

test('no cloud creds → empty (degrades to local-only)', async () => {
  const out = await findRemoteStalls({ hasCreds: () => false, list: async () => { throw new Error('should not be called'); }, readText: async () => '' });
  assert.deepStrictEqual(out, []);
});

test('returns only server-stalled cloud sessions', async () => {
  const out = await findRemoteStalls({
    hasCreds: () => true,
    list: async () => [{ sid: 's1', status: 'running' }, { sid: 's2', status: 'running' }, { sid: 's3', status: 'running' }],
    readText: async (sid) => ({ s1: 'API Error: 529 Overloaded', s2: 'Claude usage limit reached', s3: 'working...' } as any)[sid],
  });
  assert.deepStrictEqual(out.map((s) => s.sid), ['s1']); // s2 user-limit, s3 healthy
  assert.strictEqual(out[0].category, 'overloaded');
});
