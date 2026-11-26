import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  geminiWebCdpDeleteConversation,
  geminiWebCdpOverview,
} from '../../utils/gemini-web-cdp';
import { createGeminiWebRoutes } from '../../routes/core/gemini-web.routes';

test('geminiWebCdpOverview, geminiWebCdpDeleteConversation, and browser overview/delete routes validate safely', async () => {
  const ov = await geminiWebCdpOverview({ port: 59997, limit: 10 });
  assert.equal(ov.ok, true);
  assert.equal(ov.status.loggedIn, false);
  assert.deepEqual(ov.models, []);
  assert.deepEqual(ov.conversations, []);
  assert.equal(ov.usage, null);

  const badDel = await geminiWebCdpDeleteConversation({ port: 59997, convId: 'bad!' });
  assert.equal(badDel.ok, false);
  if (!badDel.ok) assert.equal(badDel.code, 'INVALID_CONV_ID');

  const closedDel = await geminiWebCdpDeleteConversation({ port: 59997, convId: 'c_1234567890abcdef' });
  assert.equal(closedDel.ok, false);
  if (!closedDel.ok) assert.equal(closedDel.code, 'DEBUG_PORT_UNREACHABLE');

  const routes = createGeminiWebRoutes({} as never);
  const ovRoute = routes.find((r) => r.method === 'GET' && r.pattern.test('/gemini-web/browser/overview'));
  const delRoute = routes.find(
    (r) => r.method === 'POST' && r.pattern.test('/gemini-web/browser/conversations/c_1234567890abcdef/delete'),
  );
  assert.ok(ovRoute, 'GET /gemini-web/browser/overview should be registered');
  assert.ok(delRoute, 'POST /gemini-web/browser/conversations/:id/delete should be registered');

  const ovRes = (await ovRoute!.handler(
    {
      method: 'GET',
      path: '/gemini-web/browser/overview',
      params: {},
      query: { port: '59997', limit: '5' },
      body: {},
    } as never,
    undefined as never,
  )) as { success: boolean; data?: { status: { loggedIn: boolean } } };
  assert.equal(ovRes.success, true);
  assert.equal(ovRes.data?.status.loggedIn, false);

  const delRes = (await delRoute!.handler(
    {
      method: 'POST',
      path: '/gemini-web/browser/conversations/c_1234567890abcdef/delete',
      params: { id: 'c_1234567890abcdef' },
      query: {},
      body: { port: 59997 },
    } as never,
    undefined as never,
  )) as { success: boolean; error?: { code: string } };
  assert.equal(delRes.success, false);
  assert.equal(delRes.error?.code, 'DEBUG_PORT_UNREACHABLE');
});
