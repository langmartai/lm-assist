/**
 * Task 6 route wiring: `assertDriveable` must actually run — before any write — inside
 * each of the four session-write handlers, not just be imported. Each test proves this
 * by injecting a `findMission` that resolves a standby, NON-onboarded mission (the guard
 * is mission-scoped, not onboarded-only) and asserting both the STANDBY_MODE refusal AND
 * that the underlying write primitive was never called.
 *
 * Also covers the onboarding bypass fix: a controller-attributed caller must not be able
 * to onboard with an explicit mode:'handoff' and seize drive control pre-emptively.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  handleSessionDrive, handleSessionControl, handleSessionAnswer, handleSessionResume, handleOnboard,
  defaultSessionOpsDeps, defaultSessionAnswerDeps, defaultSessionResumeDeps,
} from '../routes/core/mission.routes';
import type {
  SessionOpsDeps, SessionAnswerDeps, SessionResumeDeps, LeaderAnchorDeps,
} from '../routes/core/mission.routes';
import type { Mission, MissionActor } from '../mission/mission-model';
import { thisNode } from '../mission/mission-store';
import type { MissionDataPort, MissionHistoryPort } from '../mission/mission-store';

const user: MissionActor = { kind: 'user', channel: 'mcp', at: 1 };
const ctrl: MissionActor = { kind: 'controller', channel: 'controller', at: 1 };

function standbyMission(): Mission {
  // Deliberately origin: undefined (NOT onboarded) — proves the guard gates every
  // managed session, not just the onboarding rail.
  return {
    id: 'mission_standby',
    manageMode: 'standby',
    control: {},
    adjustments: [],
  } as unknown as Mission;
}

const STUB_LEADER_IS_SELF: LeaderAnchorDeps = {
  getElection: async () => ({ isMonitor: true, monitorNodeId: thisNode() }),
  proxyGet: async () => ({}),
  proxyPost: async () => ({}),
};

// ---------------------------------------------------------------------------
// handleSessionDrive
// ---------------------------------------------------------------------------

test('handleSessionDrive: standby (non-onboarded) mission refuses BEFORE nativeDrive runs', async () => {
  let driven = false;
  const deps: SessionOpsDeps = {
    resolve: () => ({ sid: 'uuid-guard-1', transport: 'native', missionId: 'mission_standby', role: 'worker' }),
    cloudRead: async () => ({ messages: [] }),
    cloudDrive: async () => ({ delivered: true }),
    cloudStop: async () => ({ stopped: true }),
    nativeRead: async () => ({ messages: [] }),
    nativeRawMessages: async () => [],
    nativeDrive: async () => { driven = true; },
    nativeInterrupt: async () => {},
    nativeStop: async () => {},
    clearController: async () => {},
    getControllerSession: async () => null,
    findMission: async () => standbyMission(),
    selfNode: () => 'n1',
  } as any;
  const r = await handleSessionDrive('uuid-guard-1', 'do the thing', deps);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'STANDBY_MODE');
  assert.equal(driven, false, 'nativeDrive must never run once the guard refuses');
});

// ---------------------------------------------------------------------------
// handleSessionControl
// ---------------------------------------------------------------------------

test('handleSessionControl: standby (non-onboarded) mission refuses BEFORE nativeInterrupt runs', async () => {
  let interrupted = false;
  const deps: SessionOpsDeps = {
    resolve: () => ({ sid: 'uuid-guard-2', transport: 'native', missionId: 'mission_standby', role: 'worker' }),
    cloudRead: async () => ({ messages: [] }),
    cloudDrive: async () => ({ delivered: true }),
    cloudStop: async () => ({ stopped: true }),
    nativeRead: async () => ({ messages: [] }),
    nativeRawMessages: async () => [],
    nativeDrive: async () => {},
    nativeInterrupt: async () => { interrupted = true; },
    nativeStop: async () => {},
    clearController: async () => {},
    getControllerSession: async () => null,
    findMission: async () => standbyMission(),
    selfNode: () => 'n1',
  } as any;
  const r = await handleSessionControl('uuid-guard-2', 'interrupt', deps);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'STANDBY_MODE');
  assert.equal(interrupted, false, 'nativeInterrupt must never run once the guard refuses');
});

// ---------------------------------------------------------------------------
// handleSessionAnswer
// ---------------------------------------------------------------------------

test('handleSessionAnswer: standby (non-onboarded) mission refuses BEFORE nativeSendKeys runs', async () => {
  let sent = false;
  const deps: SessionAnswerDeps = {
    cloudAnswer: async () => ({ answered: true }),
    nativeSendKeys: async () => { sent = true; },
    nativeGetPendingQuestion: async () => null,
    nativeTmuxSession: () => 'lmcc-test',
    resolve: (sid) => ({ sid, transport: 'native', missionId: 'mission_standby', role: 'worker' }),
    findMission: async () => standbyMission(),
  };
  const r = await handleSessionAnswer('uuid-guard-3', { answer: 'yes' }, deps, undefined, STUB_LEADER_IS_SELF);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'STANDBY_MODE');
  assert.equal(sent, false, 'nativeSendKeys must never run once the guard refuses');
});

// ---------------------------------------------------------------------------
// handleSessionResume
// ---------------------------------------------------------------------------

test('handleSessionResume: standby (non-onboarded) mission refuses BEFORE resumeNative runs', async () => {
  let resumed = false;
  const deps: SessionResumeDeps = {
    resolve: (sid) => ({ sid, transport: 'native', missionId: 'mission_standby' }),
    cloudStatus: async (sid) => ({ sid, status: 'active', raw: {} }),
    cloudWake: async () => {},
    nativeVerdict: () => ({ connectStrategy: 'create-tmux', safeToCreateTmux: true, inTmux: false }),
    resumeNative: async (_missionId, sid) => { resumed = true; return { sid, boundAt: Date.now() }; },
    idleMin: 30,
    findMission: async () => standbyMission(),
  };
  const r = await handleSessionResume('uuid-guard-4', { missionId: 'mission_standby' }, deps, undefined, STUB_LEADER_IS_SELF);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'STANDBY_MODE');
  assert.equal(resumed, false, 'resumeNative must never run once the guard refuses');
});

// ---------------------------------------------------------------------------
// A clean (handoff) mission is unaffected — the guard doesn't over-refuse
// ---------------------------------------------------------------------------

test('handleSessionDrive: a handoff mission is unaffected by the guard', async () => {
  let driven = false;
  const deps: SessionOpsDeps = {
    resolve: () => ({ sid: 'uuid-guard-5', transport: 'native', missionId: 'mission_handoff', role: 'worker' }),
    cloudRead: async () => ({ messages: [] }),
    cloudDrive: async () => ({ delivered: true }),
    cloudStop: async () => ({ stopped: true }),
    nativeRead: async () => ({ messages: [] }),
    nativeRawMessages: async () => [],
    nativeDrive: async () => { driven = true; },
    nativeInterrupt: async () => {},
    nativeStop: async () => {},
    clearController: async () => {},
    getControllerSession: async () => null,
    findMission: async () => ({ id: 'mission_handoff', manageMode: 'handoff', control: {}, adjustments: [] } as unknown as Mission),
    selfNode: () => 'n1',
  } as any;
  const r = await handleSessionDrive('uuid-guard-5', 'do the thing', deps);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(driven, true);
});

// ---------------------------------------------------------------------------
// Onboarding bypass fix (requirement A): explicit mode:'handoff' is human-only
// ---------------------------------------------------------------------------

/**
 * I2: an in-memory-only `MissionDataPort` — never `livePort()`/`defaultPort()`. Without
 * this, `handleOnboard`'s `d.port` argument was omitted, so `putMission`/`listMissions`
 * fell through to `defaultPort()` → `livePort()`, and on THIS machine
 * (`dataServiceEnabled: true`) every test run wrote a REAL 'Onboarded: uuid-bypass-…'
 * mission into the live, fleet-synced `missions` dataset. Two such records were found
 * live (mission_0a4949e1, mission_3f4703c4) and deleted as part of this fix — see the
 * task report. Matches the mock shape used in `mission-onboard-rails.test.ts`.
 */
