// core/src/__tests__/workflow-defaults.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { DEFAULT_WORKFLOWS, WORK_TYPES, ONBOARD_STATES } from '../mission/workflow-defaults';
import { validateWorkflowId, validateWorkflowBody } from '../mission/workflow-model';

const EXPECTED_IDS = [
  'controller.pass', 'onboard.analyze',
  'drive.design', 'drive.direct-impl', 'drive.bugfix', 'drive.feature',
  'drive.multi-phase', 'drive.deploy',
  'recover.stuck', 'wrapup.completed', 'observe.standby',
];

test('exactly the 11 seeded docs, all valid, all open', () => {
  assert.deepEqual(Object.keys(DEFAULT_WORKFLOWS).sort(), [...EXPECTED_IDS].sort());
  for (const [id, d] of Object.entries(DEFAULT_WORKFLOWS)) {
    assert.equal(validateWorkflowId(id).ok, true, id);
    assert.equal(validateWorkflowBody(d.body).ok, true, id);
    assert.ok(d.title.length > 0, id);
    assert.equal(d.editPolicy, 'open', id);
  }
});

test('every work type has a drive doc; states covered', () => {
  for (const wt of WORK_TYPES) assert.ok(DEFAULT_WORKFLOWS[`drive.${wt}`], `drive.${wt}`);
  assert.deepEqual(ONBOARD_STATES, ['stuck', 'in-progress', 'completed']);
});

test('composite multi-phase: routing, phase docs, deploy gate, completion discipline', () => {
  // onboard.analyze detects composite work and sets the multi-phase work-type + phase plan
  const analyze = DEFAULT_WORKFLOWS['onboard.analyze'].body;
  for (const needle of ['multi-phase', 'ctl:phase', 'drive.multi-phase']) {
    assert.ok(analyze.includes(needle), `onboard.analyze mentions ${needle}`);
  }
  // controller.pass routes multi-phase and enforces final-phase completion
  const pass = DEFAULT_WORKFLOWS['controller.pass'].body;
  assert.ok(pass.includes('multi-phase') && pass.includes('drive.multi-phase'), 'controller.pass routes multi-phase');
  // drive.multi-phase composes the per-phase docs and tracks ctl:phase
  const mp = DEFAULT_WORKFLOWS['drive.multi-phase'].body;
  for (const needle of ['ctl:phase', 'drive.design', 'drive.bugfix', 'drive.deploy', 'sub-agents', 'never', 'FINAL']) {
    assert.ok(mp.includes(needle), `drive.multi-phase mentions ${needle}`);
  }
  // drive.deploy gates prod behind a human and verifies the release actually landed
  const dep = DEFAULT_WORKFLOWS['drive.deploy'].body;
  for (const needle of ['PRODUCTION', 'WAIT for a human', 'VERIFY', 'NEVER auto-deploy']) {
    assert.ok(dep.includes(needle), `drive.deploy mentions ${needle}`);
  }
  // wrapup won't complete a multi-phase mission until the deploy phase is verified
  assert.ok(DEFAULT_WORKFLOWS['wrapup.completed'].body.includes('deploy'), 'wrapup guards multi-phase completion incl. deploy');
});

test('controller.pass carries the routing rule, marker, and self-edit discipline', () => {
  const b = DEFAULT_WORKFLOWS['controller.pass'].body;
  for (const needle of ['mission_workflow_get', 'onboard:state', 'onboard:work-type', 'wrapup.completed', 'recover.stuck', '⟦MISSION-CONTROL⟧', 'manageMode', 'announce']) {
    assert.ok(b.includes(needle), `controller.pass mentions ${needle}`);
  }
});

test('onboard.analyze names the classification enums', () => {
  const b = DEFAULT_WORKFLOWS['onboard.analyze'].body;
  for (const v of ['stuck', 'in-progress', 'completed', 'design', 'direct-impl', 'bugfix', 'feature', 'mission_session_read', 'mission_update']) {
    assert.ok(b.includes(v), `onboard.analyze mentions ${v}`);
  }
});
