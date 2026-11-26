import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createColabRoutes } from '../../routes/core/colab.routes';
import {
  colabMutateToolDef,
  colabQueryToolDef,
  handleColabMutate,
  handleColabQuery,
} from '../../mcp-server/tools/colab';

test('createColabRoutes and colab MCP tool definitions enforce schemas and block raw cli over MCP', async () => {
  const routes = createColabRoutes({} as never);

  const listRoute = routes.find((r) => r.method === 'GET' && r.pattern.test('/colab'));
  const statusRoute = routes.find((r) => r.method === 'GET' && r.pattern.test('/colab/status'));
  const actionRoute = routes.find((r) => r.method === 'POST' && r.pattern.test('/colab/unknown-op'));
  assert.ok(listRoute, 'GET /colab should be registered');
  assert.ok(statusRoute, 'GET /colab/status should be registered');
  assert.ok(actionRoute, 'POST /colab/:action should be registered');

  const listRes = (await listRoute!.handler(
    { method: 'GET', path: '/colab', params: {}, query: {}, body: {} } as never,
    undefined as never,
  )) as { success: boolean; data?: { actions: string[]; readActions: string[]; writeActions: string[] } };
  assert.equal(listRes.success, true);
  assert.ok(listRes.data!.actions.includes('cli'));
  assert.ok(listRes.data!.readActions.includes('doctor'));
  assert.ok(listRes.data!.writeActions.includes('ssh-exec'));

  const statusRes = (await statusRoute!.handler(
    { method: 'GET', path: '/colab/status', params: {}, query: {}, body: {} } as never,
    undefined as never,
  )) as { success: boolean; ok: boolean; backend: string; data?: { platform: string; binary: string } };
  assert.equal(statusRes.success, true);
  assert.equal(statusRes.ok, true);
  assert.equal(statusRes.backend, 'colab-cli');
  assert.ok(statusRes.data?.binary);

  const m = '/colab/unknown-op'.match(actionRoute!.pattern);
  const unknownRes = (await actionRoute!.handler(
    {
      method: 'POST',
      path: '/colab/unknown-op',
      params: { action: m?.groups?.action || 'unknown-op' },
      query: {},
      body: {},
    } as never,
    undefined as never,
  )) as { success: boolean; ok: boolean; error?: { code: string } };
  assert.equal(unknownRes.success, false);
  assert.equal(unknownRes.ok, false);
  assert.equal(unknownRes.error?.code, 'UNKNOWN_ACTION');

  assert.equal(colabQueryToolDef.annotations.readOnlyHint, true);
  const readEnum: readonly string[] = colabQueryToolDef.inputSchema.properties.action.enum;
  assert.ok(readEnum.includes('sessions'));
  assert.ok(!readEnum.includes('exec'));

  assert.equal(colabMutateToolDef.annotations.readOnlyHint, false);
  const writeEnum: readonly string[] = colabMutateToolDef.inputSchema.properties.action.enum;
  assert.ok(writeEnum.includes('exec'));
  assert.ok(!writeEnum.includes('cli'));

  const badQuery = await handleColabQuery({ action: 'exec' });
  assert.equal(badQuery.isError, true);

  const badMutate = await handleColabMutate({ action: 'cli', args: ['version'] });
  assert.equal(badMutate.isError, true);
});
