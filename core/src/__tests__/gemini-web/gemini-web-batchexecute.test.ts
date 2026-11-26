import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildGeminiBatchExecuteSnippet, validateRpcId } from '../../utils/gemini-web-via-chrome';

test('buildGeminiBatchExecuteSnippet validates inputs, encodes Boq form request, strips XSSI prefix, and unwraps wrb.fr / rpcError', async () => {
  assert.throws(() => validateRpcId(''), /Invalid/);
  assert.throws(() => validateRpcId('bad/id'), /Invalid/);
  assert.throws(() => validateRpcId('tooLongRpcIdentifier123'), /Invalid/);
  assert.throws(
    () => buildGeminiBatchExecuteSnippet({ rpcId: 'otAQ7b', args: 'not-an-array' as unknown as unknown[] }),
    /args must be an array/,
  );

  const built = buildGeminiBatchExecuteSnippet({
    rpcId: 'MyzX6c',
    args: [1, 'x'],
    sourcePath: '/app/abc123',
    hl: 'en',
  });
  assert.equal(built.method, 'POST');
  assert.equal(built.url, 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MyzX6c');

  const captured: Array<{ url: string; init: RequestInit }> = [];
  const wiz = {
    SNlM0e: 'AT_SECRET_TOKEN',
    cfb2h: 'boq_gemini-web-uiserver_20261121.15_p0',
    FdrFJe: '6231958405027476578',
    eptZe: '/_/BardChatUi/',
  };

  const okOuter = JSON.stringify([['wrb.fr', 'MyzX6c', JSON.stringify([false, [[3, true, 540, 0, null, 1]]]), null, null, null, 'generic']]);
  const res = JSON.parse(
    JSON.stringify(
      await vm.runInContext(
        built.snippet,
        vm.createContext({
          URLSearchParams,
          location: { hostname: 'gemini.google.com', href: 'https://gemini.google.com/app' },
          window: { WIZ_global_data: wiz },
          fetch: async (url: string, init: RequestInit) => {
            captured.push({ url, init });
            return {
              ok: true,
              status: 200,
              statusText: 'OK',
              text: async () => `)]}'\n\n${okOuter.length}\n${okOuter}\n25\n[["e",4,null,null,99]]\n`,
            };
          },
        }),
      ),
    ),
  );

  assert.equal(captured.length, 1);
  const reqUrl = new URL(`https://gemini.google.com${captured[0].url}`);
  assert.equal(reqUrl.pathname, '/_/BardChatUi/data/batchexecute');
  assert.equal(reqUrl.searchParams.get('rpcids'), 'MyzX6c');
  assert.equal(reqUrl.searchParams.get('source-path'), '/app/abc123');
  assert.equal(reqUrl.searchParams.get('bl'), wiz.cfb2h);
  assert.equal(reqUrl.searchParams.get('f.sid'), wiz.FdrFJe);
  assert.equal(reqUrl.searchParams.get('rt'), 'c');
  assert.equal(captured[0].init.credentials, 'include');

  const bodyStr = String(captured[0].init.body);
  assert.ok(bodyStr.endsWith('&'), 'Boq batchexecute form body ends with &');
  const form = new URLSearchParams(bodyStr);
  assert.equal(form.get('at'), 'AT_SECRET_TOKEN');
  assert.equal(form.get('f.req'), JSON.stringify([[['MyzX6c', '[1,"x"]', null, 'generic']]]));

  assert.equal(res.ok, true);
  assert.deepEqual(res.body, [false, [[3, true, 540, 0, null, 1]]]);

  const errOuter = JSON.stringify([['wrb.fr', 'MyzX6c', null, null, null, [16], 'generic']]);
  const errRes = JSON.parse(
    JSON.stringify(
      await vm.runInContext(
        built.snippet,
        vm.createContext({
          URLSearchParams,
          location: { hostname: 'gemini.google.com', href: 'https://gemini.google.com/app' },
          window: { WIZ_global_data: wiz },
          fetch: async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => `)]}'\n\n${errOuter.length}\n${errOuter}\n`,
          }),
        }),
      ),
    ),
  );
  assert.equal(errRes.ok, false);
  assert.deepEqual(errRes.rpcError, [16]);
});
