import { test } from 'node:test';
import assert from 'node:assert';
import { decideSupervisor, runSupervisorTick, discoverNewCse } from '../mission/mission-controller';
import type { SupervisorDeps } from '../mission/mission-controller';
import type { ControllerSession } from '../mission/mission-store';

// ---------------------------------------------------------------------------
// pure decideSupervisor — decision table (updated for driveDue)
// ---------------------------------------------------------------------------

test('decideSupervisor: not monitor -> teardown (regardless of live/driveDue)', () => {
  assert.equal(decideSupervisor({ isMonitor: false, live: false, driveDue: false }).action, 'teardown');
  assert.equal(decideSupervisor({ isMonitor: false, live: true, driveDue: true }).action, 'teardown');
});

test('decideSupervisor: monitor + not live -> launch (regardless of driveDue)', () => {
  assert.equal(decideSupervisor({ isMonitor: true, live: false, driveDue: false }).action, 'launch');
  assert.equal(decideSupervisor({ isMonitor: true, live: false, driveDue: true }).action, 'launch');
});

test('decideSupervisor: monitor + live + driveDue -> drive', () => {
  const d = decideSupervisor({ isMonitor: true, live: true, driveDue: true });
  assert.equal(d.action, 'drive');
});

test('decideSupervisor: monitor + live + NOT driveDue -> idle', () => {
  const d = decideSupervisor({ isMonitor: true, live: true, driveDue: false });
  assert.equal(d.action, 'idle');
});

// ---------------------------------------------------------------------------
// runSupervisorTick with stub deps
// ---------------------------------------------------------------------------

const NOW = 1_000_000_000;
const DRIVE_INTERVAL_MIN = 5;

const cs: ControllerSession = { node: 'gw1', sessionId: 'session_ctrl', cse: null, tmux: 'lm-ctrl', startedAt: 1000 };

function makeStubDeps(overrides: Partial<SupervisorDeps>): SupervisorDeps {
  return {
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'gw1' }),
    getControllerSession: async () => null,
    putControllerSession: async (_cs) => {},
    isLive: (_cs) => false,
    launch: async () => cs,
    drive: async (_cs) => {},
    teardown: async (_cs) => {},
    driveIntervalMin: DRIVE_INTERVAL_MIN,
    now: NOW,
    ...overrides,
  };
}

test('runSupervisorTick: not monitor + existing cs -> calls teardown + clears', async () => {
  let tornDown = false;
  let cleared = false;
  const deps = makeStubDeps({
    amMonitor: async () => ({ isMonitor: false, monitorNodeId: 'gw2' }),
    getControllerSession: async () => cs,
    teardown: async (_cs) => { tornDown = true; },
    putControllerSession: async (x) => { if (x === null) cleared = true; },
  });
  await runSupervisorTick(deps);
  assert.ok(tornDown, 'teardown should be called when not monitor');
  assert.ok(cleared, 'putControllerSession(null) should be called after teardown');
});

test('runSupervisorTick: monitor + no live session -> calls launch + putControllerSession (lastDriveAt absent)', async () => {
  let launched = false;
  let persisted: ControllerSession | null = null;
  const deps = makeStubDeps({
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'gw1' }),
    getControllerSession: async () => null,
    isLive: () => false,
    launch: async () => { launched = true; return cs; },
    putControllerSession: async (x) => { persisted = x; },
  });
  const r = await runSupervisorTick(deps);
  assert.ok(launched, 'launch should be called when no live session');
  assert.ok(persisted !== null, 'putControllerSession should persist the new cs');
  assert.equal((persisted as ControllerSession).sessionId, 'session_ctrl');
  // lastDriveAt must NOT be set on launch — next tick drives immediately
  assert.equal((persisted as ControllerSession).lastDriveAt, undefined);
  assert.equal(r.action, 'launch');
});

test('runSupervisorTick: monitor + live + driveDue -> calls drive + stamps lastDriveAt', async () => {
  let driven = false;
  let persisted: ControllerSession | null = null;
  // lastDriveAt is old enough → driveDue = true
  const staleCs: ControllerSession = { ...cs, lastDriveAt: NOW - DRIVE_INTERVAL_MIN * 60_000 - 1 };
  const deps = makeStubDeps({
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'gw1' }),
    getControllerSession: async () => staleCs,
    isLive: (_cs) => true,
    drive: async (_cs) => { driven = true; },
    putControllerSession: async (x) => { persisted = x; },
  });
  const r = await runSupervisorTick(deps);
  assert.ok(driven, 'drive should be called when live and driveDue');
  assert.equal(r.action, 'drive');
  assert.ok(persisted !== null, 'putControllerSession called after drive');
  assert.equal((persisted as ControllerSession).lastDriveAt, NOW, 'lastDriveAt stamped with now');
});

