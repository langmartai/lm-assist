import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The OpenCode harness.
 *
 * Every stream fixture below is a VERBATIM event captured from opencode 1.18.29
 * on 2026-09-09 (a PONG run and a read-a-file tool run through the gateway), not
 * a shape invented from documentation. Two of them contradict what the format
 * was assumed to be before it was measured:
 *
 *   - `--format json` is a STREAM of NDJSON events, not one object at completion;
 *   - a step that plainly generated text reports `output: 0` and puts the
 *     generated tokens under `reasoning`.
 */

import {
  buildOpencodeArgs,
  buildOpencodeConfig,
  buildOpencodeEnv,
  parseOpencodeStream,
  createOpencodeHarness,
  PROVIDER_ID,
  OPENCODE_ID,
} from '../harness/opencode';
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

test('the config declares the provider OpenCode needs, keyed by the real model id', () => {
  const cfg = buildOpencodeConfig(profile, 'vendor/model:free') as any;
  const p = cfg.provider[PROVIDER_ID];

  assert.equal(p.npm, '@ai-sdk/openai-compatible');
  assert.equal(p.options.baseURL, profile.baseUrl);
  assert.equal(p.options.apiKey, profile.apiKey);
  // The key IS the id sent to the endpoint, slashes and all — verified working
  // as `-m <provider>/vendor/model:free`.
  assert.ok(Object.keys(p.models).includes('vendor/model:free'));
});

test('argv is unattended, plugin-free and machine-readable', () => {
  const args = buildOpencodeArgs(req(), 'vendor/model:free', '/work/here');

  assert.equal(args[0], 'run');
  assert.equal(args[args.indexOf('--format') + 1], 'json');
  assert.ok(args.includes('--auto'), 'a headless run cannot answer a permission prompt');
  assert.ok(args.includes('--pure'), 'must not inherit the operator local plugins');
  assert.equal(args[args.indexOf('-m') + 1], `${PROVIDER_ID}/vendor/model:free`);
});

test('the working directory is stated explicitly, because opencode ignores the spawn cwd', () => {
  // 🔴 MEASURED, and the reason --dir is a required argument here: a child
  // spawned with `cwd: /tmp/…/wk` from a parent sitting in the lm-assist
  // checkout ran the agent IN THE CHECKOUT and reported success. Under --auto
  // that is an agent editing a tree nobody asked it to touch.
  const args = buildOpencodeArgs(req(), 'm', '/work/here');

  assert.equal(args[args.indexOf('--dir') + 1], '/work/here');
  assert.ok(args.indexOf('--dir') < args.indexOf('--'), 'the flag must precede the message separator');
});

test('the prompt is the last argument, after --, and survives verbatim', () => {
  // Without `--` a prompt beginning with a dash is parsed as a flag.
  const nasty = '-x fix "; rm -rf / ;" the bug';
  const args = buildOpencodeArgs(req({ prompt: nasty }), 'm', '/work/here');

  assert.equal(args[args.length - 1], nasty);
  assert.equal(args[args.length - 2], '--');
  assert.equal(args.filter((a) => a === nasty).length, 1);
});

test('the credential travels by config file, never in the environment', () => {
  const env = buildOpencodeEnv('/tmp/x/opencode.json');

  assert.equal(env.OPENCODE_CONFIG, '/tmp/x/opencode.json');
  const serialised = JSON.stringify(env);
  assert.equal(serialised.includes(profile.apiKey), false, 'the key must not reach the child environment');
});

test('a real tool-calling run folds into text, turns, tool count and usage', () => {
  // Verbatim from the captured read-a-file run.
  const stream = [
    JSON.stringify({ type: 'step_start', sessionID: 'ses_abc', part: { type: 'step-start' } }),
    JSON.stringify({ type: 'tool_use', sessionID: 'ses_abc', part: { type: 'tool', tool: 'read', callID: 'read_1', state: { status: 'completed' } } }),
    JSON.stringify({ type: 'step_finish', sessionID: 'ses_abc', part: { reason: 'tool-calls', tokens: { total: 8540, input: 8461, output: 0, reasoning: 82, cache: { write: 0, read: 0 } }, cost: 0 } }),
    JSON.stringify({ type: 'step_start', sessionID: 'ses_abc', part: { type: 'step-start' } }),
    JSON.stringify({ type: 'text', sessionID: 'ses_abc', part: { type: 'text', text: 'SECRET-4271' } }),
    JSON.stringify({ type: 'step_finish', sessionID: 'ses_abc', part: { reason: 'stop', tokens: { total: 8597, input: 8553, output: 0, reasoning: 46, cache: { write: 0, read: 0 } }, cost: 0 } }),
  ].join('\n');

  const s = parseOpencodeStream(stream);
  assert.equal(s.sessionId, 'ses_abc');
  assert.equal(s.text, 'SECRET-4271');
  assert.equal(s.numTurns, 2, 'one per step_finish');
  assert.equal(s.toolCalls, 1);
  assert.equal(s.errored, false);

  assert.equal(s.usageReported, true);
  assert.equal(s.usage.inputTokens, 8461 + 8553, 'per-step counts are summed');
  // 🔴 output is 0 in BOTH steps and the generated tokens are under `reasoning`.
  // Reading only `output` would report a run that produced nothing.
  assert.equal(s.usage.outputTokens, 82 + 46);
  assert.equal(s.usage.totalTokens, 8461 + 8553 + 82 + 46);
});

