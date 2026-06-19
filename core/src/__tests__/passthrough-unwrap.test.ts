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

// The transport + port-forward routes return `error` as a plain STRING
// (e.g. { success:false, error:'peerGatewayId, localPath, remotePath required' }),
// not { error:{ message } }. The old unwrap only read error.message, so these
// surfaced as the opaque "<route> returned 400: {raw json}" instead of the
// clean sentence — affecting transfer_* and *_port_forward tools.
test('unwrapEnvelope: surfaces a string-form error verbatim (not the opaque fallback)', async () => {
  await assert.rejects(
    () => unwrapEnvelope(
      fakeRes(400, JSON.stringify({ success: false, error: 'peerGatewayId, localPath, remotePath required' })),
      '/transport/send-file',
    ),
    (e: Error) => e.message === 'peerGatewayId, localPath, remotePath required',
  );
});

// The claude.ai routes attach an actionable `error.hint` (e.g. how to create the
// session file). The old unwrap dropped it, so the remediation never reached the
// LLM caller. The hint must ride along with the message.
test('unwrapEnvelope: appends error.hint when present', async () => {
  await assert.rejects(
    () => unwrapEnvelope(
      fakeRes(401, JSON.stringify({
        success: false,
        error: { message: 'No claude.ai session configured', hint: 'create ~/.claude/claudeai-session.json' },
      })),
      '/claude-ai/conversations/x/completion',
    ),
    (e: Error) =>
      /No claude\.ai session configured/.test(e.message) &&
      /create ~\/\.claude\/claudeai-session\.json/.test(e.message),
  );
});
