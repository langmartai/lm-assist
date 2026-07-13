// core/src/__tests__/workflow-defaults.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { DEFAULT_WORKFLOWS, WORK_TYPES, ONBOARD_STATES } from '../mission/workflow-defaults';
import { validateWorkflowId, validateWorkflowBody } from '../mission/workflow-model';

const EXPECTED_IDS = [
  'controller.pass', 'onboard.analyze',
  'drive.design', 'drive.direct-impl', 'drive.bugfix', 'drive.feature',
  'recover.stuck', 'wrapup.completed', 'observe.standby',
];

test('exactly the 9 seeded docs, all valid, all open', () => {
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
