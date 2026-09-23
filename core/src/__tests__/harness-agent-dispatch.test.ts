import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * agent-api's harness dispatch and abort, with a FAKE registered harness — no
 * CLI and no Claude SDK run here (the fake SDK runner throws if reached).
 *
 * agent-api pulls in detached-runner, which computes ~/.lm-assist paths from
 * os.homedir() AT IMPORT TIME and recovers/cleans executions at construction.
 * So HOME is pointed at a temp dir BEFORE agent-api is first required, and it is
 * required lazily below — a static import would be hoisted above that and read
 * the operator's real background-executions.json.
 */

import { registerHarness } from '../harness/registry';
import { getRun, isRunInFlight } from '../harness/run-store';
import type { AgentHarness } from '../harness/types';
import type { AgentApi, AgentExecuteRequest, AgentExecuteResponse } from '../types/agent-api';

let base: string;
let api: AgentApi;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['HOME', 'LM_ASSIST_DATA_DIR', 'LM_ASSIST_PROD', 'LM_HARNESS_OPENCODE_DB'];

const calls = { execute: 0, abort: 0 };
const pending = new Map<string, (r: AgentExecuteResponse) => void>();

function response(executionId: string, over: Partial<AgentExecuteResponse> = {}): AgentExecuteResponse {
  return {
    success: true, result: 'ok', sessionId: '', executionId, durationMs: 1, durationApiMs: 0, numTurns: 1,
    totalCostUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalTokens: 2 },
    modelUsage: {}, runner: 'fakeh', ...over,
  };
}

/** Settles at once unless the prompt says "hold", in which case it waits for abort() or release(). */
const fakeHarness: AgentHarness = {
  id: 'fakeh',
  displayName: 'Fake Harness',
  capabilities: {
    cost: 'unavailable', sessionResume: false, mcp: false, permissionBroker: false,
    durableBackground: false, usesProviderProfile: false, abortable: true,
  },
  async execute(request, executionId, hooks) {
    calls.execute += 1;
    hooks?.onSpawn?.({ pid: 1 });
    if (request.prompt !== 'hold') {
      hooks?.onSettle?.({ termination: 'exit', exitCode: 0 });
      return response(executionId);
    }
    return new Promise((resolve) => pending.set(executionId, (r) => {
      hooks?.onSettle?.({ termination: 'exit', exitCode: null, signal: 'SIGTERM' });
      resolve(r);
    }));
  },
  abort(executionId) {
    calls.abort += 1;
    const settle = pending.get(executionId);
    if (!settle) return false;
    pending.delete(executionId);
    settle(response(executionId, { success: false, result: '', error: 'terminated by SIGTERM' }));
    return true;
  },
};

function release(executionId: string): void {
  const settle = pending.get(executionId);
  pending.delete(executionId);
  settle?.(response(executionId));
}

before(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.LM_ASSIST_PROD;
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dispatch-'));
  process.env.HOME = path.join(base, 'home');
  fs.mkdirSync(process.env.HOME);
  process.env.LM_ASSIST_DATA_DIR = path.join(base, 'data');
  process.env.LM_HARNESS_OPENCODE_DB = path.join(base, 'no-opencode', 'opencode.db');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createAgentApiImpl } = require('../api/agent-api') as typeof import('../api/agent-api');
  const sdkRunner = {
    kill: () => false,
    execute: async () => { throw new Error('the Claude SDK must never run for a harness request'); },
  };
  api = createAgentApiImpl({ sdkRunner: sdkRunner as any, sessionStore: {} as any, projectPath: base });
  registerHarness(fakeHarness);
});

after(() => {
  for (const id of [...pending.keys()]) release(id);
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(base, { recursive: true, force: true });
});

const req = (over: Partial<AgentExecuteRequest>): AgentExecuteRequest =>
  ({ prompt: 'go', runner: 'fakeh', cwd: '/work/p', ...over }) as AgentExecuteRequest;

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), `timed out waiting for ${what}`);
}

test('an invalid executionId is refused before the harness is called', async () => {
  const before = calls.execute;
  for (const background of [false, true]) {
    const res = await api.execute(req({ executionId: 'a.b/../c', background })) as AgentExecuteResponse;
    assert.equal(res.success, false);
    assert.equal(res.runner, 'fakeh');
    assert.match(res.error!, /^INVALID_EXECUTION_ID: /);
  }
  assert.equal(calls.execute, before);
});

