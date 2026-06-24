import { test } from 'node:test';
import assert from 'node:assert';
import { Mission, ExecutorOutput } from '../mission/mission-model';
import { buildAdjustPrompt, runAdjust, AdjustRunner } from '../mission/mission-adjust';

const mission: Mission = {
  id: 'm', title: 't', objective: 'Ship the widget', plan: 'step1; step2', nextSteps: ['do step2'],
  projects: [], dependsOn: [], env: { isolation: 'cloud', resources: [] }, binding: null, progress: null,
  control: { nudgeCount: 0, backoffStep: 0 }, results: [], adjustments: [],
  status: 'active', ownerNode: 'gw4-1', createdAt: 0, updatedAt: 0,
} as unknown as Mission;
const out: ExecutorOutput = { cursor: 3, messages: ['finished step1, blocked on auth'], results: [{ ref: 'pr#1', summary: 'opened PR' }] };

test('buildAdjustPrompt includes objective and new output', () => {
  const p = buildAdjustPrompt(mission, out);
  assert.match(p, /Ship the widget/);
  assert.match(p, /finished step1, blocked on auth/);
  assert.match(p, /pr#1/);
});
test('runAdjust returns the parsed verdict from the runner', async () => {
  const fake: AdjustRunner = { execute: async () => ({ success: true, result: '{"verdict":"revise","nextDirective":"unblock auth","isMaterialPivot":false,"revisedObjective":null}' }) };
  const r = await runAdjust(mission, out, 'claude-opus-4-8[1m]', fake);
  assert.strictEqual(r.verdict, 'revise');
  assert.strictEqual(r.nextDirective, 'unblock auth');
});
test('runAdjust defaults to continue when the runner fails', async () => {
  const fake: AdjustRunner = { execute: async () => ({ success: false, result: '' }) };
  assert.strictEqual((await runAdjust(mission, out, 'm', fake)).verdict, 'continue');
});
test('runAdjust defaults to continue when the runner throws', async () => {
  const fake: AdjustRunner = { execute: async () => { throw new Error('boom'); } };
  assert.strictEqual((await runAdjust(mission, out, 'm', fake)).verdict, 'continue');
});
test('runAdjust passes adaptive thinking + high effort + json schema', async () => {
  let seen: any = null;
  const fake: AdjustRunner = { execute: async (_p, opts) => { seen = opts; return { success: true, result: '{"verdict":"continue","nextDirective":"go"}' }; } };
  await runAdjust(mission, out, 'claude-opus-4-8[1m]', fake);
  assert.deepStrictEqual(seen.extendedThinking, { enabled: true, type: 'adaptive' });
  assert.strictEqual(seen.outputConfig.effort, 'high');
  assert.strictEqual(seen.outputConfig.format.type, 'json_schema');
  assert.strictEqual(seen.model, 'claude-opus-4-8[1m]');
  assert.strictEqual(seen.maxTurns, 1);
});
