// Two supervisor behaviours that the 2026-09-05 incident on 107 exposed:
//
// 1. The controller-history "teardown" reason was hard-coded to "not monitor (confident,
//    debounced)" for EVERY teardown — including the launch path's defensive teardown of a
//    controller that merely read as not-live. The journal said "not monitor" while the tick
//    said isMonitor:true; the real reason has to travel with the call.
// 2. When the supervisor ADOPTS a live controller (Core restart), it must hand the recorded
//    terminal handle back to the terminal backend — on Windows that is the tab RuntimeId the
//    previous Core learned at launch, and without it a drive to a busy controller fails with
//    "could not locate window/tab".
import { test } from 'node:test';
import assert from 'node:assert';
import { runSupervisorTick, _resetNotMonitorStreak, type SupervisorDeps } from '../mission/mission-controller';

const CS = { node: 'n1', sessionId: 'uuid-1', cse: null, tmux: '42.7933118.4.10118', startedAt: 1, lastDriveAt: 9 * 60_000 } as any;

function baseDeps(over: Partial<SupervisorDeps>): SupervisorDeps {
  return {
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'n1' }),
    getControllerSession: async () => CS,
    putControllerSession: async () => {},
    isLive: () => true,
    launch: async () => ({ ...CS, sessionId: 'uuid-2' }),
    drive: async () => {},
    teardown: async () => {},
    driveIntervalMin: 5,
    now: 10 * 60_000,
    ...over,
  } as SupervisorDeps;
}

test('launch-path teardown carries the REAL reason (not live), not "not monitor"', async () => {
  _resetNotMonitorStreak();
  let seen: string | undefined = 'unset';
  const r = await runSupervisorTick(baseDeps({
    isLive: () => false,
    teardown: async (_cs, reason) => { seen = reason; },
  }));
  assert.equal(r.action, 'launch');
  assert.match(String(seen), /not live/i);
  assert.doesNotMatch(String(seen), /not monitor/i);
});

test('not-monitor teardown says so', async () => {
  _resetNotMonitorStreak();
  let seen: string | undefined;
  const deps = baseDeps({
    amMonitor: async () => ({ isMonitor: false, monitorNodeId: 'other' }),
    teardown: async (_cs, reason) => { seen = reason; },
  });
  await runSupervisorTick(deps); // blip
  const r = await runSupervisorTick(deps); // streak → teardown
  assert.equal(r.action, 'teardown');
  assert.match(String(seen), /not monitor/i);
});

test('boot-adopt hands the recorded terminal handle back to the backend before driving', async () => {
  _resetNotMonitorStreak();
  const remembered: string[] = [];
  const order: string[] = [];
  let adopted = false;
  const r = await runSupervisorTick(baseDeps({
    bootAdopt: { done: () => adopted, mark: () => { adopted = true; } },
    rememberTerminal: (cs) => { remembered.push(cs.tmux); order.push('remember'); },
    drive: async () => { order.push('drive'); },
  }));
  assert.equal(r.action, 'adopt-drive');
  assert.deepEqual(remembered, ['42.7933118.4.10118']);
  assert.deepEqual(order, ['remember', 'drive']);
});

test('pre-launch re-verify adopt also remembers the handle', async () => {
  _resetNotMonitorStreak();
  let reads = 0;
  const remembered: string[] = [];
  const r = await runSupervisorTick(baseDeps({
    isLive: () => { reads += 1; return reads >= 2; }, // gate read false, re-verify true
    bootAdopt: { done: () => true, mark: () => {} },
    rememberTerminal: (cs) => { remembered.push(cs.tmux); },
  }));
  assert.equal(r.action, 'adopt');
  assert.deepEqual(remembered, ['42.7933118.4.10118']);
});
