import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cloudSessionWebUrl,
  isCloudSid,
  buildCreateBody,
  buildDriveEvent,
  parseTeleportTranscript,
  parseGitHubRepo,
  buildGitHubSource,
  buildSetupPreamble,
  buildBootstrapInstruction,
  findPendingQuestion,
  formatAnswerContent,
  buildAnswerEvent,
} from '../terminal/ccr-cloud';

test('findPendingQuestion: returns the unanswered AskUserQuestion tool_use', () => {
  const events = [{ payload: { message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'toolu_1', input: { questions: [{ header: 'Q', options: [{ label: 'A' }] }] } }] } } }];
  const p = findPendingQuestion(events);
  assert.equal(p?.toolUseId, 'toolu_1');
  assert.equal(p?.questions[0].options?.[0].label, 'A');
});

test('findPendingQuestion: null once a matching tool_result arrived', () => {
  const events = [
    { payload: { message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'toolu_1', input: { questions: [] } }] } } },
    { payload: { message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'answered' }] } } },
  ];
  assert.equal(findPendingQuestion(events), null);
});

test('findPendingQuestion: ignores non-AskUserQuestion tool_use; tolerates junk', () => {
  assert.equal(findPendingQuestion([]), null);
  assert.equal(findPendingQuestion([{ payload: { message: { content: [{ type: 'tool_use', name: 'Bash', id: 'x' }] } } }]), null);
});

test('formatAnswerContent: matched option label → explicit label + description (a click)', () => {
  const qs = [{ header: 'Lockfile', options: [{ label: 'Branch', description: 'make a branch' }, { label: 'Main', description: 'push to main' }] }];
  const c = formatAnswerContent(qs, 'Branch');
  assert.match(c, /selected the option "Branch"/);
  assert.match(c, /make a branch/);
});

test('formatAnswerContent: unmatched answer → free-text input', () => {
  const c = formatAnswerContent([{ header: 'Lockfile', options: [{ label: 'Branch' }] }], 'actually, rebase onto main');
  assert.match(c, /The user replied: actually, rebase onto main/);
});

test('buildAnswerEvent: a user message carrying a tool_result for the tool_use_id', () => {
  assert.deepEqual(buildAnswerEvent('session_x', 'toolu_9', 'hi', 'fixed'), {
    uuid: 'fixed', session_id: 'session_x', type: 'user', parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'hi', is_error: false }] },
  });
});

