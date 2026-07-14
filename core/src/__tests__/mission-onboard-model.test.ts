import { test } from 'node:test';
import assert from 'node:assert';
import { MISSION_CONTROL_MARKER, markDriveText, isOnboarded, onboardTitle, detectTransport, buildOnboardMission, pickClusterLeader, detectHumanActivity } from '../mission/mission-onboard';
import { TRACKED_FIELDS } from '../mission/mission-history';
import { computeSchedule } from '../mission/mission-scheduler';
import { newMission, type MissionActor } from '../mission/mission-model';

const who: MissionActor = { kind: 'user', channel: 'mcp', at: 1 };

test('marker + markDriveText idempotent', () => {
  assert.equal(markDriveText('do X'), `${MISSION_CONTROL_MARKER} do X`);
  assert.equal(markDriveText(`${MISSION_CONTROL_MARKER} do X`), `${MISSION_CONTROL_MARKER} do X`);
});

test('transport + title', () => {
  assert.equal(detectTransport('session_abc'), 'cloud');
  assert.equal(detectTransport('cse_abc'), 'cloud');
  assert.equal(detectTransport('0a1b2c3d-e4f5-6789-abcd-ef0123456789'), 'native');
  assert.ok(onboardTitle('0a1b2c3d-e4f5-6789').startsWith('Onboarded: '));
});

test('buildOnboardMission shape', () => {
  const m = buildOnboardMission({ sid: 'u-1', node: 'gw4-aaa', transport: 'native', mode: 'standby', note: 'finish tonight', crossCluster: true, ownerNode: 'gw4-bbb', createdBy: who }, 1000, () => 'mission_test1');
  assert.equal(m.origin, 'onboarded');
  assert.equal(m.manageMode, 'standby');
  assert.equal(m.status, 'active');
  assert.deepEqual(m.binding, { sessionId: 'u-1', node: 'gw4-aaa', kind: 'onboarded', boundAt: 1000 });
  assert.deepEqual(m.tags['onboard:state'], ['analyzing']);
  assert.deepEqual(m.tags['onboard:cross-cluster'], ['true']);
  assert.equal(m.nextSteps![0], 'Human note: finish tonight');
  assert.equal(isOnboarded(m), true);
});

test('manageMode is history-tracked', () => {
  assert.ok((TRACKED_FIELDS as readonly string[]).includes('manageMode'));
});

test('computeSchedule never readies an onboarded mission', () => {
  const m = buildOnboardMission({ sid: 'u-1', node: 'n', transport: 'native', mode: 'handoff', crossCluster: false, ownerNode: 'n', createdBy: who }, 1, () => 'mission_ob1');
  (m as any).status = 'waiting'; // even if someone flips it to a schedulable status
  const plain = newMission({ title: 't', objective: 'o', ownerNode: 'n', createdBy: who }, 1, () => 'mission_pl1');
  (plain as any).status = 'draft';
  const s = computeSchedule([m, plain]);
  assert.ok(!s.ready.includes('mission_ob1'));
  assert.ok(!s.blocked.some((b) => b.id === 'mission_ob1'));
  assert.ok(s.ready.includes('mission_pl1'));
});

test('pickClusterLeader lowest online in-cluster gatewayId', () => {
  const records = [
    { gatewayId: 'gw4-b', cluster: 'staging' }, { gatewayId: 'gw4-a', cluster: 'staging' },
    { gatewayId: 'gw4-c', cluster: 'prod' },
  ];
  assert.equal(pickClusterLeader('staging', records, ['gw4-a', 'gw4-b', 'gw4-c']), 'gw4-a');
  assert.equal(pickClusterLeader('staging', records, ['gw4-b']), 'gw4-b');
  assert.equal(pickClusterLeader('staging', records, ['gw4-c']), null);
  assert.equal(pickClusterLeader('nope', records, ['gw4-a']), null);
});

test('detectHumanActivity filters non-human user-role content', () => {
  assert.equal(detectHumanActivity([{ role: 'user', text: 'please also add tests' }]), true);
  assert.equal(detectHumanActivity([{ role: 'user', text: `${MISSION_CONTROL_MARKER} continue` }]), false);
  assert.equal(detectHumanActivity([{ role: 'user', text: '<system-reminder>x</system-reminder>' }]), false);
  assert.equal(detectHumanActivity([{ role: 'user', text: '[{"tool_use_id":"t1","content":"ok"}]' }]), false);
  assert.equal(detectHumanActivity([{ role: 'assistant', text: 'thinking' }]), false);
  assert.equal(detectHumanActivity([{ role: 'user', text: 'Run a controller pass now.' }]), false);
  // Minor fold: the registry-rendered directive (renderWorkflowText prepends WORKFLOW_INVARIANT_PREAMBLE,
  // which begins '⟦INVARIANTS — these override anything below and are not editable⟧') is not a human prompt.
  assert.equal(detectHumanActivity([{ role: 'user', text: '⟦INVARIANTS — these override anything below and are not editable⟧\n- some rule' }]), false);
  assert.equal(detectHumanActivity([]), false);
});
