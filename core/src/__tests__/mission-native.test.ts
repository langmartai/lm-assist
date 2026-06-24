import { test } from 'node:test';
import assert from 'node:assert';
import { cseToSessionSid, isNativeBinding, pickNewSession } from '../mission/mission-native';

test('cseToSessionSid converts cse_ to session_', () => {
  assert.strictEqual(cseToSessionSid('cse_01ABC'), 'session_01ABC');
  assert.strictEqual(cseToSessionSid('session_01ABC'), 'session_01ABC');
});

test('isNativeBinding true only when ccr present', () => {
  assert.strictEqual(isNativeBinding({ sessionId: 'uuid', node: 'n', kind: 'worker', ccr: { cse: 'cse_x', sid: 'session_x' } } as any), true);
  assert.strictEqual(isNativeBinding({ sessionId: 'session_x', node: 'n', kind: 'worker' } as any), false);
  assert.strictEqual(isNativeBinding(null), false);
});

test('pickNewSession returns the session not in baseline (prefer active)', () => {
  const base = ['cse_a', 'cse_b'];
  assert.deepStrictEqual(pickNewSession(base, [{ sid: 'cse_a' }, { sid: 'cse_c', status: 'active' }]), { sid: 'cse_c' });
  assert.strictEqual(pickNewSession(base, [{ sid: 'cse_a' }, { sid: 'cse_b' }]), null);
});
