import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
  sweepStaleOpencodeConfigs,
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

test('the child env is built from scratch — a parent secret never reaches it', () => {
  // Review flagged the previous version of this test as vacuous: buildOpencodeEnv never
  // receives the key, so `includes(apiKey)` could not fail under ANY implementation.
  // The real hazard is INHERITANCE — the first build spread process.env (encryption
  // keys, npm/messaging tokens) into a child running auto-approved shell. Plant a canary.
  const canary = 'LM_TEST_SECRET_CANARY_OC';
  process.env[canary] = 'must-not-leak';
  try {
    const env = buildOpencodeEnv('/tmp/x/opencode.json');
    assert.equal(env.OPENCODE_CONFIG, '/tmp/x/opencode.json');
    assert.equal(env[canary], undefined, 'a parent secret must never reach the harness child');
    for (const k of Object.keys(env)) {
      assert.ok(/^(PATH|HOME|LANG|TERM|TMPDIR|OPENCODE_CONFIG|FORCE_COLOR)$/.test(k), `unexpected env key leaked: ${k}`);
    }
  } finally {
    delete process.env[canary];
  }
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

/**
 * The per-run credential file, and the hooks. These run execute() for real, so
 * each one pins TMPDIR and LM_ASSIST_DATA_DIR to fresh temp dirs (the operator's
 * provider file is never read) and uses a synthetic key only. None of them can
 * reach a real `opencode`: every path here refuses before spawn.
 */
async function inSandbox(profile: boolean, fn: (tmp: string) => Promise<void>): Promise<void> {
  const keys = ['TMPDIR', 'LM_ASSIST_DATA_DIR', 'LM_HARNESS_BASE_URL', 'LM_HARNESS_API_KEY', 'LM_HARNESS_MODEL'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-oc-sandbox-'));
  const tmp = path.join(box, 'tmp');
  fs.mkdirSync(tmp);
  fs.mkdirSync(path.join(box, 'data'));
  for (const k of keys) delete process.env[k];
  process.env.TMPDIR = tmp;
  process.env.LM_ASSIST_DATA_DIR = path.join(box, 'data');
  if (profile) {
    process.env.LM_HARNESS_BASE_URL = 'https://gw.example/v1';
    process.env.LM_HARNESS_API_KEY = 'sk-test-SENTINEL-0000000000000000';
    process.env.LM_HARNESS_MODEL = 'vendor/model:free';
  }
  try {
    await fn(tmp);
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(box, { recursive: true, force: true });
  }
}

const leftovers = (tmp: string) => fs.readdirSync(tmp).filter((n) => n.startsWith('lm-harness-opencode-'));

test('a NUL byte in the prompt is refused BEFORE the credential file is written', async () => {
  // MEASURED: spawn() throws synchronously on a NUL in argv, and the prompt is on
  // argv. That throw used to come after the 0600 config write, so the file holding
  // the live key was never cleaned up.
  await inSandbox(true, async (tmp) => {
    const settles: string[] = [];
    let spawned = false;
    const res = await createOpencodeHarness().execute(req({ prompt: 'hi\u0000there' }), 'oc-nul-1', {
      onSettle: (i) => settles.push(i.termination),
      onSpawn: () => { spawned = true; },
    });
    assert.equal(res.success, false);
    assert.match(res.error!, /NUL byte/);
    assert.deepEqual(leftovers(tmp), [], 'no credential dir may be left behind');
    assert.deepEqual(settles, ['config_error']);
    assert.equal(spawned, false);

    const cwdRes = await createOpencodeHarness().execute(req({ cwd: '/tmp/a\u0000b' }), 'oc-nul-2');
    assert.equal(cwdRes.success, false);
    assert.deepEqual(leftovers(tmp), []);
  });
});

test('a refusal settles as config_error and never spawns — and hooks change nothing', async () => {
  await inSandbox(false, async () => {
    const events: string[] = [];
    const withHooks = await createOpencodeHarness().execute(req(), 'oc-refuse-1', {
      onResolved: () => events.push('resolved'),
      onSpawn: () => events.push('spawn'),
      onSettle: (i) => events.push(`settle:${i.termination}`),
    });
    assert.deepEqual(events, ['settle:config_error']);
    assert.equal(withHooks.success, false);
    assert.match(withHooks.error!, /No harness provider profile/);

    const boom = () => { throw new Error('observer bug'); };
    const throwing = await createOpencodeHarness().execute(req(), 'oc-refuse-2', { onSettle: boom, onSpawn: boom });
    const without = await createOpencodeHarness().execute(req(), 'oc-refuse-3');
    const shape = (r: typeof without) => ({ ...r, durationMs: 0, executionId: '' });
    assert.deepEqual(shape(throwing), shape(without), 'a throwing observer must not change the response');
    assert.deepEqual(shape(withHooks), shape(without), 'hooks must not change the response');
  });
});

test('the stale-credential sweep removes an old dir of ours and keeps a fresh one', async () => {
  await inSandbox(false, async (tmp) => {
    const old = path.join(tmp, 'lm-harness-opencode-OLD111');
    const fresh = path.join(tmp, 'lm-harness-opencode-NEW222');
    const live = path.join(tmp, 'lm-harness-opencode-LIVE33');
    const unrelated = path.join(tmp, 'something-else');
    for (const d of [old, fresh, live, unrelated]) {
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'opencode.json'), '{}', { mode: 0o600 });
    }
    const past = new Date(Date.now() - 48 * 3600 * 1000);
    for (const d of [old, live, unrelated]) fs.utimesSync(d, past, past);

    const removed = sweepStaleOpencodeConfigs(24 * 3600 * 1000, (d) => d === live);
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(old), false, 'a day-old credential dir is removed');
    assert.equal(fs.existsSync(fresh), true, 'a dir that may belong to a run in flight is kept');
    assert.equal(fs.existsSync(live), true, 'a dir a live run still uses is kept, however old');
    assert.equal(fs.existsSync(unrelated), true, 'only our own prefix is ever touched');
  });
});

