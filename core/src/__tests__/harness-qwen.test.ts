import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildQwenArgs, buildQwenEnv, parseQwenStream } from '../harness/qwen';
import type { AgentExecuteRequest } from '../types/agent-api';
import type { ProviderProfile } from '../harness/provider-config';

const req = (over: Partial<AgentExecuteRequest> = {}): AgentExecuteRequest =>
  ({ prompt: 'do the thing', ...over }) as AgentExecuteRequest;

const profile: ProviderProfile = {
  baseUrl: 'https://gw.example/native/openrouter/v1',
  apiKey: 'sk-test-key',
  model: 'vendor/model:free',
  wire: 'openai-chat',
};

test('argv requests machine-readable output and unattended approval', () => {
  const args = buildQwenArgs(req(), 'vendor/model:free');
  assert.deepEqual(args.slice(0, 2), ['-p', 'do the thing']);
  assert.ok(args.includes('--output-format'));
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(args[args.indexOf('--approval-mode') + 1], 'yolo');
  assert.equal(args[args.indexOf('-m') + 1], 'vendor/model:free');
});

test('the turn ceiling is always set, and the caller can raise it', () => {
  const dflt = buildQwenArgs(req(), 'm');
  assert.ok(dflt.includes('--max-session-turns'), 'an unbounded agent loop must not be possible');

  const custom = buildQwenArgs(req({ maxTurns: 3 }), 'm');
  assert.equal(custom[custom.indexOf('--max-session-turns') + 1], '3');
});

test('the prompt is passed as its own argv entry, never interpolated', () => {
  const nasty = 'fix "; rm -rf / ;" the bug';
  const args = buildQwenArgs(req({ prompt: nasty }), 'm');
  assert.equal(args[1], nasty, 'the prompt must survive verbatim as one argument');
  assert.equal(args.filter((a) => a === nasty).length, 1);
});

test('env carries the profile and isolates the operator local setup', () => {
  const env = buildQwenEnv(profile, 'vendor/model:free');
  assert.equal(env.OPENAI_BASE_URL, profile.baseUrl);
  assert.equal(env.OPENAI_API_KEY, profile.apiKey);
  assert.equal(env.OPENAI_MODEL, 'vendor/model:free');
  assert.equal(env.QWEN_CODE_SAFE_MODE, 'true', 'must not inherit local hooks/extensions/MCP');
});

test('a full agentic run folds into result text, turns and tool count', () => {
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'session_start', session_id: 'sess-42' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'read_file', input: { path: 'x' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'the answer is 4271' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'It is 4271.' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'It is 4271.' }),
  ].join('\n');

  const s = parseQwenStream(stream);
  assert.equal(s.sessionId, 'sess-42');
  assert.equal(s.text, 'It is 4271.');
  assert.equal(s.numTurns, 2);
  assert.equal(s.toolCalls, 1);
  assert.equal(s.errored, false);
});

test('a malformed line is skipped, not fatal', () => {
  const stream = [
    '{ this is not json',
    JSON.stringify({ type: 'result', subtype: 'success', result: 'still fine' }),
    '',
  ].join('\n');
  const s = parseQwenStream(stream);
  assert.equal(s.text, 'still fine');
  assert.equal(s.errored, false);
});

test('an endpoint error reported through a "success" frame is still a failure', () => {
  // Measured against the real CLI: when the gateway rejected the request shape,
  // qwen exited 0 and emitted subtype "success" whose result was the API error.
  // Trusting the subtype alone would report a failed run as a successful one.
  const stream = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '[API Error: 400 Message content must be string or null]' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', result: '[API Error: 400 Message content must be string or null]' }),
  ].join('\n');

  const s = parseQwenStream(stream);
  assert.equal(s.errored, true, 'an API error must not be reported as success');
  assert.match(s.errorText!, /API Error/);
});

test('a non-success result subtype is a failure', () => {
  const s = parseQwenStream(JSON.stringify({ type: 'result', subtype: 'error_max_turns', result: 'hit the ceiling' }));
  assert.equal(s.errored, true);
});

test('assistant text is used when no result frame arrives', () => {
  const stream = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial answer' }] } }),
  ].join('\n');
  assert.equal(parseQwenStream(stream).text, 'partial answer');
});

test('a RAW U+2028 inside a payload does not corrupt framing', () => {
  // Pi's docs warn that generic line readers also split on Unicode separators, which
  // are LEGAL unescaped inside a JSON string. JSON.stringify escapes them, so the line
  // has to be built by hand to reproduce what a real producer emits.
  const RAW_LS = String.fromCharCode(0x2028);
  const RAW_PS = String.fromCharCode(0x2029);
  const line = `{"type":"result","subtype":"success","result":"one${RAW_LS}two${RAW_PS}three"}`;

  assert.ok(line.includes(RAW_LS), 'the fixture must carry a raw separator, else this test is vacuous');
  assert.equal(line.split('\n').length, 1, 'a raw separator is not a newline');

  const s = parseQwenStream(line);
  assert.equal(s.text, `one${RAW_LS}two${RAW_PS}three`);
  assert.equal(s.errored, false);
});

/**
 * Token usage. The field names below are snake_case because that is what the
 * REAL CLI emits (qwen 0.15.10, captured 2026-09-09) — they are not the
 * camelCase of AgentTokenUsage, and they are not guessed from the Claude Code
 * stream-json this format otherwise resembles.
 */
test('token usage is summed across the run API calls', () => {
  // Verbatim shape from a captured run: the thinking-only frame reports zeros
  // with the cache keys ABSENT, then the answering frame carries the real counts.
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }], usage: { input_tokens: 0, output_tokens: 0 } } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'PONG' }], usage: { input_tokens: 15914, output_tokens: 52, cache_read_input_tokens: 0, total_tokens: 15966 } } }),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'PONG' }),
  ].join('\n');

  const s = parseQwenStream(stream);
  assert.equal(s.usageReported, true);
  assert.equal(s.usage.inputTokens, 15914);
  assert.equal(s.usage.outputTokens, 52);
  assert.equal(s.usage.cacheReadInputTokens, 0);
  // The house convention (convertResult) is input + output. Deliberately NOT the
  // stream's own total_tokens, so a qwen run stays comparable with every other runner.
  assert.equal(s.usage.totalTokens, 15914 + 52);
});

test('a multi-call run accumulates rather than keeping only the last call', () => {
  const frame = (i: number, o: number) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }], usage: { input_tokens: i, output_tokens: o } } });
  const s = parseQwenStream([frame(100, 10), frame(250, 20)].join('\n'));

  assert.equal(s.usage.inputTokens, 350, 'per-call counts must be summed, as the SDK path sums them');
  assert.equal(s.usage.outputTokens, 30);
});

test('a stream with no usage block says so instead of reporting a free run', () => {
  const s = parseQwenStream(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }));
  assert.equal(s.usageReported, false, '0 must be distinguishable from "the stream never said"');
  assert.equal(s.usage.totalTokens, 0);
});

test('a garbage usage block cannot poison the totals with NaN', () => {
  const stream = JSON.stringify({
    type: 'assistant',
    message: { content: [], usage: { input_tokens: 'lots', output_tokens: null, cache_read_input_tokens: undefined } },
  });
  const s = parseQwenStream(stream);
  assert.equal(Number.isFinite(s.usage.inputTokens), true, 'a non-number must not become NaN');
  assert.equal(s.usage.inputTokens, 0);
});
