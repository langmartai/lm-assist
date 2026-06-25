/**
 * Tests for Components 1 & 2 of the AskUserQuestion spec:
 *  - extractPendingQuestion (pure, ccr-cloud.ts)
 *  - handleSessionRead pendingQuestion passthrough (cloud) and extraction (native)
 *  - handleSessionAnswer (cloud → cloudAnswer; native → tmux digit/text; leader-anchor)
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { extractPendingQuestion, findPendingQuestion } from '../terminal/ccr-cloud';
import type { PendingQuestion } from '../terminal/ccr-cloud';
import {
  handleSessionRead,
  handleSessionAnswer,
} from '../routes/core/mission.routes';
import type {
  SessionOpsDeps,
  SessionAnswerDeps,
  SessionProxyDeps,
  LeaderAnchorDeps,
} from '../routes/core/mission.routes';
import { thisNode } from '../mission/mission-store';

// ---------------------------------------------------------------------------
// Helper: make a native JSONL-style message object
// ---------------------------------------------------------------------------
function makeAssistantMsg(content: unknown[]): { message: { role: string; content: unknown[] } } {
  return { message: { role: 'assistant', content } };
}
function makeUserMsg(content: unknown[]): { message: { role: string; content: unknown[] } } {
  return { message: { role: 'user', content } };
}
function makeToolUse(id: string, name: string, input: unknown) {
  return { type: 'tool_use', id, name, input };
}
function makeToolResult(toolUseId: string) {
  return { type: 'tool_result', tool_use_id: toolUseId, content: 'answered' };
}

const SAMPLE_QUESTIONS: PendingQuestion['questions'] = [
  { header: 'What do you want to do?', options: [{ label: 'Proceed', description: 'Continue' }, { label: 'Abort', description: 'Stop' }] },
];

// ---------------------------------------------------------------------------
// 1. extractPendingQuestion — pure function tests
// ---------------------------------------------------------------------------

test('extractPendingQuestion: empty list → null', () => {
  assert.strictEqual(extractPendingQuestion([]), null);
});

test('extractPendingQuestion: no AskUserQuestion → null', () => {
  const msgs = [makeAssistantMsg([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }])];
  assert.strictEqual(extractPendingQuestion(msgs), null);
});

test('extractPendingQuestion: unanswered AskUserQuestion → returns question with toolUseId', () => {
  const msgs = [
    makeAssistantMsg([makeToolUse('tu-q1', 'AskUserQuestion', { questions: SAMPLE_QUESTIONS })]),
  ];
  const result = extractPendingQuestion(msgs);
  assert.ok(result, 'should return a PendingQuestion');
  assert.strictEqual(result!.toolUseId, 'tu-q1');
  assert.strictEqual(result!.questions.length, 1);
  assert.strictEqual(result!.questions[0].header, 'What do you want to do?');
  assert.strictEqual(result!.questions[0].options?.[0].label, 'Proceed');
});

test('extractPendingQuestion: AskUserQuestion followed by tool_result → null (answered)', () => {
  const msgs = [
    makeAssistantMsg([makeToolUse('tu-q2', 'AskUserQuestion', { questions: SAMPLE_QUESTIONS })]),
    makeUserMsg([makeToolResult('tu-q2')]),
  ];
  assert.strictEqual(extractPendingQuestion(msgs), null);
});

test('extractPendingQuestion: multiple AskUserQuestion calls — last one wins if unanswered', () => {
  const msgs = [
    makeAssistantMsg([makeToolUse('tu-q3', 'AskUserQuestion', { questions: [{ header: 'Q1' }] })]),
    makeUserMsg([makeToolResult('tu-q3')]),
    makeAssistantMsg([makeToolUse('tu-q4', 'AskUserQuestion', { questions: [{ header: 'Q2' }] })]),
  ];
  const result = extractPendingQuestion(msgs);
  assert.ok(result, 'should find the second unanswered question');
  assert.strictEqual(result!.toolUseId, 'tu-q4');
  assert.strictEqual(result!.questions[0].header, 'Q2');
});

test('extractPendingQuestion: mixed content blocks, last AskUserQuestion answered → null', () => {
  const msgs = [
    makeAssistantMsg([
      { type: 'text', text: 'thinking...' },
      makeToolUse('tu-q5', 'AskUserQuestion', { questions: SAMPLE_QUESTIONS }),
    ]),
    makeUserMsg([makeToolResult('tu-q5')]),
  ];
  assert.strictEqual(extractPendingQuestion(msgs), null);
});

test('extractPendingQuestion: missing input.questions → returns empty questions array', () => {
  const msgs = [makeAssistantMsg([makeToolUse('tu-q6', 'AskUserQuestion', {})])];
  const result = extractPendingQuestion(msgs);
  assert.ok(result);
  assert.strictEqual(result!.toolUseId, 'tu-q6');
  assert.deepStrictEqual(result!.questions, []);
});

test('extractPendingQuestion: non-array content → skipped safely', () => {
  const msgs = [
    { message: { content: 'some string content' } } as any,
    makeAssistantMsg([makeToolUse('tu-q7', 'AskUserQuestion', { questions: SAMPLE_QUESTIONS })]),
  ];
  const result = extractPendingQuestion(msgs);
  assert.ok(result);
  assert.strictEqual(result!.toolUseId, 'tu-q7');
});

// ---------------------------------------------------------------------------
// 2. handleSessionRead — pendingQuestion passthrough
// ---------------------------------------------------------------------------

function makeReadDeps(overrides: Partial<SessionOpsDeps> = {}): SessionOpsDeps {
  return {
    cloudRead: async (opts) => ({ sid: opts.sid, messages: [], pendingQuestion: null }),
    cloudDrive: async (opts) => ({ delivered: true, sid: opts.sid }),
    cloudStop: async (sid) => ({ stopped: true, sid }),
    nativeRead: async (_sid) => ({ messages: [] }),
    nativeRawMessages: async (_sid) => ([]),
    nativeDrive: async (_sid, _text) => {},
    nativeInterrupt: async (_sid) => {},
    nativeStop: async (_sid) => {},
    clearController: async () => {},
    getControllerSession: async () => null,
    resolve: (sid) => ({
      sid,
      transport: sid.startsWith('session_') ? 'cloud' : 'native',
      missionId: null,
      role: 'worker' as const,
    }),
    ...overrides,
  };
}

test('handleSessionRead cloud: pendingQuestion from cloudRead is passed through', async () => {
  const q: PendingQuestion = { toolUseId: 'tu-cloud', questions: SAMPLE_QUESTIONS };
  const deps = makeReadDeps({
    cloudRead: async (opts) => ({
      sid: opts.sid,
      messages: [{ role: 'assistant', text: 'hello', type: 'assistant' }],
      pendingQuestion: q,
    }),
  });
  const r = await handleSessionRead('session_cloud_pq', undefined, deps);
  assert.ok(r.success);
  const data = (r as any).data;
  assert.deepStrictEqual(data.pendingQuestion, q);
});

test('handleSessionRead cloud: no pending question → pendingQuestion is null', async () => {
  const deps = makeReadDeps({
    cloudRead: async (opts) => ({ sid: opts.sid, messages: [], pendingQuestion: null }),
  });
  const r = await handleSessionRead('session_cloud_nopq', undefined, deps);
  assert.ok(r.success);
  assert.strictEqual((r as any).data.pendingQuestion, null);
});

test('handleSessionRead native: extracts pendingQuestion from raw messages', async () => {
  const q: PendingQuestion = {
    toolUseId: 'tu-native-1',
    questions: [{ header: 'Choose', options: [{ label: 'Yes' }, { label: 'No' }] }],
  };
  const rawMsgs = [
    makeAssistantMsg([makeToolUse('tu-native-1', 'AskUserQuestion', { questions: q.questions })]),
  ];
  const deps = makeReadDeps({
    nativeRawMessages: async (_sid) => rawMsgs,
    nativeRead: async (_sid) => ({ messages: [{ role: 'assistant', content: 'text' }] }),
  });
  const r = await handleSessionRead('native-uuid-1234', undefined, deps);
  assert.ok(r.success);
  const data = (r as any).data;
  assert.ok(data.pendingQuestion, 'should have pendingQuestion');
  assert.strictEqual(data.pendingQuestion.toolUseId, 'tu-native-1');
  assert.strictEqual(data.pendingQuestion.questions[0].header, 'Choose');
});

test('handleSessionRead native: no pending question → pendingQuestion is null', async () => {
  const deps = makeReadDeps({
    nativeRawMessages: async (_sid) => ([]),
    nativeRead: async (_sid) => ({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  const r = await handleSessionRead('native-uuid-no-pq', undefined, deps);
  assert.ok(r.success);
  assert.strictEqual((r as any).data.pendingQuestion, null);
});

test('handleSessionRead native: answered question → pendingQuestion is null', async () => {
  const rawMsgs = [
    makeAssistantMsg([makeToolUse('tu-native-2', 'AskUserQuestion', { questions: SAMPLE_QUESTIONS })]),
    makeUserMsg([makeToolResult('tu-native-2')]),
  ];
  const deps = makeReadDeps({
    nativeRawMessages: async (_sid) => rawMsgs,
    nativeRead: async (_sid) => ({ messages: [{ role: 'assistant', content: 'done' }] }),
  });
  const r = await handleSessionRead('native-uuid-answered', undefined, deps);
  assert.ok(r.success);
  assert.strictEqual((r as any).data.pendingQuestion, null);
});

test('handleSessionRead native: nativeRawMessages error → pendingQuestion null (non-fatal)', async () => {
  const deps = makeReadDeps({
    nativeRawMessages: async (_sid) => { throw new Error('file not found'); },
    nativeRead: async (_sid) => ({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  const r = await handleSessionRead('native-uuid-error', undefined, deps);
  assert.ok(r.success, 'should still succeed despite raw message error');
  assert.strictEqual((r as any).data.pendingQuestion, null);
});

// ---------------------------------------------------------------------------
// 3. handleSessionAnswer — DI tests
// ---------------------------------------------------------------------------

const STUB_LEADER_IS_SELF: LeaderAnchorDeps = {
  getElection: async () => ({ isMonitor: true, monitorNodeId: thisNode() }),
  proxyGet: async () => ({}),
  proxyPost: async () => ({}),
};

function makeAnswerDeps(overrides: Partial<SessionAnswerDeps> = {}): SessionAnswerDeps {
  return {
    cloudAnswer: async (_opts) => ({ answered: true }),
    nativeSendKeys: async (_tmux, _keys) => {},
    nativeGetPendingQuestion: async (_sid) => null,
    nativeTmuxSession: (_sid) => 'lmcc-test',
    resolve: (sid) => ({
      sid,
      transport: sid.startsWith('session_') ? 'cloud' : 'native',
      missionId: null,
      role: 'worker' as const,
    }),
    ...overrides,
  };
}

test('handleSessionAnswer: missing answer → INVALID_INPUT', async () => {
  const deps = makeAnswerDeps();
  const r = await handleSessionAnswer('session_x', { answer: '' }, deps, undefined, STUB_LEADER_IS_SELF);
  assert.strictEqual(r.success, false);
  assert.strictEqual((r as any).error?.code, 'INVALID_INPUT');
});

test('handleSessionAnswer cloud: calls cloudAnswer with sid + answer + toolUseId', async () => {
  let calledWith: Record<string, unknown> | null = null;
  const deps = makeAnswerDeps({
    cloudAnswer: async (opts) => { calledWith = opts as unknown as Record<string, unknown>; return { answered: true }; },
  });
  const r = await handleSessionAnswer('session_cloud_ans', { answer: 'Proceed', toolUseId: 'tu-cloud-ans' }, deps, undefined, STUB_LEADER_IS_SELF);
  assert.ok(r.success);
  assert.strictEqual((r as any).data?.transport, 'cloud');
  assert.ok(calledWith, 'cloudAnswer should be called');
  assert.strictEqual(calledWith!['sid'], 'session_cloud_ans');
  assert.strictEqual(calledWith!['answer'], 'Proceed');
  assert.strictEqual(calledWith!['toolUseId'], 'tu-cloud-ans');
});

test('handleSessionAnswer native: option label → sends 1-based index digit + Enter', async () => {
  const keySent: string[] = [];
  const tmuxSessions: string[] = [];
  const deps = makeAnswerDeps({
    nativeGetPendingQuestion: async (_sid) => ({
      toolUseId: 'tu-n1',
      questions: [{ header: 'Choose', options: [{ label: 'Proceed' }, { label: 'Abort' }] }],
    }),
    nativeTmuxSession: (_sid) => 'lmcc-native-1',
    nativeSendKeys: async (tmux, keys) => { tmuxSessions.push(tmux); keySent.push(keys); },
  });
  // "Proceed" is option index 0 → sends "1"
  const r = await handleSessionAnswer('native-uuid-opt', { answer: 'Proceed' }, deps, undefined, STUB_LEADER_IS_SELF);
  assert.ok(r.success);
  assert.strictEqual((r as any).data?.transport, 'native');
  assert.strictEqual((r as any).data?.mode, 'option');
  assert.strictEqual((r as any).data?.keys, '1');
  assert.strictEqual(keySent[0], '1');
  assert.strictEqual(tmuxSessions[0], 'lmcc-native-1');
});

test('handleSessionAnswer native: second option label → sends "2"', async () => {
  const keySent: string[] = [];
  const deps = makeAnswerDeps({
    nativeGetPendingQuestion: async (_sid) => ({
      toolUseId: 'tu-n2',
      questions: [{ header: 'Choose', options: [{ label: 'Proceed' }, { label: 'Abort' }] }],
    }),
    nativeTmuxSession: (_sid) => 'lmcc-native-2',
    nativeSendKeys: async (_tmux, keys) => { keySent.push(keys); },
  });
  const r = await handleSessionAnswer('native-uuid-opt2', { answer: 'Abort' }, deps, undefined, STUB_LEADER_IS_SELF);
  assert.ok(r.success);
  assert.strictEqual((r as any).data?.keys, '2');
  assert.strictEqual(keySent[0], '2');
});

test('handleSessionAnswer native: case-insensitive option match', async () => {
  const keySent: string[] = [];
  const deps = makeAnswerDeps({
    nativeGetPendingQuestion: async (_sid) => ({
      toolUseId: 'tu-n3',
      questions: [{ header: 'Choose', options: [{ label: 'Proceed' }, { label: 'Abort' }] }],
    }),
    nativeTmuxSession: (_sid) => 'lmcc-native-3',
    nativeSendKeys: async (_tmux, keys) => { keySent.push(keys); },
  });
  // lowercase "proceed" should match "Proceed"
  const r = await handleSessionAnswer('native-uuid-case', { answer: 'proceed' }, deps, undefined, STUB_LEADER_IS_SELF);
  assert.ok(r.success);
  assert.strictEqual((r as any).data?.mode, 'option');
  assert.strictEqual(keySent[0], '1');
});

test('handleSessionAnswer native: free text (no option match) → sends text directly', async () => {
  const keySent: string[] = [];
  const deps = makeAnswerDeps({
    nativeGetPendingQuestion: async (_sid) => ({
      toolUseId: 'tu-n4',
      questions: [{ header: 'Enter name' }], // no options
    }),
    nativeTmuxSession: (_sid) => 'lmcc-native-4',
    nativeSendKeys: async (_tmux, keys) => { keySent.push(keys); },
  });
  const r = await handleSessionAnswer('native-uuid-free', { answer: 'my custom answer' }, deps, undefined, STUB_LEADER_IS_SELF);
  assert.ok(r.success);
  assert.strictEqual((r as any).data?.mode, 'input');
  assert.strictEqual(keySent[0], 'my custom answer');
});

test('handleSessionAnswer native: no pending question → sends answer as free text fallback', async () => {
  const keySent: string[] = [];
  const deps = makeAnswerDeps({
    nativeGetPendingQuestion: async (_sid) => null,
    nativeTmuxSession: (_sid) => 'lmcc-native-5',
    nativeSendKeys: async (_tmux, keys) => { keySent.push(keys); },
  });
  const r = await handleSessionAnswer('native-uuid-none', { answer: 'yes' }, deps, undefined, STUB_LEADER_IS_SELF);
  assert.ok(r.success);
  assert.strictEqual((r as any).data?.mode, 'input');
  assert.strictEqual(keySent[0], 'yes');
});

test('handleSessionAnswer: sendKeys failure → ANSWER_ERROR', async () => {
  const deps = makeAnswerDeps({
    nativeSendKeys: async (_tmux, _keys) => { throw new Error('tmux not found'); },
    nativeTmuxSession: (_sid) => 'lmcc-fail',
  });
  const r = await handleSessionAnswer('native-uuid-fail', { answer: 'yes' }, deps, undefined, STUB_LEADER_IS_SELF);
  assert.strictEqual(r.success, false);
  assert.strictEqual((r as any).error?.code, 'ANSWER_ERROR');
});

// ---------------------------------------------------------------------------
// 4. Leader-anchor proxy tests
// ---------------------------------------------------------------------------

test('handleSessionAnswer: leader-anchor proxies to leader when not monitor', async () => {
  let proxiedPath: string | undefined;
  const leader: LeaderAnchorDeps = {
    getElection: async () => ({ isMonitor: false, monitorNodeId: 'gw-leader' }),
    proxyGet: async () => ({}),
    proxyPost: async (_node, path, _body) => {
      proxiedPath = path;
      return { success: true, data: { answered: true, transport: 'cloud' } };
    },
  };
  const deps = makeAnswerDeps();
  const r = await handleSessionAnswer('session_leader_proxy', { answer: 'Proceed' }, deps, undefined, leader);
  assert.ok(r.success);
  assert.ok(proxiedPath, 'should have proxied to leader');
  assert.ok(proxiedPath!.includes('/answer'), 'proxy path should include /answer');
});

test('handleSessionAnswer: is monitor → executes locally (no proxy)', async () => {
  let localCalled = false;
  const leader: LeaderAnchorDeps = {
    getElection: async () => ({ isMonitor: true, monitorNodeId: thisNode() }),
    proxyGet: async () => ({}),
    proxyPost: async () => { throw new Error('should not proxy'); },
  };
  const deps = makeAnswerDeps({
    cloudAnswer: async (_opts) => { localCalled = true; return { answered: true }; },
  });
  const r = await handleSessionAnswer('session_self_leader', { answer: 'yes' }, deps, undefined, leader);
  assert.ok(r.success, 'should succeed locally');
  assert.ok(localCalled, 'cloudAnswer should be called locally');
});

// ---------------------------------------------------------------------------
// 5. Cross-node proxy via `node` param
// ---------------------------------------------------------------------------

function makeProxyDeps(
  onPost: (node: string, urlPath: string, body: unknown) => Promise<unknown>,
): SessionProxyDeps {
  return { proxyPost: onPost };
}

test('handleSessionAnswer: node !== self → proxies via proxyPost', async () => {
  let proxyNode: string | undefined;
  let proxyPath: string | undefined;
  const pd = makeProxyDeps(async (node, urlPath) => {
    proxyNode = node; proxyPath = urlPath;
    return { success: true, data: { answered: true, transport: 'native' } };
  });
  const deps = makeAnswerDeps();
  const r = await handleSessionAnswer('native-uuid-proxy', { answer: 'yes' }, deps, 'gw-other', STUB_LEADER_IS_SELF, pd);
  assert.ok(r.success);
  assert.strictEqual(proxyNode, 'gw-other');
  assert.ok(proxyPath?.includes('/answer'));
});

test('handleSessionAnswer: node === self → executes locally', async () => {
  let proxyCalled = false;
  const pd = makeProxyDeps(async () => { proxyCalled = true; return {}; });
  const deps = makeAnswerDeps({
    cloudAnswer: async () => ({ answered: true }),
  });
  const r = await handleSessionAnswer('session_local_ans', { answer: 'go' }, deps, thisNode(), STUB_LEADER_IS_SELF, pd);
  assert.ok(r.success);
  assert.strictEqual(proxyCalled, false, 'should not proxy when node === self');
});
