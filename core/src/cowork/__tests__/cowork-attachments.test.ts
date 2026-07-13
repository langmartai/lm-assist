import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as claudeaiSession from '../../utils/claudeai-session';
import { buildAttachmentEnvelope, uploadCoworkAttachment } from '../cowork-attachments';
import { CoworkTaskError } from '../cowork-tasks';

afterEach(() => { mock.restoreAll(); });

// ── buildAttachmentEnvelope (pure) ───────────────────────────────────────────

test('buildAttachmentEnvelope: no attachments returns the prompt unchanged', () => {
  const r = buildAttachmentEnvelope('hello', undefined);
  assert.equal(r.content, 'hello');
  assert.deepEqual(r.fileAttachments, []);
  assert.deepEqual(buildAttachmentEnvelope('hi', []).fileAttachments, []);
});

test('buildAttachmentEnvelope: one attachment prefixes <uploaded_files> and builds file_attachments', () => {
  const r = buildAttachmentEnvelope('summarize this', [{ file_uuid: 'u1', file_name: 'doc.txt', is_image: false }]);
  assert.match(r.content, /^<uploaded_files>\n<file><file_path>doc\.txt<\/file_path><file_uuid>u1<\/file_uuid><\/file>\n<\/uploaded_files>\n\nsummarize this$/);
  assert.deepEqual(r.fileAttachments, [{ file_name: 'doc.txt', file_uuid: 'u1', is_image: false }]);
});

test('buildAttachmentEnvelope: multiple attachments each get a <file> line', () => {
  const r = buildAttachmentEnvelope('go', [
    { file_uuid: 'u1', file_name: 'a.txt' },
    { file_uuid: 'u2', file_name: 'b.png', is_image: true },
  ]);
  assert.match(r.content, /<file><file_path>a\.txt<\/file_path><file_uuid>u1<\/file_uuid><\/file>/);
  assert.match(r.content, /<file><file_path>b\.png<\/file_path><file_uuid>u2<\/file_uuid><\/file>/);
  assert.equal(r.fileAttachments.length, 2);
  assert.equal(r.fileAttachments[1].is_image, true);
});

test('buildAttachmentEnvelope: drops entries missing file_uuid or file_name', () => {
  const r = buildAttachmentEnvelope('x', [
    { file_uuid: '', file_name: 'no-uuid.txt' } as any,
    { file_uuid: 'u2' } as any,
    { file_uuid: 'u3', file_name: 'ok.txt' },
  ]);
  assert.equal(r.fileAttachments.length, 1);
  assert.equal(r.fileAttachments[0].file_uuid, 'u3');
});

// ── uploadCoworkAttachment (mocked boundary) ─────────────────────────────────

function stubSession(cfg: any, org: string) {
  mock.method(claudeaiSession, 'readClaudeAISession', () => cfg);
  mock.method(claudeaiSession, 'deriveIdentity', () => ({ orgUuid: org }) as any);
}

test('uploadCoworkAttachment: happy path returns the server-sanitized ref', async () => {
  stubSession({ cookie: 'sessionKey=sk-ant-sid-x' }, 'org-abc');
  let calledPath = '';
  mock.method(claudeaiSession, 'claudeaiUploadMultipart', async (pathname: string) => {
    calledPath = pathname;
    return { status: 200, statusText: 'OK', headers: {}, body: { success: true, file_uuid: 'uuid-123', file_name: 'myfile.txt', size_bytes: 58 } };
  });
  const ref = await uploadCoworkAttachment(Buffer.from('data'), 'my-file.txt', 'text/plain');
  assert.equal(calledPath, '/api/organizations/org-abc/cowork/attachments');
  assert.deepEqual(ref, { file_uuid: 'uuid-123', file_name: 'myfile.txt', is_image: false, size_bytes: 58 });
});

test('uploadCoworkAttachment: image mime sets is_image', async () => {
  stubSession({ cookie: 'c' }, 'org-abc');
  mock.method(claudeaiSession, 'claudeaiUploadMultipart', async () => ({ status: 200, statusText: 'OK', headers: {}, body: { file_uuid: 'u', file_name: 'p.png' } }));
  const ref = await uploadCoworkAttachment(Buffer.from('x'), 'p.png', 'image/png');
  assert.equal(ref.is_image, true);
});

test('uploadCoworkAttachment: no cookie session -> COWORK_NO_COOKIE 400', async () => {
  mock.method(claudeaiSession, 'readClaudeAISession', () => null);
  await assert.rejects(uploadCoworkAttachment(Buffer.from('x'), 'f.txt'), (e: unknown) => {
    assert.ok(e instanceof CoworkTaskError);
    assert.equal(e.code, 'COWORK_NO_COOKIE');
    assert.equal(e.httpStatus, 400);
    return true;
  });
});

test('uploadCoworkAttachment: 403 surfaces a Cloudflare hint (502)', async () => {
  stubSession({ cookie: 'c' }, 'org-abc');
  mock.method(claudeaiSession, 'claudeaiUploadMultipart', async () => ({ status: 403, statusText: 'Forbidden', headers: {}, body: '<html>Just a moment...</html>' }));
  await assert.rejects(uploadCoworkAttachment(Buffer.from('x'), 'f.txt'), (e: unknown) => {
    assert.ok(e instanceof CoworkTaskError);
    assert.equal(e.code, 'COWORK_ATTACH_FAILED');
    assert.equal(e.httpStatus, 502);
    assert.match(e.message, /Cloudflare/);
    return true;
  });
});

test('uploadCoworkAttachment: response missing file_uuid -> COWORK_ATTACH_FAILED', async () => {
  stubSession({ cookie: 'c' }, 'org-abc');
  mock.method(claudeaiSession, 'claudeaiUploadMultipart', async () => ({ status: 200, statusText: 'OK', headers: {}, body: { success: true } }));
  await assert.rejects(uploadCoworkAttachment(Buffer.from('x'), 'f.txt'), (e: unknown) => {
    assert.ok(e instanceof CoworkTaskError);
    assert.equal(e.code, 'COWORK_ATTACH_FAILED');
    return true;
  });
});
