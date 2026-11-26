import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { snippetCreateConversation } from '../../utils/gemini-web-via-chrome';
import { createGeminiWebRoutes } from '../../routes/core/gemini-web.routes';

test('snippetCreateConversation resets /app/<id> via new-chat-button and routes /conversations/create before /:id', async () => {
  assert.throws(() => snippetCreateConversation({ prompt: '   ' }), /non-empty string/);

  const prep = snippetCreateConversation();
  new vm.Script(prep.snippet);

  const withPrompt = snippetCreateConversation({ prompt: 'Hello fresh chat', model: 'Auto', showOverlay: true });
  new vm.Script(withPrompt.snippet);

  let clickedNewChat = false;
  const mockLocation = {
    hostname: 'gemini.google.com',
    pathname: '/app/4935b1d94c4d20e6',
    href: 'https://gemini.google.com/app/4935b1d94c4d20e6',
  };
  const wiz = {
    SNlM0e: 'AT_TEST_TOKEN',
    cfb2h: 'boq_gemini-web-uiserver_20261123.09_p0',
    FdrFJe: '6231958405027476578',
  };

  const prepRes = JSON.parse(
    JSON.stringify(
      await vm.runInContext(
        prep.snippet,
        vm.createContext({
          setTimeout: (fn: () => void) => { fn(); return 0; },
          location: mockLocation,
          window: { WIZ_global_data: wiz },
          document: {
            querySelector(sel: string) {
              if (sel.includes('new-chat-button')) {
                return {
                  click() {
                    clickedNewChat = true;
                    mockLocation.pathname = '/app';
                    mockLocation.href = 'https://gemini.google.com/app';
                  },
                };
              }
              return null;
            },
          },
        }),
      ),
    ),
  );
  assert.equal(clickedNewChat, true);
  assert.equal(prepRes.ok, true);
  assert.equal(prepRes.ready, true);
  assert.equal(prepRes.url, 'https://gemini.google.com/app');

  const routes = createGeminiWebRoutes({} as never);
  const match = routes.find((r) => r.method === 'POST' && r.pattern.test('/gemini-web/via-chrome/conversations/create'));
  assert.ok(match, 'POST /conversations/create should match');
  assert.equal(
    match!.pattern.source,
    '^\\/gemini-web\\/via-chrome\\/conversations\\/create$',
    'create route must not be swallowed by /conversations/:id',
  );
  const routeRes = (await match!.handler(
    { method: 'POST', path: '/gemini-web/via-chrome/conversations/create', params: {}, query: {}, body: {} } as never,
    undefined as never,
  )) as { success: boolean; data?: { snippet: string } };
  assert.equal(routeRes.success, true);
  new vm.Script(routeRes.data!.snippet);
});
