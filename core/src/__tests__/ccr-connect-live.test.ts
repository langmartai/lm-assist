import { test } from 'node:test';
import assert from 'node:assert';
import { mapEnsureToConnectError } from '../terminal/ccr-manager';

test('connected → no error (null)', () => {
  assert.strictEqual(mapEnsureToConnectError('connected'), null);
});
test('already-connected → no error (null)', () => {
  assert.strictEqual(mapEnsureToConnectError('already-connected'), null);
});
test('needs-force → CONFLICT with force hint', () => {
  const e = mapEnsureToConnectError('needs-force');
  assert.strictEqual(e?.code, 'CONFLICT');
  assert.match(e?.message || '', /force/i);
});
test('kill-failed → CONFLICT', () => {
  assert.strictEqual(mapEnsureToConnectError('kill-failed')?.code, 'CONFLICT');
});
test('gone → SESSION_NOT_FOUND', () => {
  assert.strictEqual(mapEnsureToConnectError('gone')?.code, 'SESSION_NOT_FOUND');
});
test('error → INTERNAL_ERROR', () => {
  assert.strictEqual(mapEnsureToConnectError('error')?.code, 'INTERNAL_ERROR');
});
