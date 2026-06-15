import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrapEnvelope } from '../mcp-server/tools/_passthrough';

// Bug #4: a non-2xx route response without a structured `error.message` (or a
// non-JSON body) surfaced only "<route> returned <status>" — the actual reason
// (the 400 body) was dropped, making fs_list / transfer_send_file failures
// undiagnosable. The error must carry the response body.

function fakeRes(status: number, body: string): { ok: boolean; status: number; text(): Promise<string> } {
  return { ok: status >= 200 && status < 300, status, async text() { return body; } };
}

test('unwrapEnvelope: a non-2xx without a structured error includes the body (bug #4)', async () => {
  await assert.rejects(
    () => unwrapEnvelope(fakeRes(400, 'path is outside the allowed root'), '/storage/list'),
    (e: Error) => /400/.test(e.message) && /outside the allowed root/.test(e.message),
  );
});

test('unwrapEnvelope: prefers a structured error.message when present', async () => {
  await assert.rejects(
    () => unwrapEnvelope(
      fakeRes(400, JSON.stringify({ success: false, error: { message: 'nice typed message' } })),
      '/x',
    ),
    (e: Error) => e.message === 'nice typed message',
  );
});

test('unwrapEnvelope: unwraps data on success', async () => {
  const data = await unwrapEnvelope(fakeRes(200, JSON.stringify({ success: true, data: { a: 1 } })), '/x');
  assert.deepEqual(data, { a: 1 });
});
