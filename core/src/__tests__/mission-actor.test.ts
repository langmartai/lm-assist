import { test } from 'node:test';
import assert from 'node:assert';
import { resolveMcpActor } from '../mission/mission-actor';

const D = (v: any) => ({ resolve: async () => v });

test('precise Claude Code match -> local-session with node', async () => {
  const a = await resolveMcpActor('toolu_1', 'gw4-n', 5, D({ claudeCode: { id: 'sess-1', label: 'lm-assist' }, precise: true }));
  assert.equal(a.kind, 'local-session');
  assert.equal(a.id, 'sess-1');
  assert.equal(a.node, 'gw4-n');
  assert.equal(a.toolUseId, 'toolu_1');
  assert.equal(a.channel, 'mcp');
});

test('claude.ai candidate -> claudeai-conversation (no node)', async () => {
  const a = await resolveMcpActor('toolu_2', 'gw4-n', 5, D({ claudeAi: { id: 'conv-9', label: 'planning' } }));
  assert.equal(a.kind, 'claudeai-conversation');
  assert.equal(a.id, 'conv-9');
});

test('nothing resolved -> coarse user', async () => {
  const a = await resolveMcpActor('toolu_3', 'gw4-n', 5, D({}));
  assert.equal(a.kind, 'user');
  assert.equal(a.channel, 'mcp');
});

test('resolver throwing -> coarse user, never throws', async () => {
  const a = await resolveMcpActor('toolu_4', 'gw4-n', 5, { resolve: async () => { throw new Error('boom'); } });
  assert.equal(a.kind, 'user');
});

test('no toolUseId -> coarse user without resolving', async () => {
  const a = await resolveMcpActor(undefined, 'gw4-n', 5);
  assert.equal(a.kind, 'user');
});
