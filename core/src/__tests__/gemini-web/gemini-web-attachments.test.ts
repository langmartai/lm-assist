import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  snippetUploadAttachment,
  snippetProcessFile,
  snippetListAttachments,
  snippetDownloadAttachment,
} from '../../utils/gemini-web-via-chrome';
import { createGeminiWebRoutes } from '../../routes/core/gemini-web.routes';

function makeBatchResp(rpcId: string, payload: unknown): string {
  const outer = JSON.stringify([['wrb.fr', rpcId, JSON.stringify(payload), null, null, null, 'generic']]);
  return `)]}'\n\n${outer.length}\n${outer}\n`;
}

const WIZ = {
  SNlM0e: 'AT_TEST_TOKEN',
  cfb2h: 'boq_gemini-web-uiserver_20261123.09_p0',
  FdrFJe: '6231958405027476578',
  eptZe: '/_/BardChatUi/',
};

test('attachment upload, ProcessFile, list attachments, download allowlist, and routes work properly', async () => {
  assert.throws(() => snippetUploadAttachment({ filename: '', contentBase64: 'QQ==' }), /filename is required/);
  assert.throws(() => snippetProcessFile({ blobPath: '/bad/path', filename: 'a.png', mimeType: 'image/png' }), /contrib_service/);
  assert.throws(() => snippetDownloadAttachment('https://evil.example.com/x.png'), /Disallowed attachment host/);
  assert.throws(() => snippetDownloadAttachment('http://lh3.googleusercontent.com/gg/abc'), /Disallowed attachment host/);

  // 1. Upload via file_input fallback in mocked DOM
  const uploadBuilt = snippetUploadAttachment({
    filename: 'note.txt',
    contentBase64: Buffer.from('hello gemini').toString('base64'),
  });
  new vm.Script(uploadBuilt.snippet);

  let previews = 0;
  let assignedFilesLen = 0;
  const fakeFileInput = {
    _files: null as unknown,
    set files(v: { length: number }) {
      this._files = v;
      assignedFilesLen = v.length;
      previews = 1;
    },
    dispatchEvent() { return true; },
  };
  const uploadRes = JSON.parse(
    JSON.stringify(
      await vm.runInContext(
        uploadBuilt.snippet,
        vm.createContext({
          atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
          File: class { constructor(public parts: unknown[], public name: string, public opts: unknown) {} },
          DataTransfer: class {
            itemsList: unknown[] = [];
            items = { add: (f: unknown) => { this.itemsList.push(f); } };
            get files() { return { length: this.itemsList.length, 0: this.itemsList[0] }; }
          },
          Event: class { constructor(public type: string, public opts?: unknown) {} },
          setTimeout: (fn: () => void) => { fn(); return 0; },
          location: { hostname: 'gemini.google.com', href: 'https://gemini.google.com/app' },
          window: { WIZ_global_data: WIZ },
          document: {
            querySelector(sel: string) {
              if (sel === 'input[type="file"]') return fakeFileInput;
              return null;
            },
            querySelectorAll(sel: string) {
              if (sel.includes('file-preview')) return Array.from({ length: previews });
              return [];
            },
          },
        }),
      ),
    ),
  );
  assert.equal(uploadRes.ok, true);
  assert.equal(uploadRes.method, 'file_input');
  assert.equal(uploadRes.mimeType, 'text/plain');
  assert.equal(assignedFilesLen, 1);
  assert.equal(uploadRes.previewCount, 1);

  // 2. ProcessFile RPC
  const pfBuilt = snippetProcessFile({
    blobPath: '/contrib_service/ttl_1d/blob123',
    filename: 'chart.png',
    mimeType: 'image/png',
  });
  const pfRes = JSON.parse(
    JSON.stringify(
      await vm.runInContext(
        pfBuilt.snippet,
        vm.createContext({
          URLSearchParams,
          location: { hostname: 'gemini.google.com', href: 'https://gemini.google.com/app' },
          window: { WIZ_global_data: WIZ },
          fetch: async (url: string) => {
            assert.match(url, /ProcessFile/);
            const outer = JSON.stringify([['wrb.fr', null, JSON.stringify([null, null, 1, ['pf-uuid-42']]), null, null, null, 'generic']]);
            return { ok: true, status: 200, statusText: 'OK', text: async () => `)]}'\n\n${outer.length}\n${outer}\n` };
          },
        }),
      ),
    ),
  );
  assert.equal(pfRes.ok, true);
  assert.equal(pfRes.processedFileUuid, 'pf-uuid-42');

  // 3. List attachments from hNvQHb
  const listBuilt = snippetListAttachments('c_4935b1d94c4d20e6');
  const listRes = JSON.parse(
    JSON.stringify(
      await vm.runInContext(
        listBuilt.snippet,
        vm.createContext({
          URL,
          URLSearchParams,
          location: { hostname: 'gemini.google.com', href: 'https://gemini.google.com/app/4935b1d94c4d20e6' },
          window: { WIZ_global_data: WIZ },
          fetch: async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => makeBatchResp('hNvQHb', [
              [
                ['c_4935b1d94c4d20e6', 'r_1122334455667788'],
                null,
                [['Look at this', ['https://lh3.googleusercontent.com/gg/preview1']]],
                [[['rc_1', ['Here is the file: https://contribution.usercontent.google.com/download?c=abc123']]]],
              ],
            ]),
          }),
        }),
      ),
    ),
  );
  assert.equal(listRes.ok, true);
  assert.equal(listRes.attachments.length, 2);
  assert.equal(listRes.attachments[0].kind, 'image_preview');
  assert.equal(listRes.attachments[1].kind, 'download');

  // 4. Download attachment as base64
  const dlBuilt = snippetDownloadAttachment('https://contribution.usercontent.google.com/download?c=abc123');
  const dlRes = JSON.parse(
    JSON.stringify(
      await vm.runInContext(
        dlBuilt.snippet,
        vm.createContext({
          btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
          location: { hostname: 'gemini.google.com', href: 'https://gemini.google.com/app' },
          fetch: async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({
              'content-type': 'image/png',
              'content-disposition': 'attachment; filename="diagram.png"',
            }),
            arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71]).buffer,
          }),
        }),
      ),
    ),
  );
  assert.equal(dlRes.ok, true);
  assert.equal(dlRes.filename, 'diagram.png');
  assert.equal(dlRes.contentType, 'image/png');
  assert.equal(dlRes.size, 4);
  assert.equal(dlRes.base64, Buffer.from([137, 80, 78, 71]).toString('base64'));

  // 5. Routes check
  const routes = createGeminiWebRoutes({} as never);
  for (const [p, body] of [
    ['/gemini-web/via-chrome/conversations/c_4935b1d94c4d20e6/attachments', {}],
    ['/gemini-web/via-chrome/attachments/upload', { filename: 'a.txt', contentBase64: 'QQ==' }],
    ['/gemini-web/via-chrome/attachments/process-file', { blobPath: '/contrib_service/ttl_1d/x', filename: 'a.png', mimeType: 'image/png' }],
    ['/gemini-web/via-chrome/attachments/download', { url: 'https://lh3.googleusercontent.com/gg/tok' }],
  ] as Array<[string, Record<string, unknown>]>) {
    const r = routes.find((x) => x.method === 'POST' && x.pattern.test(p));
    assert.ok(r, `Missing route for ${p}`);
    const out = (await r!.handler({ method: 'POST', path: p, params: (p.match(r!.pattern)?.groups || {}) as Record<string, string>, query: {}, body } as never, undefined as never)) as { success: boolean; data?: { snippet: string } };
    assert.equal(out.success, true, `Expected success for ${p}`);
    new vm.Script(out.data!.snippet);
  }
});
