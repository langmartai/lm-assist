import { test } from 'node:test';
import assert from 'node:assert';
import { MissionBinding } from '../mission/mission-model';

test('MissionBinding carries optional ccr', () => {
  const b: MissionBinding = { sessionId: 'uuid', node: 'n', kind: 'worker', ccr: { cse: 'cse_x', sid: 'session_x', webUrl: 'https://claude.ai/code/session_x' } };
  assert.strictEqual(b.ccr?.sid, 'session_x');
});
