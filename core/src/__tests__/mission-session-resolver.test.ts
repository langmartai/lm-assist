import { test } from 'node:test'; import assert from 'node:assert';
import { resolveMissionSession } from '../mission/mission-session-resolver';
const M = (o:any)=>o;
test('cse_/session_ id -> cloud transport', () => {
  const r = resolveMissionSession('session_01x', [], null);
  assert.equal(r.transport, 'cloud');
});
test('uuid id -> native transport', () => {
  const r = resolveMissionSession('4e15ac46-9053-477f-9dae-0000', [], null);
  assert.equal(r.transport, 'native');
});
test('controllerSid -> role controller', () => {
  assert.equal(resolveMissionSession('session_ctl', [], 'session_ctl').role, 'controller');
});
test('binding match -> role + missionId from the mission', () => {
  const missions = [M({ id:'mission_a', binding:{ kind:'orchestrator', sessionId:'session_o', ccr:{sid:'session_o'} } })];
  const r = resolveMissionSession('session_o', missions as any, null);
  assert.equal(r.role, 'orchestrator'); assert.equal(r.missionId, 'mission_a');
});
test('unknown sid -> worker role, null mission', () => {
  assert.equal(resolveMissionSession('session_zzz', [], null).role, 'worker');
});
