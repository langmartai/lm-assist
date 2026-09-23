/**
 * Supervisor launch/teardown guards — regression for the 2026-09-07 controller
 * pile-up: non-leader 107 cleared leader 123's controller record from the
 * fleet-synced dataset every minute (a "teardown" of a session that lives on
 * another node), so 123 launched a fresh controller every tick — 25 stacked up
 * in tmux, each registering a remote-control session on the account.
 *
 * Invariants pinned here:
 *   1. a record owned by ANOTHER node is never torn down or cleared by a non-leader;
 *   2. a launch first tears down every unrecorded local lmcc-* controller (one
 *      controller per leader, always);
 *   3. a launch whose record write fails tears the new controller down again
 *      (never leave an unrecorded controller for the next tick to stack on).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { runSupervisorTick, controllerRecordOwnedHere, controllerTmuxPrefix, _resetNotMonitorStreak, _resetJournalState } from '../mission/mission-controller';
import type { SupervisorDeps } from '../mission/mission-controller';
import type { ControllerSession } from '../mission/mission-store';

const NOW = 1_000_000_000;
const P = controllerTmuxPrefix(); // 'lmcc' in prod, 'lmccdev' in a dev/test build
const own: ControllerSession = { node: 'gw1', sessionId: 'sess-own', cse: null, tmux: `${P}-own`, startedAt: 1000 };
const foreign: ControllerSession = { node: 'gw2', sessionId: 'sess-foreign', cse: null, tmux: `${P}-foreign`, startedAt: 1000 };

function stub(over: Partial<SupervisorDeps>): SupervisorDeps {
  return {
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'gw1' }),
    getControllerSession: async () => null,
    putControllerSession: async () => {},
    isLive: () => false,
    launch: async () => own,
    drive: async () => {},
    teardown: async () => {},
    selfNodeId: () => 'gw1',
    driveIntervalMin: 5,
    now: NOW,
    ...over,
  };
}

test('controllerRecordOwnedHere: only a record with a DIFFERENT node is foreign; legacy/no-self is ours', () => {
  const self = { selfNodeId: () => 'gw1' };
  assert.equal(controllerRecordOwnedHere(own, self), true);
  assert.equal(controllerRecordOwnedHere(foreign, self), false);
  assert.equal(controllerRecordOwnedHere({ node: '' }, self), true);
  assert.equal(controllerRecordOwnedHere(foreign, {}), true);
  assert.equal(controllerRecordOwnedHere(foreign, { selfNodeId: () => { throw new Error('hub down'); } }), true);
  assert.equal(controllerRecordOwnedHere(null, self), true);
});

test('non-leader with the LEADER\'s record: never torn down, never cleared — even past the debounce streak', async () => {
  _resetNotMonitorStreak(); _resetJournalState();
  const calls: string[] = [];
  const deps = stub({
    amMonitor: async () => ({ isMonitor: false, monitorNodeId: 'gw2' }),
    getControllerSession: async () => foreign,
    teardown: async (cs) => { calls.push(`teardown:${cs.sessionId}`); },
    putControllerSession: async (cs) => { calls.push(`put:${cs ? cs.sessionId : 'null'}`); },
  });
  for (let i = 0; i < 4; i++) {
    const r = await runSupervisorTick(deps);
    assert.equal(r.action, 'idle', `tick ${i}`);
    assert.equal(r.controllerSession?.sessionId, 'sess-foreign', 'the record is handed back untouched');
  }
  assert.deepEqual(calls, [], 'no teardown, no put(null) against another node\'s controller');
});

test('non-leader with its OWN record: the debounced teardown still fires and clears (unchanged)', async () => {
  _resetNotMonitorStreak(); _resetJournalState();
  const calls: string[] = [];
  const deps = stub({
    amMonitor: async () => ({ isMonitor: false, monitorNodeId: 'gw2' }),
    getControllerSession: async () => own,
    teardown: async (cs) => { calls.push(`teardown:${cs.sessionId}`); },
    putControllerSession: async (cs) => { calls.push(`put:${cs ? cs.sessionId : 'null'}`); },
  });
  await runSupervisorTick(deps);                // streak 1: blip
  const r = await runSupervisorTick(deps);      // streak 2: teardown
  assert.equal(r.action, 'teardown');
  assert.deepEqual(calls, ['teardown:sess-own', 'put:null']);
});

test('launch with NO record but stray lmcc-* tmux locally: strays are torn down BEFORE the launch, exactly one controller results', async () => {
  _resetNotMonitorStreak(); _resetJournalState();
  const order: string[] = [];
  const deps = stub({
    getControllerSession: async () => null,
    listTmuxSessions: async () => [`${P}-old1`, 'lmt-executor', `${P}-old2`, 'shell'],
    killStrayTmux: async (name) => { order.push(`kill:${name}`); },
    launch: async () => { order.push('launch'); return own; },
    putControllerSession: async (cs) => { order.push(`put:${cs ? cs.sessionId : 'null'}`); },
  });
  const r = await runSupervisorTick(deps);
  assert.equal(r.action, 'launch');
  assert.deepEqual(order, [`kill:${P}-old1`, `kill:${P}-old2`, 'launch', 'put:sess-own']);
});

test('launch whose record write FAILS: the new controller is torn down again and the failure surfaces', async () => {
  _resetNotMonitorStreak(); _resetJournalState();
  const calls: string[] = [];
  const deps = stub({
    getControllerSession: async () => null,
    launch: async () => { calls.push('launch'); return own; },
    putControllerSession: async () => { throw new Error('dataset write refused'); },
    teardown: async (cs, reason) => { calls.push(`teardown:${cs.sessionId}:${reason}`); },
  });
  await assert.rejects(() => runSupervisorTick(deps), /dataset write refused/);
  assert.deepEqual(calls, ['launch', 'teardown:sess-own:launch: controller record write failed']);
});

test('leader taking over a foreign record (failover) still launches — ownership only guards the non-leader teardown', async () => {
  _resetNotMonitorStreak(); _resetJournalState();
  const calls: string[] = [];
  const deps = stub({
    getControllerSession: async () => foreign,
    isLive: () => false,
    launch: async () => { calls.push('launch'); return own; },
    putControllerSession: async (cs) => { calls.push(`put:${cs ? cs.sessionId : 'null'}`); },
    teardown: async (cs) => { calls.push(`teardown:${cs.sessionId}`); },
  });
  const r = await runSupervisorTick(deps);
  assert.equal(r.action, 'launch');
  assert.deepEqual(calls, ['teardown:sess-foreign', 'launch', 'put:sess-own']);
});
