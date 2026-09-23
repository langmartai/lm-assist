import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The run recorder, driven by a FAKE harness that calls the hooks exactly as
 * qwen/opencode do — no CLI is spawned anywhere in this file.
 *
 * The contract under test is that recording is invisible to the caller: the
 * inner response comes back by identity, a rejection is re-thrown unchanged,
 * and no store, filesystem or observer failure changes either. Beyond that, a
 * synthetic key placed in the prompt, the stream, the result and the error must
 * never reach a file.
 */

import { withRunRecording, terminalStatus } from '../harness/run-recorder';
import { getRun, hasRun, isRunInFlight, deriveStatus } from '../harness/run-store';
import { harnessRunsRoot, runIndexFile } from '../harness/run-paths';
import type { AgentHarness, HarnessRunHooks } from '../harness/types';
import type { AgentExecuteRequest, AgentExecuteResponse } from '../types/agent-api';

const SENTINEL = 'sk-test-SENTINEL-0000000000000000';
/** A configured key that no generic pattern matches — only the exact-value rule catches it. */
const FILE_KEY = 'gw-file-KEY-SENTINEL-99887766';

let base: string;
let dataDir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['LM_ASSIST_DATA_DIR', 'LM_ASSIST_PROD', 'LM_HARNESS_BASE_URL', 'LM_HARNESS_API_KEY', 'LM_HARNESS_MODEL', 'LM_HARNESS_OPENCODE_DB'];

before(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-recorder-'));
  process.env.LM_HARNESS_OPENCODE_DB = path.join(base, 'no-opencode', 'opencode.db');
  freshDataDir();
});

after(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.chmodSync(base, 0o700);
  fs.rmSync(base, { recursive: true, force: true });
});

function freshDataDir(): string {
  dataDir = fs.mkdtempSync(path.join(base, 'data-'));
  process.env.LM_ASSIST_DATA_DIR = dataDir;
  fs.writeFileSync(
    path.join(dataDir, 'harness-providers-dev.json'),
    JSON.stringify({ defaultProfile: 'gw', profiles: { gw: { baseUrl: 'https://gw.example/native/x/v1', apiKey: FILE_KEY, model: 'vendor/model:free' } } }),
    { mode: 0o600 },
  );
  return dataDir;
}

const req = (over: Partial<AgentExecuteRequest> = {}): AgentExecuteRequest =>
  ({ prompt: 'write hello.txt', cwd: '/work/project', ...over }) as AgentExecuteRequest;

function response(executionId: string, over: Partial<AgentExecuteResponse> = {}): AgentExecuteResponse {
  return {
    success: true,
    result: 'DONE',
    sessionId: '',
    executionId,
    durationMs: 5,
    durationApiMs: 0,
    numTurns: 2,
    totalCostUsd: 0,
    usage: { inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 3, totalTokens: 120 },
    modelUsage: { 'vendor/model:free': { inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 3, totalTokens: 120 } },
    runner: 'qwen',
    ...over,
  };
}

type Script = (request: AgentExecuteRequest, executionId: string, hooks: HarnessRunHooks | undefined) => Promise<AgentExecuteResponse>;

/** A harness that runs `script` and counts calls. `abortable` adds an abort() that settles a pending run. */
function fake(id: string, script: Script, abortable = false) {
  const calls = { execute: 0, abort: 0 };
  const pending = new Map<string, (r: AgentExecuteResponse) => void>();
  const h: AgentHarness = {
    id,
    displayName: `Fake ${id}`,
    capabilities: {
      cost: 'unavailable', sessionResume: false, mcp: false, permissionBroker: false,
      durableBackground: false, usesProviderProfile: true, abortable,
    },
    async execute(request, executionId, hooks) {
      calls.execute += 1;
      return script(request, executionId, hooks);
    },
  };
  if (abortable) {
    h.abort = (executionId: string) => {
      calls.abort += 1;
      const settle = pending.get(executionId);
      if (!settle) return false;
      pending.delete(executionId);
      settle(response(executionId, { success: false, result: '', error: 'qwen terminated by SIGTERM', modelUsage: {} }));
      return true;
    };
  }
  return { h, calls, pending };
}

const QWEN_INIT = (sid: string) => JSON.stringify({ type: 'system', subtype: 'init', session_id: sid });
const QWEN_TOOL = JSON.stringify({ type: 'assistant', uuid: 't1', message: { content: [{ type: 'tool_use', id: 'c1', name: 'write_file', input: { file_path: '/work/project/hello.txt', content: 'PONG' } }] } });

