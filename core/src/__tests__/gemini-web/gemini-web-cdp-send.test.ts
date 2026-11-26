import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiWebCdpSend } from '../../utils/gemini-web-cdp';
import { createGeminiWebRoutes } from '../../routes/core/gemini-web.routes';

test('geminiWebCdpSend and POST /gemini-web/browser/send validate inputs and closed CDP ports without throwing', async () => {
  const emptyPrompt = await geminiWebCdpSend({ prompt: '   ' });
  assert.equal(emptyPrompt.ok, false);
  if (!emptyPrompt.ok) assert.equal(emptyPrompt.code, 'MISSING_PROMPT');

  const badConv = await geminiWebCdpSend({ prompt: 'hello', convId: 'not-a-valid-id!' });
  assert.equal(badConv.ok, false);
  if (!badConv.ok) assert.equal(badConv.code, 'INVALID_CONV_ID');

  const unreachable = await geminiWebCdpSend({ port: 59998, prompt: 'hello' });
  assert.equal(unreachable.ok, false);
  if (!unreachable.ok) assert.equal(unreachable.code, 'DEBUG_PORT_UNREACHABLE');

  const routes = createGeminiWebRoutes({} as never);
  const sendRoute = routes.find((r) => r.method === 'POST' && r.pattern.test('/gemini-web/browser/send'));
  assert.ok(sendRoute, 'POST /gemini-web/browser/send should be registered');

  const rEmpty = (await sendRoute!.handler(
    { method: 'POST', path: '/gemini-web/browser/send', params: {}, query: {}, body: {} } as never,
    undefined as never,
  )) as { success: boolean; error?: { code: string } };
  assert.equal(rEmpty.success, false);
  assert.equal(rEmpty.error?.code, 'MISSING_PROMPT');

  const rBadConv = (await sendRoute!.handler(
    {
      method: 'POST',
      path: '/gemini-web/browser/send',
      params: {},
      query: {},
      body: { prompt: 'hello', convId: 'invalid!' },
    } as never,
    undefined as never,
  )) as { success: boolean; error?: { code: string } };
  assert.equal(rBadConv.success, false);
  assert.equal(rBadConv.error?.code, 'INVALID_CONV_ID');

  const rClosedPort = (await sendRoute!.handler(
    {
      method: 'POST',
      path: '/gemini-web/browser/send',
      params: {},
      query: {},
      body: { port: 59998, prompt: 'hello' },
    } as never,
    undefined as never,
  )) as { success: boolean; error?: { code: string } };
  assert.equal(rClosedPort.success, false);
  assert.equal(rClosedPort.error?.code, 'DEBUG_PORT_UNREACHABLE');
});
