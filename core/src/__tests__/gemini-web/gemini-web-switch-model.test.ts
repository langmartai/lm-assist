import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { snippetSwitchModel } from '../../utils/gemini-web-via-chrome';
import { createGeminiWebRoutes } from '../../routes/core/gemini-web.routes';

test('snippetSwitchModel resolves model aliases/IDs, clicks mode picker menu items, and wires /models/switch', async () => {
  assert.throws(() => snippetSwitchModel('   '), /model is required/);

  const built = snippetSwitchModel('e6fa609c3fa255c0', { thinkingLevel: 4 });
  new vm.Script(built.snippet);
  assert.match(built.description, /Neon/);
  assert.match(built.description, /Medium/);

  let modeLabel = 'Auto';
  let menuOpen = false;
  let clickedModel = false;
  let clickedThinking = false;

  const modeBtn = {
    get innerText() { return modeLabel; },
    click() { menuOpen = true; },
  };
  const menuItems = [
    { innerText: 'Auto', click() { modeLabel = 'Auto'; } },
    { innerText: '4 Hydrogen', click() { modeLabel = '4 Hydrogen'; } },
    { innerText: 'Neon 4 Neon', click() { clickedModel = true; modeLabel = 'Neon'; } },
    { innerText: 'Medium', click() { clickedThinking = true; } },
  ];

  const res = JSON.parse(
    JSON.stringify(
      await vm.runInContext(
        built.snippet,
        vm.createContext({
          setTimeout: (fn: () => void) => { fn(); return 0; },
          KeyboardEvent: class { constructor(public type: string, public opts?: unknown) {} },
          location: { hostname: 'gemini.google.com', href: 'https://gemini.google.com/app' },
          document: {
            dispatchEvent() { return true; },
            querySelector(sel: string) {
              return sel.includes('bard-mode-menu-button') ? modeBtn : null;
            },
            querySelectorAll() {
              return menuOpen ? menuItems : [];
            },
          },
        }),
      ),
    ),
  );

  assert.equal(res.ok, true);
  assert.equal(res.previousModel, 'Auto');
  assert.equal(res.currentModel, 'Neon');
  assert.equal(res.thinkingLevel, 'Medium');
  assert.equal(clickedModel, true);
  assert.equal(clickedThinking, true);

  const routes = createGeminiWebRoutes({} as never);
  const route = routes.find((r) => r.method === 'POST' && r.pattern.test('/gemini-web/via-chrome/models/switch'));
  assert.ok(route, 'POST /gemini-web/via-chrome/models/switch should be registered');

  const missing = (await route!.handler(
    { method: 'POST', path: '/gemini-web/via-chrome/models/switch', params: {}, query: {}, body: {} } as never,
    undefined as never,
  )) as { success: boolean; error?: { code: string } };
  assert.equal(missing.success, false);
  assert.equal(missing.error?.code, 'MISSING_MODEL');

  const okRes = (await route!.handler(
    {
      method: 'POST',
      path: '/gemini-web/via-chrome/models/switch',
      params: {},
      query: {},
      body: { model: '56fdd199312815e2', thinkingLevel: 'high' },
    } as never,
    undefined as never,
  )) as { success: boolean; data?: { snippet: string } };
  assert.equal(okRes.success, true);
  new vm.Script(okRes.data!.snippet);
});
