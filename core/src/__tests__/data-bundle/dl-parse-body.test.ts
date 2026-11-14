// core/src/__tests__/data-bundle/dl-parse-body.test.ts
// rest-server parseBody must accumulate Buffers and decode ONCE: `body += chunk` decoded
// each chunk separately, so a multi-byte UTF-8 character split across two TCP chunks
// became U+FFFD — a bundle upload's JSON wrapper (and any CJK/emoji body) would corrupt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-pb-home-'));
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-pb-data-'));

import { TierRestServer } from '../../rest-server';

type Parsed = { body: any; rawBody: string };
const parseBody = (req: unknown): Promise<Parsed> =>
  (TierRestServer.prototype as unknown as { parseBody: (r: unknown) => Promise<Parsed> }).parseBody.call(null, req);

function fakeReq(method: string, chunks: Buffer[]): EventEmitter & { method: string } {
  const req = Object.assign(new EventEmitter(), { method });
  setImmediate(() => { for (const c of chunks) req.emit('data', c); req.emit('end'); });
  return req;
}

test('a multi-byte character split across chunks survives', async () => {
  const text = JSON.stringify({ title: '数据备份 — naïve 🚀' });
  const bytes = Buffer.from(text, 'utf8');
  const cut = bytes.indexOf(Buffer.from('据', 'utf8')) + 1; // split INSIDE a 3-byte sequence
  const emojiCut = bytes.indexOf(Buffer.from('🚀', 'utf8')) + 2; // and inside a 4-byte one
  const r = await parseBody(fakeReq('POST', [bytes.subarray(0, cut), bytes.subarray(cut, emojiCut), bytes.subarray(emojiCut)]));
  assert.equal(r.body.title, '数据备份 — naïve 🚀');
  assert.equal(r.rawBody, text, 'rawBody is the exact decoded body (HMAC verification signs it)');
  assert.equal(r.rawBody.includes('�'), false);
});

test('empty body → {}; invalid JSON → {} with rawBody kept; GET has no body', async () => {
  assert.deepEqual(await parseBody(fakeReq('POST', [])), { body: {}, rawBody: '' });
  assert.deepEqual(await parseBody(fakeReq('PUT', [Buffer.from('not json')])), { body: {}, rawBody: 'not json' });
  assert.deepEqual(await parseBody({ method: 'GET' }), { body: {}, rawBody: '' });
});

test('string chunks (setEncoding callers) are still accepted', async () => {
  const req = Object.assign(new EventEmitter(), { method: 'DELETE' });
  setImmediate(() => { req.emit('data', '{"a":'); req.emit('data', '1}'); req.emit('end'); });
  assert.deepEqual((await parseBody(req)).body, { a: 1 });
});
