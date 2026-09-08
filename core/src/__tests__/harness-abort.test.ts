import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';

/**
 * Aborting a harness run must be HONEST.
 *
 * The defect these tests pin down: the background wrapper's abort was
 * `() => { running = false; }`. It stopped the bookkeeping and left the child
 * process alive, so `POST /agent/execution/:id/abort` answered `success: true`
 * while a gateway agent kept running, kept editing files and kept spending
 * tokens. A false "it stopped" is worse than an error, because the caller has no
 * reason to look again.
 *
 * Two properties are therefore tested separately:
 *   1. the DECISION — a harness that did not kill anything must not yield success;
 *   2. the MECHANISM — the signal really does end the whole process group.
 */

import { abortHarnessRun } from '../harness/abort';
import { createQwenHarness, QWEN_ID } from '../harness/qwen';
import { terminateRun } from '../harness/process';
import { getCapabilities } from '../harness/registry';
import type { AgentHarness, HarnessCapabilities } from '../harness/types';

const CAPS: HarnessCapabilities = {
  cost: 'unavailable',
  sessionResume: false,
  mcp: false,
  permissionBroker: false,
  durableBackground: false,
  usesProviderProfile: true,
  abortable: false,
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Wait for a pid to disappear; group signals are not ordered against reaping. */
const waitGone = async (pid: number): Promise<void> => {
  for (let i = 0; i < 60 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
};

/** Read the grandchild pid the fixture echoes on stdout. */
const readPid = (child: ReturnType<typeof spawn>): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', (d) => {
      buf += d.toString();
      const n = parseInt(buf.trim(), 10);
      if (Number.isFinite(n) && buf.includes('\n')) resolve(n);
    });
    child.on('error', reject);
    setTimeout(() => reject(new Error('grandchild pid never arrived')), 5000).unref();
  });

const fakeHarness = (over: Partial<AgentHarness> = {}): AgentHarness =>
  ({
    id: 'fake',
    displayName: 'Fake',
    capabilities: { ...CAPS },
    execute: async () => {
      throw new Error('not used');
    },
    ...over,
  }) as AgentHarness;

test('a harness with no abort primitive must NOT report a successful abort', async () => {
  const outcome = await abortHarnessRun(fakeHarness(), 'exec-1', false);

  assert.equal(outcome.success, false, 'reporting success here is the original defect');
  assert.match((outcome as { reason: string }).reason, /still going/i, 'the caller must learn the work continues');
  assert.match((outcome as { reason: string }).reason, /fake/, 'the harness must be named');
});

test('a harness that really signalled reports success', async () => {
  const calls: string[] = [];
  const h = fakeHarness({
    capabilities: { ...CAPS, abortable: true },
    abort: (id: string) => {
      calls.push(id);
      return true;
    },
  });

  const outcome = await abortHarnessRun(h, 'exec-2', false);
  assert.equal(outcome.success, true);
  assert.deepEqual(calls, ['exec-2'], 'the harness must be asked about the right execution');
});

test('an async abort is awaited, not assumed', async () => {
  const h = fakeHarness({
    capabilities: { ...CAPS, abortable: true },
    abort: async () => false,
  });

  const outcome = await abortHarnessRun(h, 'exec-3', false);
  assert.equal(outcome.success, false, 'a Promise<false> must not be read as truthy');
});

test('"nothing was killed" is reported differently from "it had already finished"', async () => {
  const h = fakeHarness({ capabilities: { ...CAPS, abortable: true }, abort: () => false });

  const live = await abortHarnessRun(h, 'exec-4', false);
  const done = await abortHarnessRun(h, 'exec-4', true);

  assert.equal(live.success, false);
  assert.equal(done.success, false);
  assert.match((done as { reason: string }).reason, /already finished/i);
  assert.match((live as { reason: string }).reason, /no live process/i);
  assert.notEqual(
    (live as { reason: string }).reason,
    (done as { reason: string }).reason,
    'the two situations need different actions, so they must not share one message',
  );
});

test('a throwing abort is a failure, not a success', async () => {
  const h = fakeHarness({
    capabilities: { ...CAPS, abortable: true },
    abort: () => {
      throw new Error('kill(2) said ESRCH');
    },
  });

  const outcome = await abortHarnessRun(h, 'exec-5', false);
  assert.equal(outcome.success, false);
  assert.match((outcome as { reason: string }).reason, /ESRCH/, 'the underlying failure must survive');
});

test('every registered harness that claims abortable actually exposes abort', () => {
  const qwen = createQwenHarness();
  const caps = qwen.capabilities;

  assert.equal(caps.abortable, true);
  assert.equal(typeof qwen.abort, 'function', 'claiming abortable without an abort() is a lie in the capability table');
  assert.equal(getCapabilities('sdk')!.abortable, true, 'the builtins must declare the field too');
  assert.equal(getCapabilities('tmux')!.abortable, true);
  assert.equal(QWEN_ID, 'qwen');
});

test('aborting an execution the harness never started returns false', () => {
  const qwen = createQwenHarness();
  assert.equal(qwen.abort!('never-ran'), false, 'an unknown id must not claim a kill');
});

test('terminateRun ends the whole process group, not just the direct child', async () => {
  // qwen forks (measured: `qwen` spawns a second node process) and, under yolo,
  // runs shell commands of its own. Signalling only the direct child would leave
  // that work running while the abort looked clean.
  const child = spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
  });
  const grandchildPid = await readPid(child);

  assert.ok(alive(grandchildPid), 'the fixture must actually have a live grandchild');

  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  assert.equal(terminateRun(child), true, 'a live run must report that it was signalled');
  await exited;
  await waitGone(grandchildPid);

  assert.equal(alive(grandchildPid), false, 'the grandchild must die with the group');
  assert.equal(terminateRun(child), false, 'a run that has already exited was not killed by this call');
});

test('a group that IGNORES SIGTERM is escalated to SIGKILL', async () => {
  // 🔴 This is the real qwen behaviour, and the first version of terminateRun got
  // it wrong: the forked child ignores SIGTERM and outlives its parent, so an
  // escalation timer cancelled on the parent's exit never fires and the run
  // survives an abort that reported success. `trap "" TERM` reproduces it — an
  // ignored disposition is inherited across fork/exec, so the whole group is deaf
  // to SIGTERM and only the SIGKILL escalation can end it.
  const child = spawn('sh', ['-c', 'trap "" TERM; sleep 30 & echo $!; wait'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
  });
  const grandchildPid = await readPid(child);

  assert.equal(terminateRun(child, 200), true);

  // It must still be alive right after the SIGTERM — otherwise the fixture is not
  // actually SIGTERM-proof and this test proves nothing about escalation.
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(alive(grandchildPid), 'fixture must survive SIGTERM, else the test is vacuous');

  await waitGone(grandchildPid);
  assert.equal(alive(grandchildPid), false, 'the escalation must reach a process that ignored SIGTERM');
});
