import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  normalizeConvId,
  bareConvId,
  normalizeRespId,
  snippetListConversations,
  snippetReadConversation,
  snippetRenameConversation,
  snippetDeleteConversation,
} from '../../utils/gemini-web-via-chrome';

function makeBatchResp(rpcId: string, payload: unknown): string {
  const outer = JSON.stringify([['wrb.fr', rpcId, JSON.stringify(payload), null, null, null, 'generic']]);
  return `)]}'\n\n${outer.length}\n${outer}\n`;
}

const WIZ = {
  SNlM0e: 'AT_TEST_TOKEN',
  cfb2h: 'boq_gemini-web-uiserver_20261121.15_p0',
  FdrFJe: '6231958405027476578',
  eptZe: '/_/BardChatUi/',
};

test('conversation ID helpers and MaZiqc / hNvQHb / MUAZcd / GzXR5e snippets work end-to-end', async () => {
  assert.equal(normalizeConvId('4935b1d94c4d20e6'), 'c_4935b1d94c4d20e6');
  assert.equal(normalizeConvId('c_4935B1D94C4D20E6'), 'c_4935b1d94c4d20e6');
  assert.equal(bareConvId('c_4935b1d94c4d20e6'), '4935b1d94c4d20e6');
  assert.equal(normalizeRespId('aa11bb22cc33dd44'), 'r_aa11bb22cc33dd44');
  assert.throws(() => normalizeConvId('not-hex!'), /Invalid Gemini conversation ID/);
  assert.throws(() => normalizeRespId('bad'), /Invalid Gemini response ID/);

  const listBuilt = snippetListConversations({ limit: 15, cursor: 'cur_prev' });
  const listRes = JSON.parse(
    JSON.stringify(
      await vm.runInContext(
        listBuilt.snippet,
        vm.createContext({
          URLSearchParams,
          location: { hostname: 'gemini.google.com', href: 'https://gemini.google.com/app' },
          window: { WIZ_global_data: WIZ },
          fetch: async (_url: string, init: RequestInit) => {
            const freq = JSON.parse(new URLSearchParams(String(init.body)).get('f.req') || '[]');
            const args = JSON.parse(freq[0][0][1]);
            assert.equal(args[0], 15);
            assert.equal(args[1], 'cur_prev');
            return {
              ok: true,
              status: 200,
              statusText: 'OK',
              text: async () => makeBatchResp('MaZiqc', [null, 'cur_next', [['c_4935b1d94c4d20e6', 'Protocol Research']]]),
            };
          },
        }),
      ),
    ),
  );
  assert.equal(listRes.ok, true);
  assert.equal(listRes.nextCursor, 'cur_next');
  assert.deepEqual(listRes.conversations, [
    { id: 'c_4935b1d94c4d20e6', bareId: '4935b1d94c4d20e6', title: 'Protocol Research' },
  ]);

  const readBuilt = snippetReadConversation('4935b1d94c4d20e6', { maxTurns: 5 });
  const sampleTurns = [
    [
      ['c_4935b1d94c4d20e6', 'r_1122334455667788'],
      null,
      [['Hello Gemini'], null, 'e6fa609c3fa255c0'],
      [[['rc_9988776655443322', ['Hi there!']]]],
    ],
  ];
  const readRes = JSON.parse(
    JSON.stringify(
      await vm.runInContext(
        readBuilt.snippet,
        vm.createContext({
          URLSearchParams,
          location: { hostname: 'gemini.google.com', href: 'https://gemini.google.com/app/4935b1d94c4d20e6' },
          window: { WIZ_global_data: WIZ },
          fetch: async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => makeBatchResp('hNvQHb', sampleTurns),
          }),
        }),
      ),
    ),
  );
  assert.equal(readRes.ok, true);
  assert.equal(readRes.conversationId, 'c_4935b1d94c4d20e6');
  assert.deepEqual(readRes.turns, [
    {
      conversationId: 'c_4935b1d94c4d20e6',
      responseId: 'r_1122334455667788',
      prompt: 'Hello Gemini',
      candidateId: 'rc_9988776655443322',
      text: 'Hi there!',
    },
  ]);

  const renameBuilt = snippetRenameConversation('4935b1d94c4d20e6', 'Renamed Chat');
  assert.match(renameBuilt.instructions, /WRITE/);
  const renameRes = JSON.parse(
    JSON.stringify(
      await vm.runInContext(
        renameBuilt.snippet,
        vm.createContext({
          URLSearchParams,
          location: { hostname: 'gemini.google.com', href: 'https://gemini.google.com/app/4935b1d94c4d20e6' },
          window: { WIZ_global_data: WIZ },
          fetch: async (_url: string, init: RequestInit) => {
            const freq = JSON.parse(new URLSearchParams(String(init.body)).get('f.req') || '[]');
            assert.equal(freq[0][0][0], 'MUAZcd');
            assert.deepEqual(JSON.parse(freq[0][0][1]), [null, [['title']], ['c_4935b1d94c4d20e6', 'Renamed Chat']]);
            return { ok: true, status: 200, statusText: 'OK', text: async () => makeBatchResp('MUAZcd', []) };
          },
        }),
      ),
    ),
  );
  assert.equal(renameRes.ok, true);

  const deleteBuilt = snippetDeleteConversation('c_4935b1d94c4d20e6');
  assert.match(deleteBuilt.instructions, /DESTRUCTIVE/);
  const deleteRes = JSON.parse(
    JSON.stringify(
      await vm.runInContext(
        deleteBuilt.snippet,
        vm.createContext({
          URLSearchParams,
          location: { hostname: 'gemini.google.com', href: 'https://gemini.google.com/app' },
          window: { WIZ_global_data: WIZ },
          fetch: async (_url: string, init: RequestInit) => {
            const freq = JSON.parse(new URLSearchParams(String(init.body)).get('f.req') || '[]');
            assert.equal(freq[0][0][0], 'GzXR5e');
            assert.deepEqual(JSON.parse(freq[0][0][1]), ['c_4935b1d94c4d20e6']);
            return { ok: true, status: 200, statusText: 'OK', text: async () => makeBatchResp('GzXR5e', []) };
          },
        }),
      ),
    ),
  );
  assert.equal(deleteRes.ok, true);
});
