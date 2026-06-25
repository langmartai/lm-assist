import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorkerEventStream,
  findPendingControlRequest,
  buildAnswersMap,
  buildControlResponse,
  extractBridgeCse,
  chooseAnswerTransport,
} from '../terminal/ccr-cloud';

// SSE bodies modeled on real lm-proxy captures of /v1/code/sessions/{cse}/worker/events/stream.
const SSE_INITIALIZE = `:keepalive

event: client_event
id: 1
data: {"event_id":"2ea6038e","sequence_num":"1","event_type":"control_request","source":"client","payload":{"request":{"subtype":"initialize"},"request_id":"66203700","type":"control_request","uuid":"2ea6038e"},"created_at":"2026-06-24T23:25:28Z"}

:keepalive

:keepalive
`;

const AUQ_PAYLOAD = {
  type: 'control_request',
  request_id: '130ea349-b22f-41e4-806d-b2e9cdd360f5',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    display_name: 'AskUserQuestion',
    input: { questions: [{ question: 'Pick a test color', header: 'E2E', multiSelect: false, options: [{ label: 'Red', description: 'pick red' }, { label: 'Blue', description: 'pick blue' }] }] },
    tool_use_id: 'toolu_012HDPWzeAYiUvr4hFfNbFb2',
    description: 'asks a question',
  },
  session_id: 'cse_01ATG',
  uuid: 'c6849041',
};

function sseEvent(seq: number, source: string, payload: unknown): string {
  return `event: worker_event\nid: ${seq}\ndata: ${JSON.stringify({ event_id: `e${seq}`, sequence_num: String(seq), event_type: (payload as any).type, source, payload, created_at: '2026-06-25T05:08:25Z' })}\n\n`;
}

// ── parseWorkerEventStream ───────────────────────────────────────────────────

test('parseWorkerEventStream: parses data events and skips :keepalive', () => {
  const events = parseWorkerEventStream(SSE_INITIALIZE);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'control_request');
  assert.equal(events[0].source, 'client');
  assert.equal(events[0].sequenceNum, 1);
  assert.equal(events[0].payload.request.subtype, 'initialize');
});

test('parseWorkerEventStream: empty / keepalive-only body → []', () => {
  assert.deepEqual(parseWorkerEventStream(''), []);
  assert.deepEqual(parseWorkerEventStream(':keepalive\n\n:keepalive\n\n'), []);
});

test('parseWorkerEventStream: tolerates a data: line split is parsed from full blocks', () => {
  const raw = sseEvent(7, 'worker', AUQ_PAYLOAD);
  const events = parseWorkerEventStream(raw);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.request.tool_name, 'AskUserQuestion');
});

// ── findPendingControlRequest ────────────────────────────────────────────────

test('findPendingControlRequest: returns the unanswered AskUserQuestion with its request_id + tool_use_id', () => {
  const events = parseWorkerEventStream(sseEvent(5, 'worker', AUQ_PAYLOAD));
  const p = findPendingControlRequest(events);
  assert.ok(p);
  assert.equal(p!.requestId, '130ea349-b22f-41e4-806d-b2e9cdd360f5');
  assert.equal(p!.toolUseId, 'toolu_012HDPWzeAYiUvr4hFfNbFb2');
  assert.equal(p!.questions[0].options?.[0].label, 'Red');
});

test('findPendingControlRequest: null once a matching control_response (by request_id) arrived', () => {
  const answer = {
    type: 'control_response',
    response: { subtype: 'success', request_id: '130ea349-b22f-41e4-806d-b2e9cdd360f5', response: { behavior: 'allow' } },
    session_id: 'cse_01ATG',
    uuid: 'u2',
  };
  const events = parseWorkerEventStream(sseEvent(5, 'worker', AUQ_PAYLOAD) + sseEvent(6, 'client', answer));
  assert.equal(findPendingControlRequest(events), null);
});

test('findPendingControlRequest: null once a control_cancel_request names the request_id', () => {
  const cancel = { type: 'control_cancel_request', request_id: '130ea349-b22f-41e4-806d-b2e9cdd360f5', session_id: 'cse_01ATG', uuid: 'u3' };
  const events = parseWorkerEventStream(sseEvent(5, 'worker', AUQ_PAYLOAD) + sseEvent(7, 'client', cancel));
  assert.equal(findPendingControlRequest(events), null);
});

test('findPendingControlRequest: ignores non-AskUserQuestion control_requests (e.g. initialize)', () => {
  const events = parseWorkerEventStream(SSE_INITIALIZE);
  assert.equal(findPendingControlRequest(events), null);
});

test('findPendingControlRequest: returns the LATEST unanswered question', () => {
  const second = { ...AUQ_PAYLOAD, request_id: 'req-2', request: { ...AUQ_PAYLOAD.request, tool_use_id: 'toolu_2', input: { questions: [{ question: 'Second?', options: [{ label: 'Yes' }] }] } } };
  const events = parseWorkerEventStream(sseEvent(5, 'worker', AUQ_PAYLOAD) + sseEvent(9, 'worker', second));
  const p = findPendingControlRequest(events);
  assert.equal(p!.requestId, 'req-2');
  assert.equal(p!.toolUseId, 'toolu_2');
});

