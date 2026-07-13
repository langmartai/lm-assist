import { test } from 'node:test';
import assert from 'node:assert';
import { handleSessionDrive, handlePatch } from '../routes/core/mission.routes';
import { buildOnboardMission, MISSION_CONTROL_MARKER } from '../mission/mission-onboard';
import type { MissionActor, Mission } from '../mission/mission-model';

const user: MissionActor = { kind: 'user', channel: 'mcp', at: 1 };
const ctrl: MissionActor = { kind: 'controller', channel: 'controller', at: 1 };

function onboarded(mode: 'handoff' | 'standby'): Mission {
  return buildOnboardMission({ sid: 'uuid-1', node: 'n1', transport: 'native', mode, crossCluster: false, ownerNode: 'n1', createdBy: user }, 1, () => 'mission_ob');
}

function driveDeps(m: Mission | null) {
  const sent: string[] = [];
  const deps = {
    resolve: () => ({ sid: 'uuid-1', transport: 'native' as const, missionId: m?.id ?? null, role: 'worker' as const }),
    cloudRead: async () => ({ messages: [] }),
    cloudDrive: async () => ({ delivered: true }),
    cloudStop: async () => ({ stopped: true }),
    nativeRead: async () => ({ messages: [] }),
    nativeRawMessages: async () => [],
    nativeDrive: async (_sid: string, text: string) => { sent.push(text); },
    nativeInterrupt: async () => {},
    nativeStop: async () => {},
    clearController: async () => {},
    getControllerSession: async () => null,
    findMission: async () => m,
  } as any;
  return { deps, sent };
}

test('standby drive rejected at the route', async () => {
  const { deps } = driveDeps(onboarded('standby'));
  const r = await handleSessionDrive('uuid-1', 'do things', deps);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'STANDBY_MODE');
});

test('handoff drive is marker-prefixed exactly once', async () => {
  const { deps, sent } = driveDeps(onboarded('handoff'));
  await handleSessionDrive('uuid-1', 'do things', deps);
  await handleSessionDrive('uuid-1', `${MISSION_CONTROL_MARKER} again`, deps);
  assert.equal(sent[0], `${MISSION_CONTROL_MARKER} do things`);
  assert.equal(sent[1], `${MISSION_CONTROL_MARKER} again`);
});

test('non-onboarded drive untouched', async () => {
  const { deps, sent } = driveDeps(null);
  await handleSessionDrive('uuid-1', 'plain', deps);
  assert.equal(sent[0], 'plain');
});

test('manageMode patch: human ok, controller forbidden, non-onboarded invalid', async () => {
  const m = onboarded('standby');
  const port = { isEnabled: () => true, get: async () => m, list: async () => [m], put: async (x: Mission) => { Object.assign(m, x); }, del: async () => {} } as any;
  const okFlip = await handlePatch(m.id, { manageMode: 'handoff' }, port, user);
  assert.equal(okFlip.success, true);
  assert.equal((okFlip.data as any).manageMode, 'handoff');
  const denied = await handlePatch(m.id, { manageMode: 'standby' }, port, ctrl);
  assert.equal(denied.success, false);
  assert.equal(denied.error!.code, 'FORBIDDEN');
  const plainPort = { isEnabled: () => true, get: async () => ({ ...m, origin: undefined }), list: async () => [], put: async () => {}, del: async () => {} } as any;
  const invalid = await handlePatch(m.id, { manageMode: 'handoff' }, plainPort, user);
  assert.equal(invalid.error!.code, 'INVALID_INPUT');
});
