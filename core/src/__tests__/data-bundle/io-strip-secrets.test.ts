import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { stripSecretKeys } from '../../data/bundle/sections/types';

test('secret-named keys are dropped and reported', () => {
  const r = stripSecretKeys({ a: 1, apiKey: 'sk-x', nested: { token: 't', ok: true } });
  assert.deepEqual(r.value, { a: 1, nested: { ok: true } });
  assert.deepEqual(r.redactedKeys.sort(), ['apiKey', 'nested.token']);
});

test('a key naming a secret LOCATION (…File/…Path/…Dir) is a path, not the secret — kept', () => {
  const profile = { access: [{ kind: 'ssh', identityFile: '~/.ssh/id' }, { kind: 'api', tokenFile: '~/.config/x/token', secretsDir: '/etc/x', keyPath: '/k' }] };
  const r = stripSecretKeys(profile);
  assert.deepEqual(r.value, profile);
  assert.deepEqual(r.redactedKeys, []);
});

test('bundle list does not print a dev node\'s mode twice', async () => {
  const { renderList } = await import('../../mcp-server/tools/data-bundle');
  const row = { bundleId: 'lmb-20260923-000000-abcdef', createdAt: '2026-09-23T00:00:00Z', sizeBytes: 10, source: { nodeId: 'n', hostname: 'box (dev)', platform: 'linux', lmAssistVersion: '0', mode: 'dev' }, sections: [] };
  const out = renderList([row] as unknown as Parameters<typeof renderList>[0]);
  assert.ok(out.includes('box (dev)'), out);
  assert.ok(!out.includes('(dev) (dev)'), out);
});