// ── buildAnswersMap ──────────────────────────────────────────────────────────

test('buildAnswersMap: option label → { questionText: label }', () => {
  const m = buildAnswersMap(AUQ_PAYLOAD.request.input.questions, 'Red');
  assert.deepEqual(m, { 'Pick a test color': 'Red' });
});

test('buildAnswersMap: case-insensitive label match resolves to the canonical label', () => {
  const m = buildAnswersMap(AUQ_PAYLOAD.request.input.questions, 'blue');
  assert.deepEqual(m, { 'Pick a test color': 'Blue' });
});

test('buildAnswersMap: free text (no matching option) is passed through verbatim', () => {
  const m = buildAnswersMap(AUQ_PAYLOAD.request.input.questions, 'Green please');
  assert.deepEqual(m, { 'Pick a test color': 'Green please' });
});

// ── buildControlResponse ─────────────────────────────────────────────────────

// ── extractBridgeCse ─────────────────────────────────────────────────────────

test('extractBridgeCse: returns the bridgeSessionId from a bridge-session line', () => {
  const lines = [
    { type: 'summary' },
    { type: 'bridge-session', bridgeSessionId: 'cse_01ATGgdDaC2es4vnFkpX6z27' },
    { type: 'user', message: { content: 'hi' } },
  ];
  assert.equal(extractBridgeCse(lines), 'cse_01ATGgdDaC2es4vnFkpX6z27');
});

test('extractBridgeCse: returns the LATEST bridge-session id (reconnects)', () => {
  const lines = [
    { type: 'bridge-session', bridgeSessionId: 'cse_old' },
    { type: 'bridge-session', bridgeSessionId: 'cse_new123' },
  ];
  assert.equal(extractBridgeCse(lines), 'cse_new123');
});

test('extractBridgeCse: null when no bridge-session line (pure-local session)', () => {
  assert.equal(extractBridgeCse([{ type: 'user' }, { type: 'assistant' }]), null);
  assert.equal(extractBridgeCse([]), null);
});

test('extractBridgeCse: ignores a malformed bridgeSessionId', () => {
  assert.equal(extractBridgeCse([{ type: 'bridge-session', bridgeSessionId: 'session_xxx' }]), null);
});

test('buildControlResponse: builds the success/allow payload echoing request_id + answers', () => {
  const p = buildControlResponse({ sessionId: 'cse_01ATG', requestId: '130ea349', questions: AUQ_PAYLOAD.request.input.questions, answer: 'Red', uuid: 'fixed-uuid' });
  assert.equal(p.type, 'control_response');
  assert.equal(p.response.subtype, 'success');
  assert.equal(p.response.request_id, '130ea349');
  assert.equal(p.response.response.behavior, 'allow');
  assert.deepEqual(p.response.response.updatedInput.answers, { 'Pick a test color': 'Red' });
  assert.deepEqual(p.response.response.updatedInput.annotations, {});
  assert.deepEqual(p.response.response.updatedPermissions, []);
  assert.equal(p.session_id, 'cse_01ATG');
  assert.equal(p.uuid, 'fixed-uuid');
  // questions are echoed back in updatedInput
  assert.equal(p.response.response.updatedInput.questions[0].question, 'Pick a test color');
});

// ── chooseAnswerTransport ────────────────────────────────────────────────────
// The root-cause fix: a cloud BYOC worker's AskUserQuestion appears BOTH as a client
// control_request AND as a teleport tool_use. It must be answered via the client
// control_response path; the old logic keyed off teleport first and the answer never landed.

test('chooseAnswerTransport: client control_request wins even when teleport also has the tool_use (the bug)', () => {
  assert.equal(chooseAnswerTransport({ hasClientControlRequest: true, hasTeleportToolUse: true }), 'client');
});

test('chooseAnswerTransport: client control_request alone → client (bridge / cse_ session)', () => {
  assert.equal(chooseAnswerTransport({ hasClientControlRequest: true, hasTeleportToolUse: false }), 'client');
});

test('chooseAnswerTransport: an explicit requestId forces the client path', () => {
  assert.equal(chooseAnswerTransport({ hasClientControlRequest: false, explicitRequestId: true, hasTeleportToolUse: true }), 'client');
});

test('chooseAnswerTransport: teleport tool_use only (no client control_request) → cloud drive fallback', () => {
  assert.equal(chooseAnswerTransport({ hasClientControlRequest: false, hasTeleportToolUse: true }), 'cloud');
});

test('chooseAnswerTransport: nothing pending → none', () => {
  assert.equal(chooseAnswerTransport({ hasClientControlRequest: false, hasTeleportToolUse: false }), 'none');
});
