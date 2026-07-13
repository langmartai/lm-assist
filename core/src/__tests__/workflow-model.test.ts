import { test } from 'node:test';
import assert from 'node:assert';
import {
  WORKFLOW_INVARIANT_PREAMBLE, MAX_WORKFLOW_BODY_BYTES,
  validateWorkflowId, validateWorkflowBody, renderWorkflowText, workflowChanged, isControllerActor,
} from '../mission/workflow-model';
import type { MissionActor } from '../mission/mission-model';

const actor = (kind: MissionActor['kind'], channel: MissionActor['channel']): MissionActor =>
  ({ kind, channel, at: 1 });

test('preamble is always prepended and non-empty', () => {
  assert.ok(WORKFLOW_INVARIANT_PREAMBLE.includes('never'), 'preamble states the never rules');
  const r = renderWorkflowText('BODY-X');
  assert.ok(r.startsWith(WORKFLOW_INVARIANT_PREAMBLE));
  assert.ok(r.endsWith('BODY-X'));
});

test('preamble carries the five invariants', () => {
  const p = WORKFLOW_INVARIANT_PREAMBLE.toLowerCase();
  for (const needle of ['auto-approve', 'human input', 'standby', 'never kill', 'rollback']) {
    assert.ok(p.includes(needle), `preamble mentions "${needle}"`);
  }
});

test('validateWorkflowId', () => {
  assert.equal(validateWorkflowId('onboard.analyze').ok, true);
  assert.equal(validateWorkflowId('drive.direct-impl').ok, true);
  assert.equal(validateWorkflowId('Bad.Caps').ok, false);
  assert.equal(validateWorkflowId('').ok, false);
  assert.equal(validateWorkflowId('a'.repeat(70)).ok, false);
  assert.equal(validateWorkflowId('has space').ok, false);
});

test('validateWorkflowBody enforces the 64KiB cap and non-empty', () => {
  assert.equal(validateWorkflowBody('x').ok, true);
  assert.equal(validateWorkflowBody('').ok, false);
  assert.equal(validateWorkflowBody('x'.repeat(MAX_WORKFLOW_BODY_BYTES + 1)).ok, false);
});

test('workflowChanged diffs title/body/editPolicy; null old = changed', () => {
  const doc = { id: 'a.b', title: 'T', body: 'B', editPolicy: 'open', rev: 1, history: [],
    createdBy: actor('user', 'user'), lastUpdatedBy: actor('user', 'user'), createdAt: 1, updatedAt: 1 } as any;
  assert.equal(workflowChanged(null, { title: 'T', body: 'B', editPolicy: 'open' }), true);
  assert.equal(workflowChanged(doc, { title: 'T', body: 'B', editPolicy: 'open' }), false);
  assert.equal(workflowChanged(doc, { title: 'T', body: 'B2', editPolicy: 'open' }), true);
  assert.equal(workflowChanged(doc, { title: 'T', body: 'B', editPolicy: 'human-only' }), true);
});

test('isControllerActor', () => {
  assert.equal(isControllerActor(actor('controller', 'controller')), true);
  assert.equal(isControllerActor(actor('local-session', 'controller')), true);
  assert.equal(isControllerActor(actor('user', 'mcp')), false);
  assert.equal(isControllerActor(actor('local-session', 'mcp')), false);
});
