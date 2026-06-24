import { test } from 'node:test';
import assert from 'node:assert';
import { Mission, ExecutorState, AdjustResult, PlacementDecision, MissionBinding } from '../mission/mission-model';
import { runMissionTick, MissionTickDeps } from '../mission/mission-controller';

const mk = (over: Partial<Mission>): Mission => ({
  id: 'm', title: 't', objective: 'o', projects: [], dependsOn: [],
  env: { isolation: 'cloud', resources: [] }, binding: null, progress: null,
  control: { nudgeCount: 0, backoffStep: 0 }, results: [], adjustments: [],
  status: 'active', ownerNode: 'gw4-1', createdAt: 0, updatedAt: 0, ...over,
});
const deadState: ExecutorState = { alive: false, serverStalled: false, gate: null, newOutput: null, idle: true };

function deps(over: Partial<MissionTickDeps> & { missions: Mission[] }): MissionTickDeps {
  const saved: Record<string, Mission> = {};
  return {
    now: 1_000_000,
    cfg: { intervalMin: 5, maxNudges: 6, model: 'm' },
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'self' }),
    listAll: async () => over.missions,
    readExecutor: async () => deadState,
    adjust: async (): Promise<AdjustResult> => ({ verdict: 'continue', revisedObjective: null, revisedNextSteps: null, isMaterialPivot: false, nextDirective: 'continue', reason: '' }),
    startExecutor: async (): Promise<MissionBinding> => ({ sessionId: 'new-sid', node: 'h', kind: 'worker' }),
    drive: async () => {},
    save: async (m) => { saved[m.id] = m; (deps as any)._saved = saved; },
    ...over,
  };
}

test('non-monitor node skips entirely', async () => {
  let started = 0;
  const d = deps({ missions: [mk({ id: 'a' })], amMonitor: async () => ({ isMonitor: false, monitorNodeId: 'other' }), startExecutor: async () => { started++; return { sessionId: 's', node: 'h', kind: 'worker' }; } });
  const r = await runMissionTick(d);
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(started, 0);
});

test('unbound mission gets started (placement go)', async () => {
  const saved: Record<string, Mission> = {};
  const d = deps({ missions: [mk({ id: 'a' })], save: async (m) => { saved[m.id] = m; } });
  await runMissionTick(d);
  assert.strictEqual(saved['a'].binding?.sessionId, 'new-sid');
  assert.strictEqual(saved['a'].status, 'active');
});

test('unmet dependency parks mission as waiting', async () => {
  const saved: Record<string, Mission> = {};
  const a = mk({ id: 'a', dependsOn: ['b'] });
  const b = mk({ id: 'b', status: 'active' });
  const d = deps({ missions: [a, b], save: async (m) => { saved[m.id] = m; } });
  await runMissionTick(d);
  assert.strictEqual(saved['a'].status, 'waiting');
  assert.strictEqual(saved['a'].control.waitReason, 'dependency');
});

test('bound dead executor is rebound', async () => {
  const saved: Record<string, Mission> = {};
  const a = mk({ id: 'a', binding: { sessionId: 'old', node: 'h', kind: 'worker' } });
  const d = deps({ missions: [a], readExecutor: async () => deadState, save: async (m) => { saved[m.id] = m; } });
  await runMissionTick(d);
  assert.strictEqual(saved['a'].binding?.sessionId, 'new-sid');
});

test('new output -> adjust done marks done', async () => {
  const saved: Record<string, Mission> = {};
  const a = mk({ id: 'a', binding: { sessionId: 's', node: 'h', kind: 'worker' } });
  const d = deps({
    missions: [a],
    readExecutor: async () => ({ alive: true, serverStalled: false, gate: null, idle: false, newOutput: { cursor: 2, messages: ['done it'], results: [] } }),
    adjust: async () => ({ verdict: 'done', revisedObjective: null, revisedNextSteps: null, isMaterialPivot: false, nextDirective: 'x', reason: 'met' }),
    save: async (m) => { saved[m.id] = m; },
  });
  await runMissionTick(d);
  assert.strictEqual(saved['a'].status, 'done');
});

test('material pivot pauses without driving', async () => {
  const saved: Record<string, Mission> = {};
  let drove = 0;
  const a = mk({ id: 'a', binding: { sessionId: 's', node: 'h', kind: 'worker' } });
  const d = deps({
    missions: [a],
    readExecutor: async () => ({ alive: true, serverStalled: false, gate: null, idle: false, newOutput: { cursor: 2, messages: ['hmm'], results: [] } }),
    adjust: async () => ({ verdict: 'revise', revisedObjective: 'totally new', revisedNextSteps: null, isMaterialPivot: true, nextDirective: 'go', reason: 'pivot' }),
    drive: async () => { drove++; },
    save: async (m) => { saved[m.id] = m; },
  });
  await runMissionTick(d);
  assert.strictEqual(saved['a'].status, 'paused');
  assert.strictEqual(drove, 0);
  assert.strictEqual(saved['a'].adjustments.length, 1);
});

test('gate pauses the mission', async () => {
  const saved: Record<string, Mission> = {};
  const a = mk({ id: 'a', binding: { sessionId: 's', node: 'h', kind: 'worker' } });
  const d = deps({ missions: [a], readExecutor: async () => ({ alive: true, serverStalled: false, gate: { taskId: 't', reason: 'approve?' }, newOutput: null, idle: true }), save: async (m) => { saved[m.id] = m; } });
  await runMissionTick(d);
  assert.strictEqual(saved['a'].status, 'paused');
});

test('one mission throwing does not abort the tick', async () => {
  const saved: Record<string, Mission> = {};
  const a = mk({ id: 'a', binding: { sessionId: 's', node: 'h', kind: 'worker' } });
  const b = mk({ id: 'b' });
  const d = deps({
    missions: [a, b],
    readExecutor: async (m) => { if (m.id === 'a') throw new Error('boom'); return deadState; },
    save: async (m) => { saved[m.id] = m; },
  });
  const r = await runMissionTick(d);
  assert.ok(r.acted.includes('b'));
  assert.strictEqual(saved['b'].binding?.sessionId, 'new-sid');
});
