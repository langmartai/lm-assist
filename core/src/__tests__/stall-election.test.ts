import { test } from 'node:test';
import assert from 'node:assert';
import { electMonitor } from '../monitor/stall-election';

test('lowest gateway-id self-elects', () => {
  assert.strictEqual(electMonitor(['gw4-aaa', 'gw4-bbb', 'gw4-ccc'], 'gw4-aaa'), true);
  assert.strictEqual(electMonitor(['gw4-aaa', 'gw4-bbb', 'gw4-ccc'], 'gw4-bbb'), false);
});

test('self not present in the list is still considered a candidate', () => {
  assert.strictEqual(electMonitor(['gw4-zzz'], 'gw4-aaa'), true); // aaa < zzz
  assert.strictEqual(electMonitor(['gw4-aaa'], 'gw4-zzz'), false);
});

test('single node (self only) is the monitor', () => {
  assert.strictEqual(electMonitor([], 'gw4-solo'), true);
  assert.strictEqual(electMonitor(['gw4-solo'], 'gw4-solo'), true);
});

test('null self never elects', () => {
  assert.strictEqual(electMonitor(['gw4-aaa'], null), false);
});
