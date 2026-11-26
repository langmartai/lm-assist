import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { snippetSendMessage } from '../../utils/gemini-web-via-chrome';

function makeBatchResp(rpcId: string, payload: unknown): string {
  const outer = JSON.stringify([['wrb.fr', rpcId, JSON.stringify(payload), null, null, null, 'generic']]);
  return `)]}'\n\n${outer.length}\n${outer}\n`;
}

test('snippetSendMessage validates inputs, toggles overlay, enforces wrong-conversation guard, and drives SPA submit + hNvQHb readback', async () => {
  assert.throws(() => snippetSendMessage('   '), /prompt is required/);
  assert.throws(() => snippetSendMessage('hello', { convId: 'bad' }), /Invalid Gemini conversation ID/);

  const noOverlay = snippetSendMessage('hello', { showOverlay: false });
  assert.ok(!noOverlay.snippet.includes('__lm-assist-via-overlay'));
  new vm.Script(noOverlay.snippet);

  const withOverlay = snippetSendMessage('hello', { convId: 'c_4935b1d94c4d20e6', showOverlay: true });
  assert.ok(withOverlay.snippet.includes('__lm-assist-via-overlay'));
  new vm.Script(withOverlay.snippet);

  const wiz = {
    SNlM0e: 'AT_TEST_TOKEN',
    cfb2h: 'boq_gemini-web-uiserver_20261121.15_p0',
    FdrFJe: '6231958405027476578',
    eptZe: '/_/BardChatUi/',
  };

  // Wrong conversation path guard prevents mutating another chat.
  const wrongConv = await vm.runInContext(
    withOverlay.snippet,
    vm.createContext({
      URLSearchParams,
      location: {
        hostname: 'gemini.google.com',
        pathname: '/app/aaaaaaaaaaaaaaaa',
        href: 'https://gemini.google.com/app/aaaaaaaaaaaaaaaa',
      },
      window: { WIZ_global_data: wiz },
      fetch: async () => { throw new Error('must not fetch on wrong_conversation'); },
    }),
  );
  assert.equal(wrongConv.ok, false);
  assert.equal(wrongConv.error, 'wrong_conversation');
  assert.equal(wrongConv.expectedUrl, 'https://gemini.google.com/app/4935b1d94c4d20e6');

  // Matching conversation SPA drive + hNvQHb readback
  let submitted = false;
  let clickedSend = false;
  const mockLocation = {
    hostname: 'gemini.google.com',
    pathname: '/app',
    href: 'https://gemini.google.com/app',
  };
  const editor = {
    tagName: 'TEXTAREA',
    value: '',
    focus() {},
    dispatchEvent() { return true; },
  };
  const sendBtn = {
    click() {
      clickedSend = true;
      submitted = true;
      mockLocation.pathname = '/app/4935b1d94c4d20e6';
      mockLocation.href = 'https://gemini.google.com/app/4935b1d94c4d20e6';
    },
  };
  const mockDoc = {
    querySelector(sel: string) {
      if (sel === 'textarea') return editor;
      if (sel.includes('send-button') && editor.value === 'Ping Gemini') return sendBtn;
      return null;
    },
    querySelectorAll(sel: string) {
      if (submitted && sel.includes('model-response')) {
        return [{ innerText: 'Hello from Gemini' }];
      }
      return [];
    },
  };

  const sendBuilt = snippetSendMessage('Ping Gemini', { timeoutMs: 8000, showOverlay: false });
  const sent = await vm.runInContext(
    sendBuilt.snippet,
    vm.createContext({
      URLSearchParams,
      Event: class { constructor(public type: string, public opts?: unknown) {} },
      KeyboardEvent: class { constructor(public type: string, public opts?: unknown) {} },
      setTimeout: (fn: () => void) => { fn(); return 0; },
      document: mockDoc,
      location: mockLocation,
      window: { WIZ_global_data: wiz },
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => makeBatchResp('hNvQHb', [
          [
            ['c_4935b1d94c4d20e6', 'r_1122334455667788'],
            null,
            [['Ping Gemini'], null, 'e6fa609c3fa255c0'],
            [[['rc_9988776655443322', ['Hello from Gemini']]]],
          ],
        ]),
      }),
    }),
  );

  assert.equal(clickedSend, true);
  assert.equal(editor.value, 'Ping Gemini');
  assert.equal(sent.ok, true);
  assert.equal(sent.conversationId, 'c_4935b1d94c4d20e6');
  assert.equal(sent.responseId, 'r_1122334455667788');
  assert.equal(sent.text, 'Hello from Gemini');
  assert.equal(sent.timedOut, false);
});