/** Resolve after pending setImmediate work (the recorder's enrichment) has run. */
const drain = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

test('terminalStatus follows the documented precedence', () => {
  assert.equal(terminalStatus({ termination: 'config_error', abortRequested: true, success: false }), 'refused');
  assert.equal(terminalStatus({ termination: 'spawn_throw', abortRequested: false, success: false }), 'launch_failed');
  assert.equal(terminalStatus({ termination: 'launch_error', abortRequested: false, success: false }), 'launch_failed');
  assert.equal(terminalStatus({ termination: 'timeout', abortRequested: true, success: false }), 'aborted', 'an abort that raced the timer is still an abort');
  assert.equal(terminalStatus({ termination: 'timeout', abortRequested: false, success: false }), 'timed_out');
  assert.equal(terminalStatus({ termination: 'exit', abortRequested: true, success: true }), 'succeeded', 'a run that finished anyway succeeded');
  assert.equal(terminalStatus({ termination: 'exit', abortRequested: false, success: false }), 'failed');
  assert.equal(terminalStatus({ abortRequested: false, success: true }), 'succeeded', 'no settle hook at all');
});

test('a succeeded run: the response comes back BY IDENTITY and the record holds what the hooks said', async () => {
  let seenBeforeExecute: unknown;
  let inner: AgentExecuteResponse | undefined;
  const { h } = fake('qwen', async (_r, id, hooks) => {
    const rec = getRun(id);
    seenBeforeExecute = rec && { status: rec.status, live: deriveStatus(rec).live, inFlight: isRunInFlight(id) };
    hooks?.onResolved?.({ model: 'vendor/model:free', profileName: 'gw', baseUrl: 'https://gw.example/native/x/v1', cwd: '/work/project', maxTurnsEnforced: true });
    hooks?.onSpawn?.({ pid: 4242 });
    hooks?.onStdout?.(`${QWEN_INIT('0f8fad5b-d9cb-469f-a165-70867728950e')}\n${QWEN_TOOL}`);
    hooks?.onStdout?.('\n');
    hooks?.onSettle?.({ termination: 'exit', exitCode: 0, signal: null });
    inner = response(id);
    return inner;
  });
  const outer = withRunRecording(h);

  const res = await outer.execute(req(), 'rec-ok-1');
  assert.equal(res, inner, 'the caller must get the inner response object itself');
  assert.deepEqual(seenBeforeExecute, { status: 'running', live: true, inFlight: true }, 'the start record exists before the harness runs');
  assert.equal(isRunInFlight('rec-ok-1'), false);

  const r = getRun('rec-ok-1')!;
  assert.equal(r.status, 'succeeded');
  assert.equal(r.termination, 'exit');
  assert.equal(r.exitCode, 0);
  assert.equal(r.model, 'vendor/model:free');
  assert.equal(r.providerProfile, 'gw');
  assert.equal(r.baseUrlHost, 'gw.example', 'the host only — never the full URL');
  assert.equal(r.maxTurnsEnforced, true);
  assert.equal(r.pid, 4242);
  assert.equal(r.sessionId, '0f8fad5b-d9cb-469f-a165-70867728950e');
  assert.equal(r.native?.kind, 'qwen-chat');
  assert.equal(r.runDir, 'harness-runs-dev/rec-ok-1');
  assert.equal(r.cwd, '/work/project');
  assert.equal(r.cwdDefaulted, false);
  assert.equal(r.costUsd, null);
  assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 20, reasoningTokens: null, cacheReadTokens: 3, cacheWriteTokens: 0, totalTokens: 120, reported: true });
  assert.equal(r.capture?.lines, 2);
  assert.equal(r.capture?.truncated, false);

  const dir = path.join(harnessRunsRoot(), 'rec-ok-1');
  assert.equal(fs.statSync(harnessRunsRoot()).mode & 0o777, 0o700);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'stdout.log')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'prompt.txt')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8'), 'write hello.txt');
  const first = fs.readFileSync(path.join(dir, 'stdout.log'), 'utf8').split('\n')[0];
  assert.match(first, /^\d{13}\t\{"type":"system"/, 'each capture line is <epochMs>\\t<frame>');

  await drain();
  const enriched = getRun('rec-ok-1')!;
  assert.equal(enriched.toolCalls, 1, 'enrichment counts tools from the captured stream');
  assert.deepEqual(enriched.toolsByName, { write_file: 1 });
});

