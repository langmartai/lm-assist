import { test } from 'node:test';
import assert from 'node:assert';
import { decideMission, planMissionNudge, Mission, ExecutorState, MissionControl } from '../mission/mission-model';

const m = (over: Partial<Mission>): Mission => ({
  id: 'm', title: 't', objective: 'o', projects: [], dependsOn: [],
  env: { isolation: 'cloud', resources: [] }, binding: null, progress: null,
  control: { nudgeCount: 0, backoffStep: 0 }, results: [], adjustments: [],
  status: 'active', ownerNode: 'gw4-1', createdAt: 0, updatedAt: 0, ...over,
} as unknown as Mission);
const st = (over: Partial<ExecutorState>): ExecutorState =>
  ({ alive: true, serverStalled: false, gate: null, newOutput: null, idle: false, ...over });

test('bound + dead executor => rebind', () => {
  const mission = m({ binding: { sessionId: 's', node: 'h', kind: 'worker' } });
  assert.deepStrictEqual(decideMission(mission, st({ alive: false })), { kind: 'rebind' });
});
test('server stall => defer to stall-monitor', () => {
  const mission = m({ binding: { sessionId: 's', node: 'h', kind: 'worker' } });
  assert.deepStrictEqual(decideMission(mission, st({ serverStalled: true })), { kind: 'defer' });
});
test('gate => gate', () => {
  const mission = m({ binding: { sessionId: 's', node: 'h', kind: 'worker' } });
  assert.deepStrictEqual(decideMission(mission, st({ gate: { taskId: 't1', reason: 'approve?' } })), { kind: 'gate', reason: 'approve?' });
});
test('new output => adjust', () => {
  const mission = m({ binding: { sessionId: 's', node: 'h', kind: 'worker' } });
  const out = { cursor: 5, messages: ['did thing'], results: [] };
  assert.deepStrictEqual(decideMission(mission, st({ newOutput: out })), { kind: 'adjust', output: out });
});
test('unbound mission => place (start)', () => {
  assert.deepStrictEqual(decideMission(m({}), st({ alive: false, idle: true })), { kind: 'place' });
});

test('planMissionNudge: first call nudges', () => {
  const r = planMissionNudge({ nudgeCount: 0, backoffStep: 0 }, { intervalMin: 5, maxNudges: 6 }, 1000);
  assert.strictEqual(r.action, 'nudge');
  assert.strictEqual(r.control.nudgeCount, 1);
  assert.strictEqual(r.control.lastNudgeAt, 1000);
});
test('planMissionNudge: within backoff waits', () => {
  const c: MissionControl = { nudgeCount: 1, backoffStep: 1, lastNudgeAt: 1000 };
  // backoffMinutes(1,5)=5min=300000ms; now just after => wait
  const r = planMissionNudge(c, { intervalMin: 5, maxNudges: 6 }, 1000 + 60_000);
  assert.strictEqual(r.action, 'wait');
});
test('planMissionNudge: at cap gives up', () => {
  const c: MissionControl = { nudgeCount: 6, backoffStep: 6, lastNudgeAt: 0 };
  const r = planMissionNudge(c, { intervalMin: 5, maxNudges: 6 }, 9_999_999);
  assert.strictEqual(r.action, 'giveup');
  assert.strictEqual(r.control.gaveUp, true);
});
