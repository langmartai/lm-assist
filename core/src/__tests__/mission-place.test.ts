import { test } from 'node:test';
import assert from 'node:assert';
import { place, Mission } from '../mission/mission-model';

const base = (over: Partial<Mission>): Mission => ({
  id: 'm', title: 't', objective: 'o', projects: [], dependsOn: [],
  env: { isolation: 'cloud', resources: [] }, binding: null, progress: null,
  control: { nudgeCount: 0, backoffStep: 0 }, results: [], adjustments: [],
  status: 'active', ownerNode: 'gw4-1', createdAt: 0, updatedAt: 0, ...over,
});

test('unmet dependency blocks placement', () => {
  const m = base({ id: 'a', dependsOn: ['b'] });
  const dep = base({ id: 'b', status: 'active' });
  assert.deepStrictEqual(place(m, [m, dep]), { go: false, reason: 'dependency', waitOn: ['b'] });
});

test('done dependency unblocks; cloud is isolated', () => {
  const m = base({ id: 'a', dependsOn: ['b'] });
  const dep = base({ id: 'b', status: 'done' });
  assert.deepStrictEqual(place(m, [m, dep]), { go: true, env: 'cloud' });
});

test('shared running resource on same host serializes', () => {
  const m = base({ id: 'a', env: { isolation: 'shared', host: 'h1', resources: ['db:main'] } });
  const holder = base({ id: 'z', status: 'active', binding: { sessionId: 's', node: 'h1', kind: 'worker' }, env: { isolation: 'shared', host: 'h1', resources: ['db:main'] } });
  assert.deepStrictEqual(place(m, [m, holder]), { go: false, reason: 'resource', conflictWith: 'z' });
});

test('paused non-exclusive holder does NOT block', () => {
  const m = base({ id: 'a', env: { isolation: 'shared', host: 'h1', resources: ['db:main'] } });
  const holder = base({ id: 'z', status: 'paused', env: { isolation: 'shared', host: 'h1', resources: ['db:main'] } });
  assert.deepStrictEqual(place(m, [m, holder]), { go: true, env: 'shared', lease: 'db:main' });
});

test('exclusive resource is reserved even when holder paused', () => {
  const m = base({ id: 'a', env: { isolation: 'shared', host: 'h1', resources: ['oanda:live'] } });
  const holder = base({ id: 'z', status: 'paused', env: { isolation: 'shared', host: 'h1', resources: ['oanda:live'], exclusive: true } });
  assert.deepStrictEqual(place(m, [m, holder]), { go: false, reason: 'resource', conflictWith: 'z' });
});

test('worktree placement defaults branch to mission/<id>', () => {
  const m = base({ id: 'a', env: { isolation: 'worktree', host: 'h1', repo: 'lm-assist', resources: [] } });
  assert.deepStrictEqual(place(m, [m]), { go: true, env: 'worktree', host: 'h1', repo: 'lm-assist', branch: 'mission/a' });
});

test('incoming exclusive mission is blocked by a non-terminal shared holder', () => {
  const m = base({ id: 'a', env: { isolation: 'shared', host: 'h1', resources: ['gpu:0'], exclusive: true } });
  const holder = base({ id: 'z', status: 'paused', env: { isolation: 'shared', host: 'h1', resources: ['gpu:0'] } });
  assert.deepStrictEqual(place(m, [m, holder]), { go: false, reason: 'resource', conflictWith: 'z' });
});

test('a done holder releases the resource (no block)', () => {
  const m = base({ id: 'a', env: { isolation: 'shared', host: 'h1', resources: ['gpu:0'], exclusive: true } });
  const holder = base({ id: 'z', status: 'done', env: { isolation: 'shared', host: 'h1', resources: ['gpu:0'], exclusive: true } });
  assert.deepStrictEqual(place(m, [m, holder]), { go: true, env: 'shared', lease: 'gpu:0' });
});