test('the session id is recorded from the first frame, while the run is still pending', async () => {
  let midRun: string | undefined;
  const { h } = fake('opencode', async (_r, id, hooks) => {
    hooks?.onStdout?.(`${JSON.stringify({ type: 'step_start', sessionID: 'ses_AbCdEf123456789' })}\n`);
    midRun = getRun(id)?.sessionId;
    hooks?.onSettle?.({ termination: 'exit', exitCode: 0 });
    return response(id, { runner: 'opencode' });
  });
  await withRunRecording(h).execute(req(), 'rec-sniff-1');
  assert.equal(midRun, 'ses_AbCdEf123456789');
  assert.ok(getRun('rec-sniff-1')!.firstOutputAt);
});

test('opencode records its DB locator at resolve time; qwen records its chat kind at start', async () => {
  const { h } = fake('opencode', async (_r, id, hooks) => {
    hooks?.onResolved?.({ model: 'm', profileName: 'gw', baseUrl: 'https://gw.example/v1', cwd: '/w', maxTurnsEnforced: false });
    hooks?.onSettle?.({ termination: 'exit', exitCode: 0 });
    return response(id, { runner: 'opencode' });
  });
  await withRunRecording(h).execute(req(), 'rec-oc-native');
  const r = getRun('rec-oc-native')!;
  assert.equal(r.native?.kind, 'opencode-db');
  assert.equal(r.native?.dbPath, process.env.LM_HARNESS_OPENCODE_DB);
  assert.equal(r.maxTurnsEnforced, false);
});

test('timed_out, refused and launch_error settle into their statuses', async () => {
  const run = async (id: string, termination: 'timeout' | 'config_error' | 'launch_error') => {
    const { h } = fake('qwen', async (_r, execId, hooks) => {
      hooks?.onSettle?.({ termination });
      return response(execId, { success: false, error: 'nope', modelUsage: {} });
    });
    await withRunRecording(h).execute(req(), id);
    return getRun(id)!;
  };
  const t = await run('rec-timeout', 'timeout');
  assert.equal(t.status, 'timed_out');
  assert.equal(t.usage?.reported, false, 'an empty modelUsage means the zeros are unknown, not free');
  assert.equal((await run('rec-refused', 'config_error')).status, 'refused');
  assert.equal((await run('rec-launch', 'launch_error')).status, 'launch_failed');
});

test('a run with no readable transcript leaves its tool counts UNKNOWN — never a written 0', async () => {
  const { h } = fake('qwen', async (_r, execId, hooks) => {
    hooks?.onSettle?.({ termination: 'config_error' });
    return response(execId, { success: false, error: 'No harness provider profile configured.', modelUsage: {} });
  });
  await withRunRecording(h).execute(req(), 'rec-no-transcript');
  await drain();
  const r = getRun('rec-no-transcript')!;
  assert.equal(r.status, 'refused');
  assert.equal(r.toolCalls, undefined, '"0 tool calls" would be a claim about a run nothing could read');
  assert.equal(r.toolErrors, undefined);
  assert.equal(r.toolsByName, undefined);
});

test('a rejection is re-thrown unchanged and recorded as launch_failed', async () => {
  const boom = new Error('synthetic spawn failure');
  const { h } = fake('qwen', async () => { throw boom; });
  await assert.rejects(withRunRecording(h).execute(req(), 'rec-reject'), (e) => e === boom);
  const r = getRun('rec-reject')!;
  assert.equal(r.status, 'launch_failed');
  assert.equal(r.termination, 'spawn_throw');
  assert.match(r.error!, /synthetic spawn failure/);
  assert.equal(isRunInFlight('rec-reject'), false);
});

test('an abort the harness confirms is stamped, and the run settles as aborted', async () => {
  const f = fake('qwen', (_r, id, hooks) => new Promise((resolve) => {
    hooks?.onSpawn?.({ pid: 1 });
    f.pending.set(id, (res) => { hooks?.onSettle?.({ termination: 'exit', exitCode: null, signal: 'SIGTERM' }); resolve(res); });
  }), true);
  const outer = withRunRecording(f.h);
  const p = outer.execute(req(), 'rec-abort');
  await new Promise((r) => setImmediate(r));

  assert.equal(outer.abort!('rec-abort'), true, 'a synchronous inner abort stays synchronous');
  const res = await p;
  assert.equal(res.success, false);
  const r = getRun('rec-abort')!;
  assert.equal(r.status, 'aborted');
  assert.ok(r.abortRequestedAt);
  assert.equal(r.signal, 'SIGTERM');
});

