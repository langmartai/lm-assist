import { test } from 'node:test';
import assert from 'node:assert';
import { remoteControlFlags } from '../terminal/cc';
test('remoteControlFlags emits the flag', () => {
  assert.deepStrictEqual(remoteControlFlags(true), ['--remote-control']);
  assert.deepStrictEqual(remoteControlFlags(false), []);
  assert.deepStrictEqual(remoteControlFlags(undefined), []);
});
