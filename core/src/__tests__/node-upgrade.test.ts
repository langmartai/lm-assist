import { test } from 'node:test';
import assert from 'node:assert';
import { resolveUpgradeSource } from '../mcp-server/tools/node-upgrade';

test('explicit source used', () => {
  const r = resolveUpgradeSource('/abs/lm-assist-0.1.111.tgz');
  assert.ok(r.ok && r.source === '/abs/lm-assist-0.1.111.tgz');
});

test('ref → github spec', () => {
  const r = resolveUpgradeSource(undefined, 'main');
  assert.ok(r.ok && r.source === 'github:langmartai/lm-assist#main');
});

test('source wins over ref', () => {
  const r = resolveUpgradeSource('https://x/y.tgz', 'main');
  assert.ok(r.ok && r.source === 'https://x/y.tgz');
});

test('neither → error (downgrade guard)', () => {
  const r = resolveUpgradeSource();
  assert.ok(!r.ok && /DOWNGRADE/.test(r.error));
});

test('empty/whitespace source → error', () => {
  assert.ok(!resolveUpgradeSource('   ').ok);
});

test('explicit latest rejected', () => {
  assert.ok(!resolveUpgradeSource('latest').ok);
  assert.ok(!resolveUpgradeSource('lm-assist@latest').ok);
});

test('bare lm-assist rejected (resolves to npm latest)', () => {
  assert.ok(!resolveUpgradeSource('lm-assist').ok);
});
