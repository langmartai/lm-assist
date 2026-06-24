import { test } from 'node:test';
import assert from 'node:assert';
import { readNativeExecutor } from '../mission/mission-controller';

test('readNativeExecutor builds newOutput from the local conversation', async () => {
  const m = { binding: { sessionId: 'uuid', node: 'n', kind: 'worker', ccr: { cse: 'cse_x', sid: 'session_x' } }, control: { lastOutputCursor: 1 } } as any;
  const deps = { verdict: () => ({ driveable: true }), readConversation: async () => ({ messages: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }) };
  const st = await readNativeExecutor(m, deps);
  assert.strictEqual(st.alive, true);
  assert.strictEqual(st.newOutput?.messages.length, 2); // slice from cursor 1
});