test('an abort that signalled nothing stamps nothing', async () => {
  const f = fake('qwen', async (_r, id, hooks) => {
    hooks?.onSettle?.({ termination: 'exit', exitCode: 1 });
    return response(id, { success: false, error: 'exit 1' });
  }, true);
  const outer = withRunRecording(f.h);
  await outer.execute(req(), 'rec-noabort');
  assert.equal(outer.abort!('rec-noabort'), false);
  const r = getRun('rec-noabort')!;
  assert.equal(r.abortRequestedAt, undefined);
  assert.equal(r.status, 'failed');
});

test('an invalid executionId is refused, never recorded, and the harness never runs', async () => {
  const f = fake('qwen', async (_r, id) => response(id));
  const outer = withRunRecording(f.h);
  for (const bad of ['a.b', '../x', '', '-leading', 'x'.repeat(129), 'nul\u0000id']) {
    const res = await outer.execute(req(), bad);
    assert.equal(res.success, false);
    assert.equal(res.runner, 'qwen');
    assert.match(res.error!, /^INVALID_EXECUTION_ID: /);
    assert.equal(hasRun(bad), false);
  }
  assert.equal(f.calls.execute, 0);
  assert.equal(fs.existsSync(path.join(harnessRunsRoot(), 'a_b')), false, 'no run dir was made for a refused id');
});

test('a reused executionId is refused, and the first run is left intact', async () => {
  const f = fake('qwen', async (_r, id, hooks) => { hooks?.onSettle?.({ termination: 'exit', exitCode: 0 }); return response(id); });
  const outer = withRunRecording(f.h);
  assert.equal((await outer.execute(req(), 'rec-dup')).success, true);
  const second = await outer.execute(req({ prompt: 'something else' }), 'rec-dup');
  assert.equal(second.success, false);
  assert.match(second.error!, /^DUPLICATE_EXECUTION_ID: /);
  assert.equal(f.calls.execute, 1);
  assert.equal(getRun('rec-dup')!.promptPreview, 'write hello.txt');
});

test('an existing run dir alone is enough to refuse the id (the index cannot vouch for it)', async () => {
  fs.mkdirSync(path.join(harnessRunsRoot(), 'rec-stray-dir'), { recursive: true });
  const f = fake('qwen', async (_r, id) => response(id));
  const res = await withRunRecording(f.h).execute(req(), 'rec-stray-dir');
  assert.match(res.error!, /^DUPLICATE_EXECUTION_ID: /);
  assert.equal(f.calls.execute, 0);
});

