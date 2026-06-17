import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithMcpContext, currentMcpContext } from '../../mcp-server/principal-context';

test('mcp context: carries principal within run, undefined outside', () => {
  assert.equal(currentMcpContext(), undefined);
  const out = runWithMcpContext({ principal: { type: 'cloud', userId: 'u1' } }, () => {
    const c = currentMcpContext();
    return c?.principal;
  });
  assert.deepEqual(out, { type: 'cloud', userId: 'u1' });
  assert.equal(currentMcpContext(), undefined); // restored after run
});

test('mcp context: nested runs isolate', async () => {
  await runWithMcpContext({ principal: { type: 'local' } }, async () => {
    assert.equal(currentMcpContext()?.principal.type, 'local');
    await runWithMcpContext({ principal: { type: 'cloud', userId: 'x' } }, async () => {
      assert.equal(currentMcpContext()?.principal.type, 'cloud');
    });
    assert.equal(currentMcpContext()?.principal.type, 'local'); // inner did not leak
  });
});
