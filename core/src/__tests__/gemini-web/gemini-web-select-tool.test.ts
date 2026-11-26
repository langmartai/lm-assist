import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  resolveGeminiToolLabel,
  snippetCreateConversation,
  snippetSelectTool,
  snippetSendMessage,
} from '../../utils/gemini-web-via-chrome';
import { createGeminiWebRoutes } from '../../routes/core/gemini-web.routes';

test('resolveGeminiToolLabel, snippetSelectTool, and tool routes handle aliases, DOM selection, and send passthrough', async () => {
  assert.equal(resolveGeminiToolLabel('image'), 'Create image');
  assert.equal(resolveGeminiToolLabel('picture'), 'Create image');
  assert.equal(resolveGeminiToolLabel('video'), 'Create video');
  assert.equal(resolveGeminiToolLabel('movie'), 'Create video');
  assert.equal(resolveGeminiToolLabel('music'), 'Create music');
  assert.equal(resolveGeminiToolLabel('audio'), 'Create music');
  assert.equal(resolveGeminiToolLabel('canvas'), 'Canvas');
  assert.throws(() => resolveGeminiToolLabel('   '), /non-empty string/);

  const sel = snippetSelectTool('movie');
  new vm.Script(sel.snippet);

  let openedMenu = false;
  let clickedVideo = false;
  const mockDocument = {
    querySelector(selector: string) {
      if (selector.includes('Upload & tools')) {
        return {
          focus() {},
          click() {
            openedMenu = true;
          },
        };
      }
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector.includes('menuitem')) {
        if (!openedMenu) return [];
        return [
          { innerText: 'Create image', click() {} },
          {
            innerText: 'Create video',
            click() {
              clickedVideo = true;
            },
          },
          { innerText: 'Canvas', click() {} },
        ];
      }
      if (selector.includes('Deselect ') && clickedVideo) {
        return [
          {
            innerText: 'Video',
            getAttribute(name: string) {
              return name === 'aria-label' ? 'Deselect Video' : '';
            },
          },
        ];
      }
      return [];
    },
  };

  const vmResult = JSON.parse(
    JSON.stringify(
      await vm.runInContext(
        sel.snippet,
        vm.createContext({
          setTimeout: (fn: () => void) => {
            fn();
            return 0;
          },
          location: {
            hostname: 'gemini.google.com',
            href: 'https://gemini.google.com/app',
          },
          document: mockDocument,
        }),
      ),
    ),
  );

  assert.equal(openedMenu, true);
  assert.equal(clickedVideo, true);
  assert.equal(vmResult.ok, true);
  assert.equal(vmResult.selected, 'Create video');
  assert.deepEqual(vmResult.activeChips, ['Video']);
  assert.deepEqual(vmResult.availableTools, ['Create image', 'Create video', 'Canvas']);

  const created = snippetCreateConversation({ prompt: 'Draw a tiny robot', tool: 'picture' });
  new vm.Script(created.snippet);
  assert.match(created.snippet, /selectGeminiTool/);
  assert.match(created.snippet, /Create image/);

  const sent = snippetSendMessage('Animate a paper plane', { tool: 'video' });
  new vm.Script(sent.snippet);
  assert.match(sent.snippet, /selectGeminiTool/);
  assert.match(sent.snippet, /Create video/);

  const routes = createGeminiWebRoutes({} as never);
  const selectRoute = routes.find((r) => r.method === 'POST' && r.pattern.test('/gemini-web/via-chrome/tools/select'));
  assert.ok(selectRoute, 'POST /gemini-web/via-chrome/tools/select should be registered');

  const missingToolRes = (await selectRoute!.handler(
    { method: 'POST', path: '/gemini-web/via-chrome/tools/select', params: {}, query: {}, body: {} } as never,
    undefined as never,
  )) as { success: boolean; error?: { code: string } };
  assert.equal(missingToolRes.success, false);
  assert.equal(missingToolRes.error?.code, 'MISSING_TOOL');

  const okToolRes = (await selectRoute!.handler(
    {
      method: 'POST',
      path: '/gemini-web/via-chrome/tools/select',
      params: {},
      query: {},
      body: { tool: 'image' },
    } as never,
    undefined as never,
  )) as { success: boolean; data?: { snippet: string } };
  assert.equal(okToolRes.success, true);
  assert.match(okToolRes.data!.snippet, /Create image/);
  new vm.Script(okToolRes.data!.snippet);

  const createRoute = routes.find((r) => r.method === 'POST' && r.pattern.test('/gemini-web/via-chrome/conversations/create'));
  const sendRoute = routes.find((r) => r.method === 'POST' && r.pattern.test('/gemini-web/via-chrome/conversations/send'));
  assert.ok(createRoute && sendRoute);

  const createRes = (await createRoute!.handler(
    {
      method: 'POST',
      path: '/gemini-web/via-chrome/conversations/create',
      params: {},
      query: {},
      body: { prompt: 'A watercolor fox', tool: 'picture' },
    } as never,
    undefined as never,
  )) as { success: boolean; data?: { snippet: string } };
  assert.equal(createRes.success, true);
  assert.match(createRes.data!.snippet, /selectGeminiTool/);
  assert.match(createRes.data!.snippet, /Create image/);

  const sendRes = (await sendRoute!.handler(
    {
      method: 'POST',
      path: '/gemini-web/via-chrome/conversations/send',
      params: {},
      query: {},
      body: { prompt: 'Clouds drifting over mountains', tool: 'movie' },
    } as never,
    undefined as never,
  )) as { success: boolean; data?: { snippet: string } };
  assert.equal(sendRes.success, true);
  assert.match(sendRes.data!.snippet, /selectGeminiTool/);
  assert.match(sendRes.data!.snippet, /Create video/);
});