test('a synthetic key in the prompt, stream, result or error never reaches a file', async () => {
  const { h } = fake('qwen', async (_r, id, hooks) => {
    hooks?.onStdout?.(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `OPENAI_API_KEY=${SENTINEL} and ${FILE_KEY}` }] } })}\n`);
    hooks?.onStdout?.(`Authorization: Bearer ${FILE_KEY}ABCDEFGHIJKLMNOP\n`);
    hooks?.onSettle?.({ termination: 'exit', exitCode: 1 });
    return response(id, { success: false, result: `leak ${SENTINEL}`, error: `failed with ${FILE_KEY}` });
  });
  await withRunRecording(h).execute(req({ prompt: `use key ${SENTINEL} or ${FILE_KEY} please` }), 'rec-secret');
  await drain();

  const dir = path.join(harnessRunsRoot(), 'rec-secret');
  for (const f of [path.join(dir, 'stdout.log'), path.join(dir, 'prompt.txt'), runIndexFile()]) {
    const bytes = fs.readFileSync(f, 'utf8');
    assert.equal(bytes.includes('SENTINEL'), false, `${path.basename(f)} must not hold a key`);
  }
  const r = getRun('rec-secret')!;
  assert.match(r.promptPreview, /\[REDACTED\]/);
});

test('observers that throw change neither the run nor its record', async () => {
  let inner: AgentExecuteResponse | undefined;
  const { h } = fake('qwen', async (_r, id, hooks) => {
    hooks?.onResolved?.({ model: 'm', profileName: 'gw', baseUrl: 'https://gw.example/v1', cwd: '/w', maxTurnsEnforced: true });
    hooks?.onSpawn?.({ pid: 7 });
    hooks?.onStdout?.('{"type":"result","subtype":"success","result":"ok"}\n');
    hooks?.onSettle?.({ termination: 'exit', exitCode: 0 });
    inner = response(id);
    return inner;
  });
  const boom = () => { throw new Error('observer bug'); };
  const res = await withRunRecording(h).execute(req(), 'rec-throwing-observer', {
    onResolved: boom, onSpawn: boom, onStdout: boom, onSettle: boom,
  });
  assert.equal(res, inner);
  assert.equal(getRun('rec-throwing-observer')!.status, 'succeeded');
});

test('outer hooks still see every event', async () => {
  const seen: string[] = [];
  const { h } = fake('qwen', async (_r, id, hooks) => {
    hooks?.onResolved?.({ model: 'm', profileName: 'gw', baseUrl: 'https://gw.example/v1', cwd: '/w', maxTurnsEnforced: true });
    hooks?.onSpawn?.({ pid: 7 });
    hooks?.onStdout?.('x\n');
    hooks?.onSettle?.({ termination: 'exit', exitCode: 0 });
    return response(id);
  });
  await withRunRecording(h).execute(req(), 'rec-outer-hooks', {
    onResolved: () => seen.push('resolved'),
    onSpawn: () => seen.push('spawn'),
    onStdout: () => seen.push('stdout'),
    onSettle: () => seen.push('settle'),
  });
  assert.deepEqual(seen, ['resolved', 'spawn', 'stdout', 'settle']);
});

test('the capture marks an over-long line and stops at its byte cap, without touching the run', async () => {
  const big = 'x'.repeat(1024 * 1024 + 10);
  const chunk = `{"pad":"${'y'.repeat(900 * 1024)}"}\n`;
  let inner: AgentExecuteResponse | undefined;
  const { h } = fake('qwen', async (_r, id, hooks) => {
    hooks?.onStdout?.(big.slice(0, 600_000));
    hooks?.onStdout?.(`${big.slice(600_000)}\n`);
    for (let i = 0; i < 10; i++) hooks?.onStdout?.(chunk);
    hooks?.onSettle?.({ termination: 'exit', exitCode: 0 });
    inner = response(id);
    return inner;
  });
  const res = await withRunRecording(h).execute(req(), 'rec-big');
  assert.equal(res, inner);

  const r = getRun('rec-big')!;
  assert.equal(r.capture?.truncated, true);
  assert.ok(r.capture!.bytes <= 8 * 1024 * 1024);
  const firstLine = fs.readFileSync(path.join(harnessRunsRoot(), 'rec-big', 'stdout.log'), 'utf8').split('\n')[0];
  assert.match(firstLine, /\t\{"_lmTruncatedLine":true,"bytes":1048586\}$/);
});

test('a read-only data dir does not change the result', { skip: process.getuid?.() === 0 ? 'root ignores permissions' : false }, async () => {
  const ro = freshDataDir();
  fs.chmodSync(ro, 0o500);
  try {
    let inner: AgentExecuteResponse | undefined;
    const { h } = fake('qwen', async (_r, id, hooks) => {
      hooks?.onResolved?.({ model: 'm', profileName: 'gw', baseUrl: 'https://gw.example/v1', cwd: '/w', maxTurnsEnforced: true });
      hooks?.onStdout?.('{"type":"result"}\n');
      hooks?.onSettle?.({ termination: 'exit', exitCode: 0 });
      inner = response(id);
      return inner;
    });
    const res = await withRunRecording(h).execute(req(), 'rec-readonly');
    assert.equal(res, inner);
    assert.equal(res.success, true);
    assert.equal(isRunInFlight('rec-readonly'), false);
  } finally {
    fs.chmodSync(ro, 0o700);
    freshDataDir();
  }
});

test('withRunRecording is idempotent and keeps the harness identity fields', () => {
  const { h } = fake('qwen', async (_r, id) => response(id), true);
  h.probe = async () => ({ available: true, version: '1.0.0' });
  const once = withRunRecording(h);
  assert.equal(withRunRecording(once), once);
  assert.equal(once.id, 'qwen');
  assert.equal(once.displayName, 'Fake qwen');
  assert.equal(once.capabilities, h.capabilities);
  assert.equal(once.probe, h.probe);
  assert.equal(typeof once.abort, 'function');
});

test('a harness with no abort gets no abort — recording must not make it look abortable', () => {
  const { h } = fake('noabort', async (_r, id) => response(id), false);
  const outer = withRunRecording(h);
  assert.equal(outer.abort, undefined);
  assert.equal('abort' in outer, false);
});
