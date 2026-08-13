// Restart-adopt semantics: an lm-assist Core restart must never kill or orphan a live
// mission controller — the supervisor ADOPTS it and fires one resume drive.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  runSupervisorTick, pickStrayControllers, CONTROLLER_ADOPT_RESUME_DIRECTIVE,
  controllerTmuxPrefix,
  _resetNotMonitorStreak,
  type SupervisorDeps,
} from '../mission/mission-controller';

// The sweep is scoped to THIS process's own controller namespace (dev vs prod — see
// controllerTmuxPrefix), so the fixtures are built from it rather than hard-coded 'lmcc'.
// OTHER is the other mode's prefix: its windows belong to the other Core and are off-limits.
const P = controllerTmuxPrefix();
const OTHER = controllerTmuxPrefix(P === 'lmcc');

// lastDriveAt = 1 min before `now` so the fallback time-gate is NOT due (interval 5 min) —
// keeps adopt/sweep assertions from colliding with an incidental 'drive' action.
const CS = { node: 'n1', sessionId: 'uuid-1', cse: null, tmux: `${P}-orig`, startedAt: 1, lastDriveAt: 9 * 60_000 } as any;

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

test('pickStrayControllers: only non-recorded controllers of THIS mode', () => {
  assert.deepEqual(
    pickStrayControllers([`${P}-orig`, `${P}-dup1`, 'lmt-x', 'ccr-y', `${OTHER}-theirs`, `${P}-dup2`], `${P}-orig`),
    [`${P}-dup1`, `${P}-dup2`],
  );
  assert.deepEqual(pickStrayControllers([`${P}-a`], null), [`${P}-a`]);
  assert.deepEqual(pickStrayControllers([], `${P}-orig`), []);
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

test('stray sweep: kills every own-mode duplicate, never the record itself', async () => {
  const killed: string[] = [];
  const deps = baseDeps({
    listTmuxSessions: async () => [`${P}-orig`, `${P}-dup1`, 'lmt-worker', `${P}-dup2`],
    killStrayTmux: async (n) => { killed.push(n); },
  });
  const r = await runSupervisorTick(deps);
  assert.equal(r.action, 'idle');
  assert.deepEqual(killed.sort(), [`${P}-dup1`, `${P}-dup2`]);
});

// The 2026-08-12→13 storm: dev's sweep killed prod's controller (and vice versa), so each
// Core's isLive() went false and it relaunched — 136 launches in 8 hours, every one of them
// re-resuming the SAME session. The other mode's window is not ours to touch.
test('stray sweep: never touches the OTHER mode\'s controller', async () => {
  const killed: string[] = [];
  const deps = baseDeps({
    listTmuxSessions: async () => [`${P}-orig`, `${OTHER}-theirs`, `${OTHER}-theirs-2`],
    killStrayTmux: async (n) => { killed.push(n); },
  });
  await runSupervisorTick(deps);
  assert.deepEqual(killed, []);
});

test('sweep failures never sink the tick', async () => {
  const deps = baseDeps({
    listTmuxSessions: async () => { throw new Error('tmux gone'); },
    killStrayTmux: async () => { throw new Error('nope'); },
  });
  const r = await runSupervisorTick(deps);
  assert.equal(r.action, 'idle');
});

test('non-leader: no sweep, no adopt-drive; teardown only after the anti-flap streak', async () => {
  const killed: string[] = [];
  let torn = false;
  const deps = baseDeps({
    amMonitor: async () => ({ isMonitor: false, monitorNodeId: 'other' }),
    teardown: async () => { torn = true; },
    listTmuxSessions: async () => [`${P}-orig`, `${P}-dup1`],
    killStrayTmux: async (n) => { killed.push(n); },
    bootAdopt: { done: () => false, mark: () => {} },
  });
  // One flappy not-monitor answer must NOT tear down (decideSupervisor requires a
  // ≥2-tick confident streak); the second consecutive tick does.
  _resetNotMonitorStreak();
  const first = await runSupervisorTick(deps);
  assert.equal(first.action, 'idle', 'single not-monitor tick is anti-flap idle');
  assert.equal(torn, false);
  const second = await runSupervisorTick(deps);
  assert.equal(second.action, 'teardown');
  assert.equal(torn, true);
  assert.deepEqual(killed, [], 'sweep is leader-only');
});