test('only the FINAL step text is the answer, not the running commentary', () => {
  const stream = [
    JSON.stringify({ type: 'step_start', sessionID: 's' }),
    JSON.stringify({ type: 'text', sessionID: 's', part: { text: 'Let me look at the file.' } }),
    JSON.stringify({ type: 'step_finish', sessionID: 's', part: { reason: 'tool-calls' } }),
    JSON.stringify({ type: 'step_start', sessionID: 's' }),
    JSON.stringify({ type: 'text', sessionID: 's', part: { text: 'The answer is 4271.' } }),
    JSON.stringify({ type: 'step_finish', sessionID: 's', part: { reason: 'stop' } }),
  ].join('\n');

  assert.equal(parseOpencodeStream(stream).text, 'The answer is 4271.');
});

test('a run cut short before any step_finish still returns what it produced', () => {
  // What an abort or a timeout leaves behind.
  const stream = [
    JSON.stringify({ type: 'step_start', sessionID: 's' }),
    JSON.stringify({ type: 'text', sessionID: 's', part: { text: 'partial answer' } }),
  ].join('\n');

  const s = parseOpencodeStream(stream);
  assert.equal(s.text, 'partial answer');
  assert.equal(s.usageReported, false, '0 tokens here means "never reported", not "free"');
});

test('an error event is a failure, and its message survives', () => {
  // Verbatim from a run against a model id the provider does not serve.
  const stream = JSON.stringify({
    type: 'error',
    sessionID: 'ses_x',
    error: { name: 'UnknownError', data: { message: 'Unexpected server error. Check server logs for details.', ref: 'err_1' } },
  });

  const s = parseOpencodeStream(stream);
  assert.equal(s.errored, true);
  assert.match(s.errorText!, /Unexpected server error/);
});

test('an error with no message still names the failure', () => {
  const s = parseOpencodeStream(JSON.stringify({ type: 'error', error: { name: 'ProviderAuthError' } }));
  assert.equal(s.errored, true);
  assert.equal(s.errorText, 'ProviderAuthError');
});

test('a malformed line is skipped, not fatal', () => {
  const stream = ['{ not json at all', JSON.stringify({ type: 'text', part: { text: 'still fine' } }), ''].join('\n');
  assert.equal(parseOpencodeStream(stream).text, 'still fine');
});

test('a garbage token block cannot poison the totals with NaN', () => {
  const stream = JSON.stringify({ type: 'step_finish', part: { tokens: { input: 'many', output: null, reasoning: undefined, cache: null } } });
  const s = parseOpencodeStream(stream);

  assert.equal(s.usage.inputTokens, 0);
  assert.equal(Number.isFinite(s.usage.totalTokens), true);
});

test('the harness declares what it can and cannot honestly do', () => {
  const h = createOpencodeHarness();

  assert.equal(h.id, OPENCODE_ID);
  assert.equal(h.capabilities.abortable, true);
  assert.equal(typeof h.abort, 'function');
  // opencode DOES print a per-step `cost`, but for a custom provider it has no
  // rate card and prints 0. Claiming that as a real price is the exact trap this
  // codebase already closed for unknown Claude models.
  assert.equal(h.capabilities.cost, 'unavailable');
  // `opencode run --session <id>` exists; this harness does not implement
  // resume(), and the capability must describe the harness, not the CLI.
  assert.equal(h.capabilities.sessionResume, false);
  assert.equal(h.resume, undefined);
  assert.equal(h.abort!('never-ran'), false);
});