test('buildSetupPreamble: install-only from the custom GitHub build, no hub key embedded', () => {
  const p = buildSetupPreamble();
  assert.match(p, /npm install -g github:langmartai\/lm-assist/);   // the custom build, not stale npm
  assert.match(p, /claude plugin install lm-assist@langmartai/);
  assert.match(p, /lm-assist start/);
  assert.doesNotMatch(p, /hub\.json/);          // install-only: writes no hub config
  assert.doesNotMatch(p, /apiKey|wss:\/\//);    // no creds embedded → nothing secret in the transcript
  assert.match(p, /ASK the user to confirm/);   // connecting to the hub is a separate confirmed step
});

test('buildBootstrapInstruction: self-heal (status||start) + no hub key, in every variant', () => {
  for (const opts of [{}, { role: 'worker' as const }, { role: 'orchestrator' as const }, { primaryRepo: 'owner/other' }]) {
    const p = buildBootstrapInstruction(opts);
    assert.match(p, /localhost:3100\/health|lm-assist status/, 'health/status check');
    assert.match(p, /lm-assist start/, 'restart path');
    assert.doesNotMatch(p, /apiKey|wss:\/\//, 'no hub credentials embedded');
  }
});

test('buildBootstrapInstruction: Case A (lm-assist repo) → from-repo install via guide("install"), no "separate tool" clone', () => {
  for (const opts of [{}, { primaryRepo: 'langmartai/lm-assist' }, { primaryRepo: 'git@github.com:langmartai/lm-assist.git' }]) {
    const p = buildBootstrapInstruction(opts);
    assert.match(p, /guide\("install"\)/);
    assert.doesNotMatch(p, /separate tool/i, `${JSON.stringify(opts)} is the lm-assist repo`);
  }
});

test('buildBootstrapInstruction: Case B (other repo) → clone lm-assist independently, return to the repo', () => {
  const p = buildBootstrapInstruction({ primaryRepo: 'YiHuangDB/lm-unified-trade' });
  assert.match(p, /npm install -g github:langmartai\/lm-assist/);
  assert.match(p, /separate tool/i);
  assert.match(p, /YiHuangDB\/lm-unified-trade/);   // names the primary repo to return to
});

test('buildBootstrapInstruction: role contracts (worker names the task; orchestrator; none)', () => {
  const w = buildBootstrapInstruction({ role: 'worker', taskId: 'task_9', title: 'ship it' });
  assert.match(w, /WORKER/);
  assert.match(w, /set_role|⟦WORKER-STATUS⟧/);
  assert.match(w, /task_9/);
  const o = buildBootstrapInstruction({ role: 'orchestrator' });
  assert.match(o, /ORCHESTRATOR/);
  assert.match(o, /worker_status|list_workers|decide_gate/);
  const none = buildBootstrapInstruction({});
  assert.doesNotMatch(none, /you are a WORKER|you are the ORCHESTRATOR/i);
});

test('cloudSessionWebUrl: maps sid to the claude.ai/code URL', () => {
  assert.equal(cloudSessionWebUrl('session_01Epb79wZY8Xg7AMpKoxrZdo'), 'https://claude.ai/code/session_01Epb79wZY8Xg7AMpKoxrZdo');
});

test('isCloudSid: only session_… ids', () => {
  assert.equal(isCloudSid('session_01Epb79wZY8Xg7AMpKoxrZdo'), true);
  assert.equal(isCloudSid('cse_01abc'), false);
  assert.equal(isCloudSid('session_'), false);
  assert.equal(isCloudSid(''), false);
  assert.equal(isCloudSid(undefined), false);
});

test('buildCreateBody: bundle seed → seed_bundle_file_id, empty sources', () => {
  const b = buildCreateBody({ prompt: 'hello', model: 'claude-opus-4-8[1m]', seedFileId: 'file_x', environmentId: 'env_y', title: 'T' });
  assert.equal(b.title, 'T');
  assert.equal(b.environment_id, 'env_y');
  assert.equal((b.session_context as any).seed_bundle_file_id, 'file_x');
  assert.deepEqual((b.session_context as any).sources, []);
  assert.equal((b.session_context as any).model, 'claude-opus-4-8[1m]');
  assert.equal(b.events[0].data.message.content, 'hello');
  assert.equal(b.events[0].data.session_id, ''); // empty on create
});

test('buildCreateBody: no prompt → empty events (boots & waits to be driven)', () => {
  const b = buildCreateBody({ model: 'm', environmentId: 'env_y', sources: [] });
  assert.deepEqual(b.events, []);
  const b2 = buildCreateBody({ prompt: '   ', model: 'm', environmentId: 'env_y' });
  assert.deepEqual(b2.events, []); // whitespace-only is also "no prompt"
});

test('buildCreateBody: github seed → sources set, no seed_bundle_file_id', () => {
  const src = buildGitHubSource('https://github.com/o/r', 'main');
  const b = buildCreateBody({ prompt: 'go', model: 'm', environmentId: 'env_y', sources: [src] });
  assert.deepEqual((b.session_context as any).sources, [src]);
  assert.equal('seed_bundle_file_id' in (b.session_context as any), false);
});

test('buildGitHubSource: git_repository with url + revision', () => {
  assert.deepEqual(buildGitHubSource('https://github.com/o/r', 'dev'), { type: 'git_repository', url: 'https://github.com/o/r', revision: 'dev' });
  assert.deepEqual(buildGitHubSource('https://github.com/o/r'), { type: 'git_repository', url: 'https://github.com/o/r' });
});

test('parseGitHubRepo: accepts owner/name, https, ssh, .git, trailing slash', () => {
  const want = { slug: 'langmartai/lm-assist', url: 'https://github.com/langmartai/lm-assist' };
  assert.deepEqual(parseGitHubRepo('langmartai/lm-assist'), want);
  assert.deepEqual(parseGitHubRepo('https://github.com/langmartai/lm-assist'), want);
  assert.deepEqual(parseGitHubRepo('https://github.com/langmartai/lm-assist.git'), want);
  assert.deepEqual(parseGitHubRepo('git@github.com:langmartai/lm-assist.git'), want);
  assert.deepEqual(parseGitHubRepo('github.com/langmartai/lm-assist/'), want);
  assert.deepEqual(parseGitHubRepo('https://github.com/langmartai/lm-assist/tree/main'), want);
});

test('parseGitHubRepo: rejects junk', () => {
  assert.equal(parseGitHubRepo(''), null);
  assert.equal(parseGitHubRepo('not-a-repo'), null);
  assert.equal(parseGitHubRepo(undefined as any), null);
});

test('buildDriveEvent: follow-up event is unwrapped and carries the sid', () => {
  const e = buildDriveEvent('session_x', 'next', 'fixed');
  assert.deepEqual(e, {
    uuid: 'fixed',
    session_id: 'session_x',
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: 'next' },
  });
});

test('parseTeleportTranscript: extracts role + text + tool names, skips non-message events', () => {
  const body = {
    data: [
      { event_type: 'user', payload: { message: { role: 'user', content: 'hi' } } },
      { event_type: 'assistant', payload: { message: { role: 'assistant', content: [
        { type: 'text', text: 'hello ' },
        { type: 'tool_use', name: 'Bash', input: {} },
        { type: 'text', text: 'world' },
      ] } } },
      { event_type: 'system', payload: { subtype: 'task_started' } }, // skipped
    ],
  };
  const msgs = parseTeleportTranscript(body);
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0], { role: 'user', type: 'user', text: 'hi' });
  assert.equal(msgs[1].text, 'hello world');
  assert.deepEqual(msgs[1].tools, ['Bash']);
});

test('parseTeleportTranscript: tolerates missing/empty data', () => {
  assert.deepEqual(parseTeleportTranscript(null), []);
  assert.deepEqual(parseTeleportTranscript({}), []);
  assert.deepEqual(parseTeleportTranscript({ data: [] }), []);
});
