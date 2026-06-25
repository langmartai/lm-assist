import { test } from 'node:test';
import assert from 'node:assert';
import { decideSupervisor, runSupervisorTick, discoverNewCse, isDriveDue } from '../mission/mission-controller';
import type { SupervisorDeps } from '../mission/mission-controller';
import type { ControllerSession } from '../mission/mission-store';

// ---------------------------------------------------------------------------
// pure decideSupervisor — decision table (updated for driveDue)
// ---------------------------------------------------------------------------

test('decideSupervisor: not monitor -> teardown (regardless of live/driveDue)', () => {
  assert.equal(decideSupervisor({ isMonitor: false, live: false, driveDue: false }).action, 'teardown');
  assert.equal(decideSupervisor({ isMonitor: false, live: true, driveDue: true }).action, 'teardown');
});

// ---------------------------------------------------------------------------
// pure isDriveDue — active vs idle cadence
// ---------------------------------------------------------------------------
const T0 = 1_000_000_000_000;
test('isDriveDue: idle (0 missions), 6min < idle=15 -> not due', () => {
  assert.equal(isDriveDue({ lastDriveAt: T0 - 6 * 60_000, now: T0, activeCount: 0, activeMin: 5, idleMin: 15 }), false);
});
test('isDriveDue: active (1 mission), 6min >= active=5 -> due', () => {
  assert.equal(isDriveDue({ lastDriveAt: T0 - 6 * 60_000, now: T0, activeCount: 1, activeMin: 5, idleMin: 15 }), true);
});
test('isDriveDue: idle, 16min >= idle=15 -> due', () => {
  assert.equal(isDriveDue({ lastDriveAt: T0 - 16 * 60_000, now: T0, activeCount: 0, activeMin: 5, idleMin: 15 }), true);
});
test('isDriveDue: never driven -> due regardless of count', () => {
  assert.equal(isDriveDue({ lastDriveAt: null, now: T0, activeCount: 0, activeMin: 5, idleMin: 15 }), true);
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

test('runSupervisorTick: monitor + STALE existing cs + !live -> tears down old controller BEFORE launching', async () => {
  const order: string[] = [];
  const deps = makeStubDeps({
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'gw1' }),
    getControllerSession: async () => cs,           // a prior controller record exists
    isLive: () => false,                            // but it's deemed not live → relaunch
    teardown: async (_cs) => { order.push('teardown'); },
    launch: async () => { order.push('launch'); return cs; },
  });
  const r = await runSupervisorTick(deps);
  assert.equal(r.action, 'launch');
  // The stale controller MUST be torn down before the new one launches — else duplicates pile up
  // every tick (the proliferation bug).
  assert.deepEqual(order, ['teardown', 'launch']);
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

// ---------------------------------------------------------------------------
// Wave 4 — change-detection engagement (runSupervisorTick with engage deps)
// ---------------------------------------------------------------------------
const liveCs: ControllerSession = { node: 'gw1', sessionId: 'session_ctrl', cse: null, tmux: 'lm-ctrl', startedAt: 1000 };

function engageDeps(over: Partial<SupervisorDeps>): SupervisorDeps {
  return makeStubDeps({
    getControllerSession: async () => liveCs,
    isLive: () => true,
    safetyIntervalMin: 45,
    listActiveForEngage: async () => [],
    readSignal: async () => ({ alive: true, gated: false, cursor: 0, newLines: [] }),
    getEngagement: async () => ({ lastEngagedAt: NOW - 60_000, lastActiveIds: [], seen: {} }),
    putEngagement: async () => {},
    setInterim: async () => {},
    ...over,
  });
}
const mkM = (id: string): any => ({ id, status: 'active' });

test('engage: 0 active missions, nothing changed, within safety → NOT drive (token-saving)', async () => {
  const deps = engageDeps({});
  const r = await runSupervisorTick(deps);
  assert.notEqual(r.action, 'drive');
  assert.equal(r.action, 'idle');
});

test('engage: a material change (liveness drop) → drive + lastEngagedAt stamped', async () => {
  let saved: any = null;
  const deps = engageDeps({
    listActiveForEngage: async () => [mkM('m1')],
    getEngagement: async () => ({ lastEngagedAt: NOW - 60_000, lastActiveIds: ['m1'], seen: { m1: { alive: true, gated: false, cursor: 3 } } }),
    readSignal: async () => ({ alive: false, gated: false, cursor: 3, newLines: [] }),
    putEngagement: async (s) => { saved = s; },
  });
  const r = await runSupervisorTick(deps);
  assert.equal(r.action, 'drive');
  assert.equal(saved.lastEngagedAt, NOW, 'lastEngagedAt stamped to now on engage');
  assert.deepEqual(saved.lastActiveIds, ['m1']);
});

test('engage: interim-only progress → NOT drive but setInterim called with the latest line', async () => {
  let interim: any = null;
  const deps = engageDeps({
    listActiveForEngage: async () => [mkM('m1')],
    getEngagement: async () => ({ lastEngagedAt: NOW - 60_000, lastActiveIds: ['m1'], seen: { m1: { alive: true, gated: false, cursor: 3 } } }),
    readSignal: async () => ({ alive: true, gated: false, cursor: 5, newLines: ['building', 'running tests'] }),
    setInterim: async (_id, x) => { interim = x; },
  });
  const r = await runSupervisorTick(deps);
  assert.notEqual(r.action, 'drive');
  assert.equal(interim?.text, 'running tests');
});

test('engage: a NEW mission (active-set changed) → drive', async () => {
  const deps = engageDeps({
    listActiveForEngage: async () => [mkM('m1'), mkM('m2')],
    getEngagement: async () => ({ lastEngagedAt: NOW - 60_000, lastActiveIds: ['m1'], seen: { m1: { alive: true, gated: false, cursor: 0 } } }),
    readSignal: async (m: any) => ({ alive: true, gated: false, cursor: 0, newLines: [] }),
  });
  const r = await runSupervisorTick(deps);
  assert.equal(r.action, 'drive');
});
