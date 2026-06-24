import { test } from 'node:test';
import assert from 'node:assert';
import { decideSupervisor, runSupervisorTick, discoverNewCse } from '../mission/mission-controller';
import type { SupervisorDeps } from '../mission/mission-controller';
import type { ControllerSession } from '../mission/mission-store';

// ---------------------------------------------------------------------------
// pure decideSupervisor — decision table
// ---------------------------------------------------------------------------

test('decideSupervisor: not monitor -> teardown', () => {
  const d = decideSupervisor({ isMonitor: false, live: false });
  assert.equal(d.action, 'teardown');
});

test('decideSupervisor: monitor + not live -> launch', () => {
  const d = decideSupervisor({ isMonitor: true, live: false });
  assert.equal(d.action, 'launch');
});

test('decideSupervisor: monitor + live -> drive', () => {
  const d = decideSupervisor({ isMonitor: true, live: true });
  assert.equal(d.action, 'drive');
});

// ---------------------------------------------------------------------------
// runSupervisorTick with stub deps
// ---------------------------------------------------------------------------

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

test('runSupervisorTick: monitor + no live session -> calls launch + putControllerSession', async () => {
  let launched = false;
  let persisted: ControllerSession | null = null;
  const deps = makeStubDeps({
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'gw1' }),
    getControllerSession: async () => null,
    isLive: () => false,
    launch: async () => { launched = true; return cs; },
    putControllerSession: async (x) => { persisted = x; },
  });
  await runSupervisorTick(deps);
  assert.ok(launched, 'launch should be called when no live session');
  assert.ok(persisted !== null, 'putControllerSession should persist the new cs');
  assert.equal((persisted as ControllerSession).sessionId, 'session_ctrl');
});

test('runSupervisorTick: monitor + live session -> calls drive', async () => {
  let driven = false;
  const deps = makeStubDeps({
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'gw1' }),
    getControllerSession: async () => cs,
    isLive: (_cs) => true,
    drive: async (_cs) => { driven = true; },
  });
  await runSupervisorTick(deps);
  assert.ok(driven, 'drive should be called when live session exists');
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
