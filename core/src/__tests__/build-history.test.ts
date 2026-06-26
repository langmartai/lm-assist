import { test } from 'node:test';
import assert from 'node:assert';
import { applyBuild } from '../monitor/build-history';
import { formatBuilds } from '../mcp-server/tools/node-builds';

const ctx = (now = '2026-06-26T00:00:00Z') => ({
  node: 'A',
  nodeVersion: 'v20',
  platform: 'linux',
  now,
});

test('first boot: changed, previousVersion null, one event', () => {
  const r = applyBuild(null, '0.1.108', ctx());
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.next.previousVersion, null);
  assert.strictEqual(r.next.history.length, 1);
  assert.strictEqual(r.next.current, '0.1.108');
});

test('no change: changed false, history preserved, upgradedAt kept', () => {
  const prev = applyBuild(null, '0.1.108', ctx('t1')).next;
  const r = applyBuild(prev, '0.1.108', ctx('t2'));
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.next.upgradedAt, 't1');
  assert.strictEqual(r.next.history.length, 1);
});

test('upgrade: changed, previousVersion set, event prepended', () => {
  const prev = applyBuild(null, '0.1.108', ctx('t1')).next;
  const r = applyBuild(prev, '0.1.109', ctx('t2'));
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.next.previousVersion, '0.1.108');
  assert.strictEqual(r.next.upgradedAt, 't2');
  assert.strictEqual(r.next.history[0].version, '0.1.109');
  assert.strictEqual(r.next.history.length, 2);
});

test('history caps at 20', () => {
  let h = applyBuild(null, 'v0', ctx('t')).next;
  for (let i = 1; i <= 25; i++) h = applyBuild(h, 'v' + i, ctx('t' + i)).next;
  assert.ok(h.history.length <= 20);
});

test('formatBuilds: one line per node + unknown', () => {
  const s = formatBuilds([
    { node: 'A', version: '0.1.109', upgradedAt: 't' },
    { node: 'B', version: '?', upgradedAt: null },
  ]);
  assert.match(s, /A/);
  assert.match(s, /0\.1\.109/);
  assert.match(s, /B/);
  assert.match(s, /upgrade time unknown/);
});

test('formatBuilds empty', () => assert.match(formatBuilds([]), /no nodes/i));
