import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { snippetHealthCheck } from '../../utils/gemini-web-via-chrome';

function makeBatchExecuteBody(rpcId: string, payload: unknown): string {
  const outer = JSON.stringify([['wrb.fr', rpcId, JSON.stringify(payload), null, null, null, 'generic']]);
  return `)]}'\n\n${outer.length}\n${outer}\n25\n[["e",4,null,null,100]]\n`;
}

async function runSnippet(opts: {
  hostname?: string;
  href?: string;
  wiz?: Record<string, unknown> | null;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; statusText: string; text: () => Promise<string> }>;
}) {
  const { snippet } = snippetHealthCheck();
  const hostname = opts.hostname ?? 'gemini.google.com';
  const href = opts.href ?? `https://${hostname}/app`;
  const context = vm.createContext({
    URLSearchParams,
    location: { hostname, href },
    window: { WIZ_global_data: opts.wiz === undefined ? null : opts.wiz },
    fetch: opts.fetchImpl ?? (async () => { throw new Error('unexpected fetch'); }),
  });
  return JSON.parse(JSON.stringify(await vm.runInContext(snippet, context)));
}

test('snippetHealthCheck detects wrong tab, missing WIZ tokens, signed-out policy, expired session, network error, and signed-in ok state', async () => {
  const wrongTab = await runSnippet({ hostname: 'claude.ai' });
  assert.equal(wrongTab.ok, false);
  assert.equal(wrongTab.reason, 'wrong_tab');

  const noTokens = await runSnippet({ wiz: { cfb2h: 'bl1' } });
  assert.equal(noTokens.ok, false);
  assert.equal(noTokens.reason, 'not_logged_in');

  const wiz = {
    SNlM0e: 'AJs2_TEST_TOKEN_0123456789abcdef',
    cfb2h: 'boq_gemini-web-uiserver_20261121.15_p0',
    FdrFJe: '6231958405027476578',
    eptZe: '/_/BardChatUi/',
    QrtxK: '0',
    oPEP7c: 'user@example.com',
  };

  const signedOutPayload: unknown[] = [];
  signedOutPayload[15] = [['cf41b0e0dd7d53e5', 'Auto', 'Adapts to your needs', []]];
  signedOutPayload[24] = ['neon_launch_signed_out_policy', []];
  const signedOut = await runSnippet({
    wiz,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => makeBatchExecuteBody('otAQ7b', signedOutPayload),
    }),
  });
  assert.equal(signedOut.ok, false);
  assert.equal(signedOut.reason, 'not_logged_in');
  assert.equal(signedOut.policyName, 'neon_launch_signed_out_policy');

  const expired = await runSnippet({
    wiz,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Unauthorized',
    }),
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'session_expired');
  assert.equal(expired.status, 401);

  const netErr = await runSnippet({
    wiz,
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(netErr.ok, false);
  assert.equal(netErr.reason, 'network_error');

  const okPayload: unknown[] = [];
  okPayload[15] = [
    ['8c46e95b1a07cecc', 'Auto', 'Adapts to your needs', [1]],
    ['56fdd199312815e2', '4 Hydrogen', 'Everyday help', [1, 4, 2]],
    ['e6fa609c3fa255c0', '4 Neon', 'Deeper analysis', [1, 4, 2]],
    ['95a4c0abcba24364', '4 Carbon', 'Code & complex work', [1]],
  ];
  okPayload[24] = ['neon_pro_policy', []];

  const healthy = await runSnippet({
    wiz,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => makeBatchExecuteBody('otAQ7b', okPayload),
    }),
  });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.reason, 'ok');
  assert.equal(healthy.policyName, 'neon_pro_policy');
  assert.equal(healthy.modelCount, 4);
  assert.deepEqual(healthy.identity, {
    authUser: '0',
    buildLabel: 'boq_gemini-web-uiserver_20261121.15_p0',
    sessionId: '6231958405027476578',
    hasEmail: true,
  });
});
