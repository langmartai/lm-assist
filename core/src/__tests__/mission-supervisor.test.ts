import { test } from 'node:test';
import assert from 'node:assert';
import { decideSupervisor, runSupervisorTick } from '../mission/mission-controller';
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