function mockPort(): MissionDataPort {
  const store = new Map<string, Mission>();
  return {
    isEnabled: () => true,
    get: async (id) => store.get(id) ?? null,
    list: async () => [...store.values()],
    put: async (m) => { store.set(m.id, m); },
    del: async (id) => { store.delete(id); },
  };
}

/**
 * Fix wave 2: `putMission` also writes to a SEPARATE live, fleet-synced dataset
 * (`mission-history`, via `appendMissionHistory(mission.id, change, opts.historyPort)`
 * — see `mission-store.ts`). `handleOnboard` called `putMission(m, d.port, { actor: who })`
 * with no `historyPort`, so even with the I2 mock `port` above, history fell through to
 * `defaultHistoryPort()` → the LIVE store. Because a fresh mission's `old = port.get(m.id)`
 * is always null, `diffMission` always yields a non-empty change, so history was written on
 * EVERY run (two real records — mission_b2abd695:1, mission_4678e45d:1 — were found and
 * deleted). `OnboardDeps.historyPort` now threads an in-memory `MissionHistoryPort` the same
 * way `port` does, so history writes are captured here too.
 */
function mockHistoryPort(): MissionHistoryPort {
  const store = new Map<string, unknown>();
  return {
    isEnabled: () => true,
    put: async (rec) => { store.set(rec.id, rec); },
    query: async (missionId) => [...store.values()].filter((r: any) => r.missionId === missionId) as any,
  };
}

