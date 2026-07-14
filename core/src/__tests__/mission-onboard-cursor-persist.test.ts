/**
 * I2 (supervisor-level) — evaluateEngagement (reached via runSupervisorTick) must PERSIST
 * an onboarded mission's advanced control.lastOutputCursor via the new `persistMissionControl`
 * dep. Without this, `readOnboardedSignal`'s first-read baseline (mission-onboard-signal.test.ts)
 * would fire on every single tick forever — the cursor was computed in-memory each read but
 * never written back onto the mission record, so the "previous" cursor never advanced.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { runSupervisorTick, type SupervisorDeps } from '../mission/mission-controller';
import { buildOnboardMission } from '../mission/mission-onboard';
import type { Mission, MissionActor } from '../mission/mission-model';

const who: MissionActor = { kind: 'user', channel: 'mcp', at: 1 };

function onboardedMission(id: string): Mission {
  return buildOnboardMission(
    { sid: 'uuid-persist-1', node: 'n1', transport: 'native', mode: 'handoff', crossCluster: false, ownerNode: 'n1', createdBy: who },
    1,
    () => id,
  );
}

function baseDeps(overrides: Partial<SupervisorDeps>): SupervisorDeps {
  const cs = { node: 'n1', sessionId: 'uuid-ctrl', cse: null, tmux: 't', startedAt: 1, lastDriveAt: undefined } as any;
  return {
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'n1' }),
    getControllerSession: async () => cs,
    putControllerSession: async () => {},
    isLive: () => true,
    launch: async () => cs,
    drive: async () => {},
    teardown: async () => {},
    driveIntervalMin: 5,
    now: 10 * 60_000,
    ...overrides,
  } as SupervisorDeps;
}

test('evaluateEngagement persists the advanced cursor for an onboarded mission via persistMissionControl', async () => {
  const m = onboardedMission('mission_persist_1');
  assert.equal(m.control.lastOutputCursor, undefined, 'precondition: no cursor set yet');
  let persisted: Mission | null = null;
  const deps = baseDeps({
    listActiveForEngage: async () => [m],
    readSignal: async () => ({ alive: true, gated: false, cursor: 5, newLines: ['line'] }),
    getEngagement: async () => ({ lastEngagedAt: null, lastActiveIds: [], seen: {} }),
    putEngagement: async () => {},
    persistMissionControl: async (mission) => { persisted = mission; },
  });
  await runSupervisorTick(deps);
  assert.ok(persisted, 'persistMissionControl must be called');
  assert.equal((persisted as unknown as Mission).control.lastOutputCursor, 5);
  assert.equal(m.control.lastOutputCursor, 5, 'the in-memory mission object itself is mutated with the advanced cursor');
});

test('evaluateEngagement does NOT persist when the cursor is unchanged (avoids redundant writes)', async () => {
  const m = onboardedMission('mission_persist_2');
  m.control.lastOutputCursor = 5;
  let persistCalled = false;
  const deps = baseDeps({
    listActiveForEngage: async () => [m],
    readSignal: async () => ({ alive: true, gated: false, cursor: 5, newLines: [] }), // same cursor as already stored
    getEngagement: async () => ({ lastEngagedAt: null, lastActiveIds: [], seen: {} }),
    putEngagement: async () => {},
    persistMissionControl: async () => { persistCalled = true; },
  });
  await runSupervisorTick(deps);
  assert.equal(persistCalled, false, 'no write when the cursor did not advance');
});

test('evaluateEngagement never calls persistMissionControl for a NON-onboarded mission', async () => {
  const m: Mission = { ...onboardedMission('mission_persist_3'), origin: undefined };
  let persistCalled = false;
  const deps = baseDeps({
    listActiveForEngage: async () => [m],
    readSignal: async () => ({ alive: true, gated: false, cursor: 5, newLines: [] }),
    getEngagement: async () => ({ lastEngagedAt: null, lastActiveIds: [], seen: {} }),
    putEngagement: async () => {},
    persistMissionControl: async () => { persistCalled = true; },
  });
  await runSupervisorTick(deps);
  assert.equal(persistCalled, false, 'persistMissionControl is scoped to origin:"onboarded" missions only');
});

test('evaluateEngagement: persistMissionControl absent (legacy caller) — cursor still advances in-memory, no throw', async () => {
  const m = onboardedMission('mission_persist_4');
  const deps = baseDeps({
    listActiveForEngage: async () => [m],
    readSignal: async () => ({ alive: true, gated: false, cursor: 7, newLines: [] }),
    getEngagement: async () => ({ lastEngagedAt: null, lastActiveIds: [], seen: {} }),
    putEngagement: async () => {},
    // NOTE: no persistMissionControl override — must not throw.
  });
  await assert.doesNotReject(() => runSupervisorTick(deps));
  assert.equal(m.control.lastOutputCursor, 7);
});

test('evaluateEngagement: persistMissionControl THROWING is best-effort — tick still completes', async () => {
  const m = onboardedMission('mission_persist_5');
  const deps = baseDeps({
    listActiveForEngage: async () => [m],
    readSignal: async () => ({ alive: true, gated: false, cursor: 9, newLines: [] }),
    getEngagement: async () => ({ lastEngagedAt: null, lastActiveIds: [], seen: {} }),
    putEngagement: async () => {},
    persistMissionControl: async () => { throw new Error('data-service down'); },
  });
  await assert.doesNotReject(() => runSupervisorTick(deps));
});
