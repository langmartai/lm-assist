// Restart-adopt semantics: an lm-assist Core restart must never kill or orphan a live
// mission controller — the supervisor ADOPTS it and fires one resume drive.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  runSupervisorTick, pickStrayControllers, CONTROLLER_ADOPT_RESUME_DIRECTIVE,
  type SupervisorDeps,
} from '../mission/mission-controller';

// lastDriveAt = 1 min before `now` so the fallback time-gate is NOT due (interval 5 min) —
// keeps adopt/sweep assertions from colliding with an incidental 'drive' action.
const CS = { node: 'n1', sessionId: 'uuid-1', cse: null, tmux: 'lmcc-orig', startedAt: 1, lastDriveAt: 9 * 60_000 } as any;

function baseDeps(over: Partial<SupervisorDeps>): SupervisorDeps {
  return {
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'n1' }),
    getControllerSession: async () => CS,
    putControllerSession: async () => {},
    isLive: () => true,
    launch: async () => { throw new Error('launch must not be called'); },
    drive: async () => {},
    teardown: async () => { throw new Error('teardown must not be called'); },
    driveIntervalMin: 5,
    now: 10 * 60_000,
    ...over,
  } as SupervisorDeps;
}

test('pickStrayControllers: only non-recorded lmcc-*', () => {
  assert.deepEqual(
    pickStrayControllers(['lmcc-orig', 'lmcc-dup1', 'lmt-x', 'ccr-y', 'lmcc-dup2'], 'lmcc-orig'),
    ['lmcc-dup1', 'lmcc-dup2'],
  );
  assert.deepEqual(pickStrayControllers(['lmcc-a'], null), ['lmcc-a']);
  assert.deepEqual(pickStrayControllers([], 'lmcc-orig'), []);
});

test('boot-adopt: live recorded controller gets ONE resume drive, then normal ticks', async () => {
  let adopted = false;
  let cur: any = CS;
  const drives: string[] = [];
  const puts: any[] = [];
  const deps = baseDeps({
    getControllerSession: async () => cur,
    drive: async (_cs, d) => { drives.push(d ?? ''); },
    putControllerSession: async (c) => { puts.push(c); cur = c; },
    bootAdopt: { done: () => adopted, mark: () => { adopted = true; } },
  });
  const r1 = await runSupervisorTick(deps);
  assert.equal(r1.action, 'adopt-drive');
  assert.equal(drives.length, 1);
  assert.ok(drives[0].startsWith('⟦CORE RESTARTED — REATTACH⟧'));
  assert.equal(drives[0], CONTROLLER_ADOPT_RESUME_DIRECTIVE);
  assert.equal(puts[0].lastDriveAt, deps.now, 'adopt stamps lastDriveAt');
  // second tick: flag set → falls through to the normal gate (no engagement deps, not due) → idle
  const r2 = await runSupervisorTick(deps);
  assert.equal(r2.action, 'idle');
  assert.equal(drives.length, 1, 'no second adopt drive');
});

test('self-launched controller never gets the reattach drive (launch marks bootAdopt)', async () => {
  let adopted = false;
  let liveNow = false;
  const drives: string[] = [];
  const deps = baseDeps({
    getControllerSession: async () => (liveNow ? CS : null),
    isLive: () => liveNow,
    launch: async () => { liveNow = true; return CS; },
    teardown: async () => {},
    drive: async (_cs, d) => { drives.push(d ?? ''); },
    bootAdopt: { done: () => adopted, mark: () => { adopted = true; } },
  });
  const r1 = await runSupervisorTick(deps);
  assert.equal(r1.action, 'launch');
  assert.equal(adopted, true, 'launch marked bootAdopt');
  const r2 = await runSupervisorTick(deps);
  assert.notEqual(r2.action, 'adopt-drive');
  assert.ok(!drives.some((d) => d.startsWith('⟦CORE RESTARTED')), 'no reattach drive after self-launch');
});

test('TOCTOU: decide says launch but recorded controller is alive at act time → adopt, no kill', async () => {
  // First isLive read (gate) false, second (pre-launch re-verify) true — e.g. transient tmux blip.
  let reads = 0;
  const deps = baseDeps({
    isLive: () => { reads += 1; return reads >= 2; },
    launch: async () => { throw new Error('must not launch'); },
    teardown: async () => { throw new Error('must not teardown'); },
  });
  const r = await runSupervisorTick(deps);
  assert.equal(r.action, 'adopt');
  assert.equal(r.controllerSession, CS);
});

test('stray sweep: kills every lmcc-* except the recorded one, never the record itself', async () => {
  const killed: string[] = [];
  const deps = baseDeps({
    listTmuxSessions: async () => ['lmcc-orig', 'lmcc-dup1', 'lmt-worker', 'lmcc-dup2'],
    killStrayTmux: async (n) => { killed.push(n); },
  });
  const r = await runSupervisorTick(deps);
  assert.equal(r.action, 'idle');
  assert.deepEqual(killed.sort(), ['lmcc-dup1', 'lmcc-dup2']);
});

test('sweep failures never sink the tick', async () => {
  const deps = baseDeps({
    listTmuxSessions: async () => { throw new Error('tmux gone'); },
    killStrayTmux: async () => { throw new Error('nope'); },
  });
  const r = await runSupervisorTick(deps);
  assert.equal(r.action, 'idle');
});

test('non-leader: no sweep, no adopt-drive (teardown path unchanged)', async () => {
  const killed: string[] = [];
  let torn = false;
  const deps = baseDeps({
    amMonitor: async () => ({ isMonitor: false, monitorNodeId: 'other' }),
    teardown: async () => { torn = true; },
    listTmuxSessions: async () => ['lmcc-orig', 'lmcc-dup1'],
    killStrayTmux: async (n) => { killed.push(n); },
    bootAdopt: { done: () => false, mark: () => {} },
  });
  const r = await runSupervisorTick(deps);
  assert.equal(r.action, 'teardown');
  assert.equal(torn, true);
  assert.deepEqual(killed, [], 'sweep is leader-only');
});