function onboardDeps(over: Record<string, unknown> = {}) {
  return {
    actor: ctrl,
    port: mockPort(),
    historyPort: mockHistoryPort(),
    clusterRecords: async () => [{ gatewayId: 'gw-self', cluster: 'default' }],
    myCluster: () => 'default',
    onlineNodes: async () => ['gw-self'],
    proxyPost: async () => { throw new Error('no proxy expected'); },
    nativeExists: () => true,
    selfNode: () => 'gw-self',
    ...over,
  } as any;
}

test('handleOnboard: controller actor + explicit mode:handoff is FORBIDDEN', async () => {
  const r = await handleOnboard({ sessionId: 'uuid-bypass-1', mode: 'handoff' }, onboardDeps());
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'FORBIDDEN');
});

test('handleOnboard: controller actor + omitted mode (defaults standby) is allowed', async () => {
  const r = await handleOnboard({ sessionId: 'uuid-bypass-2' }, onboardDeps());
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal((r.data as any).mission.manageMode, 'standby');
});

test('handleOnboard: human actor + explicit mode:handoff is still allowed', async () => {
  const r = await handleOnboard({ sessionId: 'uuid-bypass-3', mode: 'handoff' }, onboardDeps({ actor: user }));
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal((r.data as any).mission.manageMode, 'handoff');
});

// ---------------------------------------------------------------------------
// I1: the DEFAULT deps builders must actually wire findMission to the real store.
//
// `findMission` is OPTIONAL on SessionOpsDeps/SessionAnswerDeps/SessionResumeDeps, and
// `realGuardDeps(undefined)` degrades to "no mission → always driveable". Every test above
// injects its own `findMission`, so it passes identically whether or not the PRODUCTION
// default builders wire the real store — deleting `findMission: (sid) =>
// findMissionBySessionOrCcr(sid)` from e.g. `defaultSessionAnswerDeps` would leave every
// test above green while the guard silently goes inert on /answer. These three assert the
// default builders each supply a `findMission` that is genuinely the real
// `findMissionBySessionOrCcr` — checked at the source level (constructing the deps object is
// side-effect-free; CALLING findMission would hit the live, fleet-synced store, which is
// exactly what I2 above says never to do from a test) via the function's own source text,
// so a swap for an inert stub (e.g. `async () => null`) fails this just as loudly as an
// outright deletion.
// ---------------------------------------------------------------------------

test('defaultSessionOpsDeps wires findMission to the real store', () => {
  const d = defaultSessionOpsDeps();
  assert.equal(typeof d.findMission, 'function');
  assert.ok(String(d.findMission).includes('findMissionBySessionOrCcr'),
    'defaultSessionOpsDeps.findMission must delegate to findMissionBySessionOrCcr — the real mission store lookup');
});

test('defaultSessionAnswerDeps wires findMission to the real store', () => {
  const d = defaultSessionAnswerDeps();
  assert.equal(typeof d.findMission, 'function');
  assert.ok(String(d.findMission).includes('findMissionBySessionOrCcr'),
    'defaultSessionAnswerDeps.findMission must delegate to findMissionBySessionOrCcr — the real mission store lookup');
});

test('defaultSessionResumeDeps wires findMission to the real store', () => {
  const d = defaultSessionResumeDeps();
  assert.equal(typeof d.findMission, 'function');
  assert.ok(String(d.findMission).includes('findMissionBySessionOrCcr'),
    'defaultSessionResumeDeps.findMission must delegate to findMissionBySessionOrCcr — the real mission store lookup');
});