test('a reused executionId is refused — foreground after a finished run, background while one is live', async () => {
  const done = await api.execute(req({ executionId: 'disp-dup' })) as AgentExecuteResponse;
  assert.equal(done.success, true);
  const before = calls.execute;
  const again = await api.execute(req({ executionId: 'disp-dup' })) as AgentExecuteResponse;
  assert.match(again.error!, /^DUPLICATE_EXECUTION_ID: /);

  const started = await api.execute(req({ executionId: 'disp-bg-dup', prompt: 'hold', background: true }));
  assert.equal((started as any).status, 'started');
  const clash = await api.execute(req({ executionId: 'disp-bg-dup', background: true })) as AgentExecuteResponse;
  assert.match(clash.error!, /^DUPLICATE_EXECUTION_ID: /);
  assert.equal(calls.execute, before + 1, 'only the first background run reached the harness');

  const status = await api.getExecution('disp-bg-dup');
  assert.equal(status?.isRunning, true, 'the live run\'s map entry was not overwritten');
  release('disp-bg-dup');
});

test('a background request for ANY runner cannot take over the id of a harness run in flight', async () => {
  const started = await api.execute(req({ executionId: 'disp-cross', prompt: 'hold', background: true }));
  assert.equal((started as any).status, 'started');
  const before = calls.execute;

  // No runner = the SDK background path, which used to overwrite the map entry unchecked.
  // (HOME is a temp dir here, so even a regression could not launch a real `claude`.)
  const sdk = await api.execute(req({ executionId: 'disp-cross', background: true, runner: undefined })) as AgentExecuteResponse;
  assert.equal(sdk.success, false);
  assert.match(sdk.error!, /^DUPLICATE_EXECUTION_ID: /);
  assert.equal(sdk.runner, 'sdk');
  assert.equal(calls.execute, before);

  // The live run's entry survived, so abort reaches the harness that owns the child.
  const abortsBefore = calls.abort;
  const out = await api.abort('disp-cross');
  assert.deepEqual(out, { success: true, sessionId: 'disp-cross' });
  assert.equal(calls.abort, abortsBefore + 1, 'the harness itself was asked to end its child');
});

test('a FOREGROUND harness run in flight blocks a background reuse of its id too', async () => {
  const p = api.execute(req({ executionId: 'disp-fg-cross', prompt: 'hold' }));
  await until(() => isRunInFlight('disp-fg-cross'), 'the run to be in flight');
  const clash = await api.execute(req({ executionId: 'disp-fg-cross', background: true, runner: undefined })) as AgentExecuteResponse;
  assert.match(clash.error!, /^DUPLICATE_EXECUTION_ID: /);
  release('disp-fg-cross');
  await p;
});

test('a FOREGROUND harness run can be aborted through the API, and is recorded as aborted', async () => {
  const p = api.execute(req({ executionId: 'disp-fg-1', prompt: 'hold' }));
  await until(() => isRunInFlight('disp-fg-1'), 'the run to be in flight');

  const abortsBefore = calls.abort;
  const out = await api.abort('disp-fg-1');
  assert.deepEqual(out, { success: true, sessionId: 'disp-fg-1' });
  assert.equal(calls.abort, abortsBefore + 1, 'the harness itself was asked to end its child');

  const res = await p as AgentExecuteResponse;
  assert.equal(res.success, false);
  const rec = getRun('disp-fg-1')!;
  assert.equal(rec.status, 'aborted');
  assert.ok(rec.abortRequestedAt);
  assert.equal(rec.background, false);
});

test('an id that is not live falls through to the SDK runner, and no harness is asked', async () => {
  const abortsBefore = calls.abort;
  assert.equal((await api.abort('never-existed')).success, false);
  assert.equal((await api.abort('disp-dup')).success, false, 'a finished run is not live');
  assert.equal(calls.abort, abortsBefore);
});

test('listExecutions items carry the runner and cwd', async () => {
  await api.execute(req({ executionId: 'disp-list', prompt: 'hold', background: true, cwd: '/work/listed' }));
  const items = await api.listExecutions();
  const item = items.find((e) => e.executionId === 'disp-list');
  assert.ok(item);
  assert.equal(item!.runner, 'fakeh');
  assert.equal(item!.cwd, '/work/listed');
  release('disp-list');
});
