import { test } from 'node:test';
import assert from 'node:assert';
import { handleMissionSpawn, type MissionSpawnDeps } from '../routes/core/mission.routes';
import type { MissionActor } from '../mission/mission-model';

// ---------------------------------------------------------------------------
// handleMissionSpawn — standby-latched missions must not be silently detached
//
// `assertDriveable` (manual-probe.ts) resolves a mission BY SESSION ID. A spawn
// that rebinds a standby mission to a fresh executor session removes the mission
// from the guard's view just as effectively as an explicit unbind: manageMode
// stays 'standby' on a record nothing consults, and a new executor starts driving
// while the human's original session is orphaned. `handlePatch` already refuses
// this for `binding` changes from a controller actor; `mission_spawn` reaches the
// same outcome through a different door and must be gated the same way.
//
// A HUMAN passing force:true is a different case: the human-only principle in
// this feature is about who may RELEASE the latch, not about forbidding the human
// who holds it from acting — so a human's force:true spawn is allowed through.
// ---------------------------------------------------------------------------

const controllerActor: MissionActor = { kind: 'controller', channel: 'controller', node: 'n', at: 1 };
const humanActor: MissionActor = { kind: 'user', channel: 'user', node: 'n', at: 1 };

const standbyMission = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'mission_sb1',
  title: 'Standby me',
  objective: 'obj',
  env: { repo: '/repo' },
  manageMode: 'standby',
  binding: { sessionId: 'uuid-human', kind: 'worker' },
  ...over,
});

const goNative = { go: true, env: 'worktree', repo: 'rel/repo', branch: 'feat/x' };

function deps(over: Partial<MissionSpawnDeps> = {}, calls: Record<string, unknown[]> = {}): MissionSpawnDeps {
  return {
    getMission: async () => standbyMission(),
    listMissions: async () => [],
    place: () => ({ ...goNative }),
    startNative: async (m, decision, nd) => {
      (calls.start ??= []).push([m, decision, nd]);
      return { sessionId: 'uuid-controller-new', node: 'local', kind: 'worker', boundAt: 1 };
    },
    buildNativeDeps: async () => ({ fake: true }),
    persist: async (m) => { (calls.persist ??= []).push(m); },
    ...over,
  };
}

test('spawn: a controller actor is refused on a standby mission, even with force:true', async () => {
  const calls: Record<string, unknown[]> = {};
  const r = await handleMissionSpawn('mission_sb1', { force: true }, deps({ actor: controllerActor }, calls));
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'FORBIDDEN');
  assert.equal((calls.start ?? []).length, 0, 'no executor may be launched for the refused spawn');
  assert.equal((calls.persist ?? []).length, 0, 'the standby binding must not be touched');
});

test('spawn: a controller actor is refused on a standby mission WITHOUT force too (the guard is not force-gated)', async () => {
  const calls: Record<string, unknown[]> = {};
  const r = await handleMissionSpawn('mission_sb1', {}, deps({ actor: controllerActor, getMission: async () => standbyMission({ binding: null }) }, calls));
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'FORBIDDEN');
  assert.equal((calls.start ?? []).length, 0);
});

test('spawn: a human actor MAY force-spawn a replacement on a standby mission (deliberate, in-person choice)', async () => {
  const calls: Record<string, unknown[]> = {};
  const r = await handleMissionSpawn('mission_sb1', { force: true }, deps({ actor: humanActor }, calls));
  assert.equal(r.success, true, JSON.stringify(r.error));
  assert.equal((calls.start ?? []).length, 1);
  const persisted = (calls.persist as Record<string, unknown>[])[0];
  assert.equal((persisted.binding as Record<string, unknown>).sessionId, 'uuid-controller-new');
});

test('spawn: a human actor without force still hits the ordinary ALREADY_BOUND refusal (standby does not bypass it)', async () => {
  const calls: Record<string, unknown[]> = {};
  const r = await handleMissionSpawn('mission_sb1', {}, deps({ actor: humanActor }, calls));
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'ALREADY_BOUND');
  assert.equal((calls.start ?? []).length, 0);
});

test('spawn: a non-standby mission is unaffected by this guard (controller can still spawn normally)', async () => {
  const calls: Record<string, unknown[]> = {};
  const nonStandby = { id: 'mission_sb1', title: 't', objective: 'o', env: { repo: '/repo' }, manageMode: 'handoff', binding: null };
  const r = await handleMissionSpawn('mission_sb1', {}, deps({ actor: controllerActor, getMission: async () => nonStandby }, calls));
  assert.equal(r.success, true, JSON.stringify(r.error));
  assert.equal((calls.start ?? []).length, 1);
});
