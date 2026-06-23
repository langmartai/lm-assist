import { test } from 'node:test';
import assert from 'node:assert';
import { findLocalStalls } from '../monitor/stall-detect-local';
import { resumeLocal } from '../monitor/stall-resume';

test('findLocalStalls returns only server-stalled driveable sessions', async () => {
  const out = await findLocalStalls({
    listDriveable: async () => [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }],
    screenStateOf: async (id) => ({ a: 'overloaded', b: 'rate_limit_user', c: 'idle' } as any)[id],
  });
  assert.deepStrictEqual(out.map((s) => s.sessionId), ['a']); // b is user-limit, c is idle
  assert.strictEqual(out[0].category, 'overloaded');
});

test('resumeLocal posts continue and reports delivered', async () => {
  let sent: any = null;
  const ok = await resumeLocal('a', { post: async (p, b) => { sent = { p, b }; return { success: true, data: { delivered: true } }; } });
  assert.strictEqual(ok, true);
  assert.match(sent.p, /\/terminal\/cc-sessions\/a\/prompt$/);
  assert.strictEqual(sent.b.text, 'continue');
  assert.strictEqual(sent.b.submit, true);
});
