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
  'case.recall-before-improvise', 'case.evidence-before-done', 'case.parity-itemized-checklist',
  'case.postmortem-before-retry', 'case.dead-session-resume', 'case.wedged-interactive-prompt',
  'case.dry-run-destructive', 'case.deploy-path-check', 'case.blast-radius-user-gate',
  'case.ask-vs-act-calibration', 'case.human-correction-supremacy', 'case.duplicate-executor-guard',
  'case.cross-host-collision-check', 'case.synthetic-drill', 'case.background-cost-audit',
  'case.capture', 'case.index',
];

test('exactly the 28 seeded docs, all valid, all open', () => {
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

test('case library invariants', () => {
  const caseIds = Object.keys(DEFAULT_WORKFLOWS).filter(
    (id) => id.startsWith('case.') && id !== 'case.index' && id !== 'case.capture',
  );
  assert.ok(caseIds.length > 0, 'at least one case.* doc exists');

  const indexBody = DEFAULT_WORKFLOWS['case.index'].body;

  for (const id of caseIds) {
    const body = DEFAULT_WORKFLOWS[id].body;
    for (const needle of ['SITUATION:', 'RECOGNIZE:', 'HANDLE:', 'SOURCE:']) {
      assert.ok(body.includes(needle), `${id} body includes ${needle}`);
    }
    assert.ok(indexBody.includes(id), `case.index has a row for ${id}`);
  }

  assert.ok(
    DEFAULT_WORKFLOWS['recover.stuck'].body.startsWith('0. CONSULT THE CASE LIBRARY'),
    'recover.stuck starts with the case-library consult step',
  );

  const passBody = DEFAULT_WORKFLOWS['controller.pass'].body;
  assert.ok(passBody.includes('case.index'), 'controller.pass mentions case.index');
  assert.ok(passBody.includes('case.capture'), 'controller.pass mentions case.capture');

  assert.ok(
    DEFAULT_WORKFLOWS['case.capture'].body.includes('never store secrets'),
    'case.capture mentions never store secrets',
  );
});