/**
 * A config write that fails part-way (ENOSPC, EDQUOT, EFBIG) can leave a partial 0600
 * file holding the key. The run must remove its dir, and must UNPIN it first: a dir
 * still marked live is skipped by the stale sweep for the life of the process.
 * `fs.writeFileSync` is stubbed on the real module object (the harness's `fs` import
 * reads through to it) so the failure is exactly the one a full disk produces.
 */
test('a failed credential write removes the temp dir and never pins it as live', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const realFs = require('fs') as typeof import('fs');
  const origWrite = realFs.writeFileSync;
  const origRm = realFs.rmSync;
  const failWrite = ((file: fs.PathOrFileDescriptor, data: unknown, opts?: unknown) => {
    if (typeof file === 'string' && path.basename(file) === 'opencode.json' && file.includes('lm-harness-opencode-')) {
      // Leave a partial file behind, as a write that ran out of space does.
      origWrite(file, '{"provider":{"lmharness":{"options":{"apiKey":"sk-test-SENT', { mode: 0o600 });
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    }
    return (origWrite as (...a: unknown[]) => void)(file, data, opts);
  }) as typeof realFs.writeFileSync;

  await inSandbox(true, async (tmp) => {
    realFs.writeFileSync = failWrite;
    try {
      const settles: string[] = [];
      const res = await createOpencodeHarness().execute(req(), 'oc-enospc-1', { onSettle: (i) => settles.push(i.termination) });
      assert.equal(res.success, false);
      assert.match(res.error!, /Could not write the opencode provider config/);
      assert.deepEqual(settles, ['config_error']);
      assert.deepEqual(leftovers(tmp), [], 'the dir holding a partial credential file is removed');

      // And when the rm fails too, the dir is at least UNPINNED: the default sweep takes it.
      realFs.rmSync = (() => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); }) as typeof realFs.rmSync;
      await createOpencodeHarness().execute(req(), 'oc-enospc-2');
      realFs.rmSync = origRm;
      assert.equal(leftovers(tmp).length, 1, 'the failed rm left the dir behind');
      assert.equal(sweepStaleOpencodeConfigs(0), 1, 'the default (live-dir) predicate no longer protects it');
      assert.deepEqual(leftovers(tmp), []);
    } finally {
      realFs.writeFileSync = origWrite;
      realFs.rmSync = origRm;
    }
  });
});
