/**
 * `delivered` must come from a RECEIPT, never from a 2xx.
 *
 * Measured 2026-09-09 against a live `--remote-control` bridge session, posting
 * the same event to both ingresses:
 *
 *   POST /v1/sessions/{sid}/events        -> 200 {"events":[{...the event, echoed...}]}
 *   POST /v1/code/sessions/{cse}/events   -> 200 {"attestation_feedback":null,
 *                                                 "results":[{"duplicate":false,
 *                                                  "event_id":"e05644f1-…",
 *                                                  "sequence_num":"496"}]}
 *
 * The first is an ECHO: it validates the event and reflects it back, and for a
 * bridge session it enqueues NOTHING. Five separate drives reported
 * `delivered:true` off that 200 and not one reached the session. The second
 * carries a sequenced receipt — that, and only that, is evidence of delivery.
 *
 * This also fixes why `cloudDrive`'s bridge fallback never fired: it was gated
 * on a non-2xx from an ingress that answers 2xx to everything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deliveryReceipt } from '../terminal/ccr-cloud';

test('deliveryReceipt reads event_id and sequence_num off a client-channel receipt', () => {
  const body = {
    attestation_feedback: null,
    results: [{ duplicate: false, event_id: 'e05644f1-3ffe-4a4c-a99e-f8c0352c8db8', sequence_num: '496' }],
  };
  assert.deepEqual(deliveryReceipt(body), {
    eventId: 'e05644f1-3ffe-4a4c-a99e-f8c0352c8db8',
    sequenceNum: '496',
    duplicate: false,
  });
});

test('deliveryReceipt treats a re-sent event as delivered, flagged duplicate', () => {
  // Primary and fallback reuse ONE event uuid, so a double-send is deduped by
  // the backend instead of double-delivering. A dedupe is still a delivery.
  const r = deliveryReceipt({ results: [{ duplicate: true, event_id: 'abc', sequence_num: '12' }] });
  assert.equal(r?.duplicate, true);
  assert.equal(r?.eventId, 'abc');
});

test('deliveryReceipt returns undefined for the echo body — the bug that lied', () => {
  const echo = {
    events: [{
      message: { content: '[probe]', role: 'user' },
      origin: { kind: 'human' },
      parent_tool_use_id: null,
      session_id: 'session_01U2QDhMqkup81aNDjmfzruR',
      type: 'user',
      uuid: '128ed261-21b9-4237-b310-7486319c9b2d',
    }],
  };
  assert.equal(deliveryReceipt(echo), undefined);
});

test('deliveryReceipt returns undefined for empty, malformed, or non-object bodies', () => {
  assert.equal(deliveryReceipt({ results: [] }), undefined);
  assert.equal(deliveryReceipt({ results: [{ duplicate: false }] }), undefined); // no event_id
  assert.equal(deliveryReceipt({ results: 'nope' }), undefined);
  assert.equal(deliveryReceipt(null), undefined);
  assert.equal(deliveryReceipt('200 OK'), undefined);
});

// ── cloudDrive orchestration ────────────────────────────────────────────────
// Measured on a live lm-assist bridge 2026-09-09, and it corrected an earlier
// version of this fix: the primary answers 200 with a bare ECHO and STILL
// delivers, because the bridge relays by typing into the session's tmux pane.
// An earlier draft treated "no receipt" as failure and fell back — every probe
// then arrived TWICE. A receipt is evidence of delivery; its ABSENCE is not
// evidence of failure. The fallback stays gated on a transport failure.
import { cloudDrive } from '../terminal/ccr-cloud';

type Call = { path: string; body: any };
function recorder(replies: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  return {
    calls,
    post: async (path: string, body: any) => { calls.push({ path, body }); return replies[i++] ?? { status: 500, body: {} }; },
  };
}

const ECHO = { status: 200, body: { events: [{ uuid: 'x', type: 'user' }] } };
const RECEIPT = { status: 200, body: { results: [{ duplicate: false, event_id: 'ev-1', sequence_num: '7' }] } };
const DOWN = { status: 502, body: { error: 'bad gateway' } };

test('cloudDrive posts ONCE when the primary accepts — an echo is not a failure', async () => {
  const r = recorder([ECHO]);
  const out = await cloudDrive({ sid: 'session_ABC', text: 'hi' }, { post: r.post });

  assert.equal(r.calls.length, 1, 'a second post here double-delivers the turn');
  assert.equal(r.calls[0].path, '/v1/sessions/session_ABC/events');
  assert.equal(out.accepted, true);
});

test('cloudDrive reports the receipt when the primary returns one', async () => {
  const r = recorder([RECEIPT]);
  const out = await cloudDrive({ sid: 'session_ABC', text: 'hi' }, { post: r.post });

  assert.equal(r.calls.length, 1);
  assert.equal(out.eventId, 'ev-1');
  assert.equal(out.duplicate, false);
});

test('cloudDrive falls back to the client channel only when the primary transport fails', async () => {
  const r = recorder([DOWN, RECEIPT]);
  const out = await cloudDrive({ sid: 'session_ABC', text: 'hi' }, { post: r.post });

  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1].path, '/v1/code/sessions/cse_ABC/events');
  assert.equal(out.eventId, 'ev-1');
});

test('cloudDrive carries the origin stamp on whichever channel it uses', async () => {
  const a = recorder([ECHO]);
  await cloudDrive({ sid: 'session_ABC', text: 'hi', origin: { kind: 'human' } }, { post: a.post });
  assert.deepEqual(a.calls[0].body.events[0].origin, { kind: 'human' });

  const b = recorder([DOWN, RECEIPT]);
  await cloudDrive({ sid: 'session_ABC', text: 'hi', origin: { kind: 'human' } }, { post: b.post });
  assert.deepEqual(b.calls[1].body.events[0].payload.origin, { kind: 'human' });
});
