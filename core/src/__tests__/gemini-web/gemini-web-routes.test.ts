import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createGeminiWebRoutes } from '../../routes/core/gemini-web.routes';

const routes = createGeminiWebRoutes({} as never);

function callRoute(method: string, path: string, body: unknown = {}) {
  const match = routes.find((r) => r.method === method && r.pattern.test(path));
  assert.ok(match, `No route matched ${method} ${path}`);
  const params = (path.match(match!.pattern)?.groups || {}) as Record<string, string>;
  return match!.handler(
    { method, path, params, query: {}, body } as never,
    undefined as never,
  );
}

test('createGeminiWebRoutes handles route ordering, validation errors, and valid snippet envelopes', async () => {
  // /conversations/send MUST NOT be swallowed by /conversations/:id
  const missingSendPrompt = (await callRoute('POST', '/gemini-web/via-chrome/conversations/send', {})) as {
    success: boolean;
    error?: { code: string };
  };
  assert.equal(missingSendPrompt.success, false);
  assert.equal(missingSendPrompt.error?.code, 'MISSING_PROMPT');

  const sendAny = (await callRoute('POST', '/gemini-web/via-chrome/conversations/send', {
    prompt: 'Summarize today',
  })) as { success: boolean; data: { snippet: string; method: string; url: string } };
  assert.equal(sendAny.success, true);
  assert.equal(sendAny.data.url, 'https://gemini.google.com/app');
  new vm.Script(sendAny.data.snippet);

  const missingRpc = (await callRoute('POST', '/gemini-web/via-chrome', {})) as {
    success: boolean;
    error?: { code: string };
  };
  assert.equal(missingRpc.success, false);
  assert.equal(missingRpc.error?.code, 'MISSING_RPC_ID');

  const badArgs = (await callRoute('POST', '/gemini-web/via-chrome', { rpcId: 'otAQ7b', args: 'bad' })) as {
    success: boolean;
    error?: { code: string };
  };
  assert.equal(badArgs.success, false);
  assert.equal(badArgs.error?.code, 'INVALID_ARGS');

  const badConv = (await callRoute('POST', '/gemini-web/via-chrome/conversations/not-hex', {})) as {
    success: boolean;
    error?: { code: string };
  };
  assert.equal(badConv.success, false);
  assert.equal(badConv.error?.code, 'INVALID_REQUEST');

  const missingTitle = (await callRoute('POST', '/gemini-web/via-chrome/conversations/4935b1d94c4d20e6/rename', {})) as {
    success: boolean;
    error?: { code: string };
  };
  assert.equal(missingTitle.success, false);
  assert.equal(missingTitle.error?.code, 'MISSING_TITLE');

  const validPaths: Array<[string, Record<string, unknown>]> = [
    ['/gemini-web/via-chrome/health-check', {}],
    ['/gemini-web/via-chrome', { rpcId: 'otAQ7b', args: [1] }],
    ['/gemini-web/via-chrome/models', {}],
    ['/gemini-web/via-chrome/conversations', { limit: 20 }],
    ['/gemini-web/via-chrome/conversations/c_4935b1d94c4d20e6', { maxTurns: 8 }],
    ['/gemini-web/via-chrome/conversations/4935b1d94c4d20e6/rename', { title: 'My Chat' }],
    ['/gemini-web/via-chrome/conversations/4935b1d94c4d20e6/delete', {}],
    ['/gemini-web/via-chrome/conversations/4935b1d94c4d20e6/send', { prompt: 'Follow up' }],
    ['/gemini-web/via-chrome/usage', {}],
    ['/gemini-web/via-chrome/profile', {}],
    ['/gemini-web/via-chrome/gems', {}],
    ['/gemini-web/via-chrome/saved-info', {}],
    ['/gemini-web/via-chrome/scheduled-tasks', {}],
    ['/gemini-web/via-chrome/extensions', {}],
    ['/gemini-web/via-chrome/notebooks', {}],
    ['/gemini-web/via-chrome/subscription', {}],
    ['/gemini-web/via-chrome/turns/r_1122334455667788', {}],
  ];

  for (const [p, body] of validPaths) {
    const res = (await callRoute('POST', p, body)) as {
      success: boolean;
      data?: { snippet?: string; description?: string; url?: string; method?: string; instructions?: string };
    };
    assert.equal(res.success, true, `Expected success for ${p}`);
    assert.equal(typeof res.data?.snippet, 'string', `Expected snippet string for ${p}`);
    new vm.Script(res.data!.snippet!);
    assert.equal(res.data?.method, 'POST');
  }

  const identify = (await callRoute('POST', '/gemini-web/browser/via-chrome/identify', {})) as {
    success: boolean;
    data?: { snippet: { snippet: string }; profiles: unknown[]; note: string };
  };
  assert.equal(identify.success, true);
  assert.ok(Array.isArray(identify.data?.profiles));
  new vm.Script(identify.data!.snippet.snippet);
});