test('runSupervisorTick: monitor + live + NOT driveDue -> idle (no drive)', async () => {
  let driven = false;
  let persisted: ControllerSession | null = null;
  // lastDriveAt is recent → driveDue = false
  const freshCs: ControllerSession = { ...cs, lastDriveAt: NOW - 1000 }; // 1s ago << 5 min
  const deps = makeStubDeps({
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'gw1' }),
    getControllerSession: async () => freshCs,
    isLive: (_cs) => true,
    drive: async (_cs) => { driven = true; },
    putControllerSession: async (x) => { persisted = x; },
  });
  const r = await runSupervisorTick(deps);
  assert.ok(!driven, 'drive must NOT be called when not driveDue');
  assert.equal(r.action, 'idle');
  assert.ok(persisted === null, 'putControllerSession should NOT be called on idle');
});

test('runSupervisorTick: monitor + live + no lastDriveAt -> driveDue=true -> drive', async () => {
  let driven = false;
  // cs has no lastDriveAt → always due
  const noDriveCs: ControllerSession = { node: 'gw1', sessionId: 'session_ctrl', cse: null, tmux: 'lm-ctrl', startedAt: 1000 };
  const deps = makeStubDeps({
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'gw1' }),
    getControllerSession: async () => noDriveCs,
    isLive: (_cs) => true,
    drive: async (_cs) => { driven = true; },
  });
  const r = await runSupervisorTick(deps);
  assert.ok(driven, 'drive should fire when lastDriveAt is absent');
  assert.equal(r.action, 'drive');
});

test('runSupervisorTick: monitor + NOT live (dead leader session) -> launch regardless of driveDue', async () => {
  // Simulates the failover: leader changed, controllerSession exists but isLive=false
  let launched = false;
  const deadCs: ControllerSession = { ...cs, lastDriveAt: NOW - 10_000 }; // recent, but dead
  const deps = makeStubDeps({
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'gw1' }),
    getControllerSession: async () => deadCs,
    isLive: (_cs) => false,
    launch: async () => { launched = true; return cs; },
    driveIntervalMin: DRIVE_INTERVAL_MIN,
    now: NOW,
  });
  const r = await runSupervisorTick(deps);
  assert.ok(launched, 'should launch when not live, even if driveDue would be false');
  assert.equal(r.action, 'launch');
});

// ---------------------------------------------------------------------------
// Task 3 (Wave 2.2): discoverNewCse — pure poll helper
// ---------------------------------------------------------------------------

test('discoverNewCse: returns new sid when it appears in first snapshot', () => {
  const baseline = ['cse_a', 'cse_b'];
  const snapshots = [
    [{ sid: 'cse_a' }, { sid: 'cse_b' }, { sid: 'cse_new' }],
  ];
  const hit = discoverNewCse(baseline, snapshots);
  assert.ok(hit !== null, 'should find the new cse');
  assert.equal(hit!.sid, 'cse_new');
});

test('discoverNewCse: returns null when no new sid appears in any snapshot', () => {
  const baseline = ['cse_a', 'cse_b'];
  const snapshots = [
    [{ sid: 'cse_a' }, { sid: 'cse_b' }],
    [{ sid: 'cse_a' }, { sid: 'cse_b' }],
  ];
  const hit = discoverNewCse(baseline, snapshots);
  assert.equal(hit, null, 'should return null when no new cse');
});

test('discoverNewCse: finds new sid in a later snapshot (simulates delayed registration)', () => {
  const baseline = ['cse_a'];
  const snapshots = [
    [{ sid: 'cse_a' }],                        // poll 1: not yet registered
    [{ sid: 'cse_a' }],                        // poll 2: still nothing
    [{ sid: 'cse_a' }, { sid: 'cse_ctrl' }],   // poll 3: new cse appears
  ];
  const hit = discoverNewCse(baseline, snapshots);
  assert.ok(hit !== null, 'should find cse that appears in a later snapshot');
  assert.equal(hit!.sid, 'cse_ctrl');
});

test('discoverNewCse: uses custom pickFn', () => {
  const baseline = ['cse_x'];
  const snapshots = [[{ sid: 'cse_x' }, { sid: 'cse_y' }, { sid: 'cse_z' }]];
  // Custom pickFn that only returns sids ending in 'z'
  const customPick = (_base: string[], cur: Array<{ sid: string }>) =>
    cur.find((s) => s.sid.endsWith('z')) ?? null;
  const hit = discoverNewCse(baseline, snapshots, customPick as any);
  assert.ok(hit !== null);
  assert.equal(hit!.sid, 'cse_z');
});

test('discoverNewCse: empty snapshots returns null', () => {
  const hit = discoverNewCse(['cse_a'], []);
  assert.equal(hit, null);
});
