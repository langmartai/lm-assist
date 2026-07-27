/**
 * `node_select` was SHIPPED but not WIRED (bl_28543c78 / bl_1c861246, 2026-07-27).
 *
 * Established by reading the code, and measured on prod 117:
 *
 *  • `selectDeterministic` — the ranker behind the `node_select` tool — had exactly ONE
 *    caller: `SupervisorDeps.selectNode`, consumed only by the starvation safety net
 *    (15 unplaced ticks). The controller's ACTUAL placement path never touched it: the
 *    live `controller.pass` body and the controller's on-disk system prompt contain zero
 *    occurrences of `node_select`, and `handleMissionSpawn` never reads `env.host` at all.
 *    So a native mission runs wherever the elected leader is, and `env.host` stays unset —
 *    which is exactly what `mission_e44d6e8e` showed (placed with host "nohost").
 *
 *  • The safety net's "do not spawn on the wrong machine" guarantee held for exactly ONE
 *    TICK. `placeStarvedMissions` PERSISTED `m.env.host = chosen.node` and then `continue`d.
 *    On the NEXT tick `m.env.host` is set, so the `if (!m.env.host && deps.selectNode)`
 *    block is skipped entirely and control falls straight through to a LOCAL spawn — with
 *    `place()` returning `host: <the remote node>`, so `startNativeExecutor` labels the
 *    binding `node: <remote>` for a worker running HERE. Silently, reporting success.
 *    A mission stays in `starved` every tick once past the threshold (`n >= threshold`),
 *    so the second tick always arrives.
 *
 * Step A (this suite): make the node choice REACH the controller, and make the refusal
 * durable rather than one tick deep. Remote SPAWN (relaying to the chosen node) is Step B
 * and is deliberately NOT in here.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { decideNetPlacement, placementAdvisory } from '../mission/mission-engagement';
import { runSupervisorTick, _resetNotMonitorStreak, CONTROLLER_PASS_DIRECTIVE } from '../mission/mission-controller';
import type { SupervisorDeps } from '../mission/mission-controller';
import type { ControllerSession, EngagementState } from '../mission/mission-store';
import type { Mission } from '../mission/mission-model';

const SELF = 'gw4-self';
const PEER = 'gw4-peer';

// ── 1. the decision the safety net makes, as a pure function ────────────────

test('THE REGRESSION: a mission assigned to ANOTHER node is never spawned here', () => {
  // The state the old code reached on tick N+1: env.host already persisted as a peer.
  const d = decideNetPlacement({ host: PEER, chosen: null, thisNode: SELF });
  assert.strictEqual(d.spawnHere, false, 'spawning here would run the work on the wrong machine and label the binding with the peer');
  assert.strictEqual(d.defer?.host, PEER);
  assert.match(d.defer?.reason ?? '', /peer/, 'the refusal must name the host it is deferring to');
});

test('a mission already assigned to THIS node spawns here', () => {
  const d = decideNetPlacement({ host: SELF, chosen: null, thisNode: SELF });
  assert.strictEqual(d.spawnHere, true);
  assert.strictEqual(d.record, undefined, 'nothing new to record — the host was already set');
});

test('no host and nothing eligible → the legacy un-hosted local spawn is preserved', () => {
  const d = decideNetPlacement({ host: undefined, chosen: null, thisNode: SELF });
  assert.strictEqual(d.spawnHere, true);
  assert.strictEqual(d.record, undefined);
  assert.strictEqual(d.defer, undefined);
});

test('no host and the ranker picks THIS node → record the choice AND spawn', () => {
  const d = decideNetPlacement({ host: null, chosen: { node: SELF, why: ['has /repo'] }, thisNode: SELF });
  assert.strictEqual(d.spawnHere, true);
  assert.deepStrictEqual(d.record, { host: SELF, why: ['has /repo'] });
});

test('no host and the ranker picks a PEER → record the choice, do NOT spawn', () => {
  const d = decideNetPlacement({ host: null, chosen: { node: PEER, why: ['has /repo'] }, thisNode: SELF });
  assert.strictEqual(d.spawnHere, false);
  assert.deepStrictEqual(d.record, { host: PEER, why: ['has /repo'] });
  assert.strictEqual(d.defer?.host, PEER);
});

test('an unknown self identity never spawns work claimed by a NAMED host', () => {
  // We cannot prove we are the target, so we must not act as if we were.
  const d = decideNetPlacement({ host: PEER, chosen: null, thisNode: null });
  assert.strictEqual(d.spawnHere, false);
});

// ── 2. the advisory the controller is actually shown ────────────────────────

test('no unplaced work → no advisory at all (never a stray empty section)', () => {
  assert.strictEqual(placementAdvisory([], SELF), '');
});

test('the advisory names the mission, the chosen node and WHY', () => {
  const text = placementAdvisory(
    [{ missionId: 'mission_aaa', host: null, chosen: { node: SELF, why: ['has /home/ubuntu/lm-assist', '0 sessions here'] } }],
    SELF,
  );
  assert.match(text, /mission_aaa/);
  assert.match(text, new RegExp(SELF));
  assert.match(text, /has \/home\/ubuntu\/lm-assist/, 'the reasons must travel with the pick — an unexplained node is not a decision');
  assert.match(text, /node_select/, 'the controller must be told the tool that produced this, so it can look deeper');
});

test('a pick on ANOTHER node tells the controller to defer, not to spawn', () => {
  const text = placementAdvisory(
    [{ missionId: 'mission_bbb', host: null, chosen: { node: PEER, why: ['has /repo'] } }],
    SELF,
  );
  assert.match(text, /ctl:placement-remote/, 'the deferral has to be recorded somewhere a human can see it');
  assert.match(text, /do NOT spawn/i);
});

test('a mission with NO eligible node is still listed — never silently dropped', () => {
  const text = placementAdvisory([{ missionId: 'mission_ccc', host: null, chosen: null }], SELF);
  assert.match(text, /mission_ccc/, 'omitting it would read as "everything is placeable"');
  assert.match(text, /no eligible node/i);
});

test('a ranking that FAILED reads differently from a fleet with no eligible node', () => {
  const failed = placementAdvisory([{ missionId: 'mission_e', host: null, chosen: null, error: 'survey timed out' }], SELF);
  const none = placementAdvisory([{ missionId: 'mission_e', host: null, chosen: null }], SELF);
  assert.match(failed, /survey timed out/, 'a failure to ASK must not be reported as an answer about the fleet');
  assert.notStrictEqual(failed, none);
});

test('a mission ALREADY assigned elsewhere is reported as blocked, not as a fresh pick', () => {
  const text = placementAdvisory([{ missionId: 'mission_ddd', host: PEER, chosen: null }], SELF);
  assert.match(text, /mission_ddd/);
  assert.match(text, new RegExp(PEER));
});

// ── 3. the wiring: the supervisor actually hands it to the controller ───────

const NOW = 1_000_000_000;
const cs: ControllerSession = { node: SELF, sessionId: 'session_ctrl', cse: null, tmux: 'lm-ctrl', startedAt: 1000 };

function readyMission(id: string, over: Partial<Mission> = {}): Mission {
  return {
    id, title: id, objective: 'o', dependsOn: [], projects: [], tags: {}, parentId: null,
    env: { isolation: 'shared', resources: [] }, status: 'waiting', binding: null,
    progress: null, control: { nudgeCount: 0, backoffStep: 0 }, results: [], adjustments: [],
    rev: 1, history: [], ownerNode: SELF, createdAt: 1, updatedAt: 1,
    ...over,
  } as unknown as Mission;
}

function driveDeps(missions: Mission[], over: Partial<SupervisorDeps> = {}): { deps: SupervisorDeps; sent: string[] } {
  const sent: string[] = [];
  let eng: EngagementState = { lastEngagedAt: null, lastActiveIds: [], seen: {} };
  const deps: SupervisorDeps = {
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: SELF }),
    getControllerSession: async () => cs,
    putControllerSession: async () => {},
    isLive: () => true,
    launch: async () => cs,
    drive: async (_cs, directive) => { sent.push(directive ?? ''); },
    teardown: async () => {},
    driveIntervalMin: 5,
    now: NOW,
    listActiveForEngage: async () => missions,
    readSignal: async () => ({ alive: false, gated: false, cursor: 0, newLines: [] }),
    getEngagement: async () => eng,
    putEngagement: async (s) => { eng = s; },
    listAllForSchedule: async () => missions,
    selfId: () => SELF,
    ...over,
  };
  return { deps, sent };
}

test('the drive CARRIES the node recommendation for every unplaced mission', async () => {
  _resetNotMonitorStreak();
  const asked: string[] = [];
  const { deps, sent } = driveDeps([readyMission('mission_x')], {
    selectNode: async (m) => { asked.push(m.id); return { node: SELF, why: ['has /repo'] }; },
  });

  const r = await runSupervisorTick(deps);

  assert.strictEqual(r.action, 'drive');
  assert.deepStrictEqual(asked, ['mission_x'], 'the ranker must be consulted for the mission that needs a host');
  assert.match(sent[0] ?? '', /mission_x/);
  assert.match(sent[0] ?? '', new RegExp(SELF), 'the chosen node has to reach the controller, not just the journal');
  _resetNotMonitorStreak();
});

test('a drive with nothing unplaced is byte-identical to the plain pass directive', async () => {
  _resetNotMonitorStreak();
  const bound = readyMission('mission_y', { status: 'active', binding: { sessionId: 'sid', kind: 'worker' } as never });
  const { deps, sent } = driveDeps([bound], {
    // lastEngagedAt null forces the engage; nothing is schedulable+unbound.
    selectNode: async () => { throw new Error('must not be consulted when there is nothing to place'); },
  });

  await runSupervisorTick(deps);

  assert.strictEqual(sent[0], CONTROLLER_PASS_DIRECTIVE, 'no unplaced work must add no text at all');
  _resetNotMonitorStreak();
});

test('a ranker failure degrades the drive, it never sinks the tick', async () => {
  _resetNotMonitorStreak();
  const { deps, sent } = driveDeps([readyMission('mission_z')], {
    selectNode: async () => { throw new Error('fleet survey unavailable'); },
  });

  const r = await runSupervisorTick(deps);

  assert.strictEqual(r.action, 'drive', 'placement advice is best-effort — the pass still has to happen');
  assert.match(sent[0] ?? '', /mission_z/, 'the mission is still raised, just without a recommendation');
  _resetNotMonitorStreak();
});

// ── 4. the safety net must honour the choice on EVERY tick, not just the first ──
//
// The original persisted `env.host = <peer>` and skipped one tick. The next tick found a
// host already set, skipped the whole selection block, and spawned LOCALLY — labelling the
// binding with a machine the worker was not on. `starved` re-fires every tick past the
// threshold (`n >= threshold`), so that second tick always arrived.

function starvedDeps(m: Mission, over: Partial<SupervisorDeps> = {}): { deps: SupervisorDeps; spawned: string[]; journal: Array<Record<string, unknown>> } {
  const spawned: string[] = [];
  const journal: Array<Record<string, unknown>> = [];
  const { deps } = driveDeps([m], {
    // Already sat unplaced right up to the threshold — this tick is the one that fires.
    getEngagement: async () => ({ lastEngagedAt: NOW - 1000, lastActiveIds: [m.id], seen: {}, unplacedTicks: { [m.id]: 14 } }),
    starvationTicks: 15,
    spawnMission: async (id) => { spawned.push(id); return { ok: true }; },
    journal: (e: unknown) => { journal.push(e as Record<string, unknown>); },
    listClusterRecords: async () => [
      { gatewayId: SELF, cluster: 'prod' },
      { gatewayId: PEER, cluster: 'prod' },
    ],
    myCluster: () => 'prod',
    saveMission: async () => {},
    ...over,
  });
  return { deps, spawned, journal };
}

test('THE REGRESSION, end to end: a starved mission owned by a PEER is not spawned here', async () => {
  _resetNotMonitorStreak();
  const m = readyMission('mission_remote', { env: { isolation: 'shared', resources: [], host: PEER } as never });
  const { deps, spawned, journal } = starvedDeps(m);

  await runSupervisorTick(deps);

  assert.deepStrictEqual(spawned, [], 'spawning here would run the work on this machine under the peer\'s name');
  assert.ok(
    journal.some((e) => String(e.action).includes('remote') && e.missionId === 'mission_remote'),
    `the refusal must be visible every time, not a silent skip; journal=${JSON.stringify(journal)}`,
  );
  _resetNotMonitorStreak();
});

test('a starved mission owned by THIS node still gets placed', async () => {
  _resetNotMonitorStreak();
  const m = readyMission('mission_mine', { env: { isolation: 'shared', resources: [], host: SELF } as never });
  const { deps, spawned } = starvedDeps(m);

  await runSupervisorTick(deps);

  assert.deepStrictEqual(spawned, ['mission_mine'], 'the net must still restore the placement guarantee it exists for');
  _resetNotMonitorStreak();
});

test('a starved mission with no host is assigned by the ranker and then placed', async () => {
  _resetNotMonitorStreak();
  const saved: Mission[] = [];
  const m = readyMission('mission_free');
  const { deps, spawned } = starvedDeps(m, {
    selectNode: async () => ({ node: SELF, why: ['has /repo'] }),
    saveMission: async (x) => { saved.push(x); },
  });

  await runSupervisorTick(deps);

  assert.deepStrictEqual(spawned, ['mission_free']);
  assert.strictEqual(saved[0]?.env.host, SELF, 'the deterministic choice has to be recorded, not just acted on');
  _resetNotMonitorStreak();
});

// ── 5. the standing directive has to name the tool ─────────────────────────

test('controller.pass instructs the controller to consult node_select before placing', () => {
  assert.match(CONTROLLER_PASS_DIRECTIVE, /node_select/,
    'the tool description already claims "The Mission Controller calls this before placing an executor" — the directive must make that true');
  assert.match(CONTROLLER_PASS_DIRECTIVE, /ctl:placement-remote/,
    'and it must say what to do when the pick is not this node');
});

// ── 6. step B: relaying a starved mission to the node that owns it ─────────
//
// Default OFF. On prod this branch is unreachable anyway (cluster `prod` has one member,
// and pickDeterministic eliminates out-of-cluster nodes), so the gate is what keeps it from
// being enabled by accident on a multi-node cluster before it has been proven there.

test('with the relay DISABLED, a starved remote mission is deferred exactly as before', async () => {
  _resetNotMonitorStreak();
  const relayed: string[] = [];
  const m = readyMission('mission_off', { env: { isolation: 'shared', resources: [], host: PEER } as never });
  const { deps, spawned, journal } = starvedDeps(m, {
    relayEnabled: () => false,
    relaySpawn: async (_n: string, id: string) => { relayed.push(id); return { status: 'placed', binding: {} }; },
  });

  await runSupervisorTick(deps);

  assert.deepStrictEqual(relayed, [], 'the gate is the whole point — off means off');
  assert.deepStrictEqual(spawned, [], 'and it must still never spawn a peer\'s mission locally');
  assert.ok(journal.some((e) => String(e.action).includes('remote')));
  _resetNotMonitorStreak();
});

test('with the relay ENABLED, the mission is sent to the node that owns it', async () => {
  _resetNotMonitorStreak();
  const relayed: Array<{ node: string; id: string; requestId: string }> = [];
  const m = readyMission('mission_on', { env: { isolation: 'shared', resources: [], host: PEER } as never });
  const { deps, spawned } = starvedDeps(m, {
    relayEnabled: () => true,
    relaySpawn: async (node: string, id: string, requestId: string) => { relayed.push({ node, id, requestId }); return { status: 'placed', binding: { sessionId: 'sid-remote' } }; },
  });

  await runSupervisorTick(deps);

  assert.strictEqual(relayed.length, 1);
  assert.strictEqual(relayed[0].node, PEER, 'it goes to the OWNING node, not to whoever noticed');
  assert.ok(relayed[0].requestId, 'a relayed spawn without an idempotency key can be double-sent');
  assert.deepStrictEqual(spawned, [], 'relaying replaces the local spawn — it never does both');
  _resetNotMonitorStreak();
});

test('🔴 an UNVERIFIED relay leaves the in-flight marker so the next tick does not re-send', async () => {
  _resetNotMonitorStreak();
  const saved: Mission[] = [];
  const m = readyMission('mission_amb', { env: { isolation: 'shared', resources: [], host: PEER } as never });
  const { deps } = starvedDeps(m, {
    relayEnabled: () => true,
    relaySpawn: async () => ({ status: 'unverified', detail: 'AbortError' }),
    saveMission: async (x) => { saved.push(JSON.parse(JSON.stringify(x))); },
  });

  await runSupervisorTick(deps);

  const last = saved[saved.length - 1];
  assert.ok(last?.control?.spawnInFlight, 'a may-have-landed relay must stay marked, or the next tick sends again');
  assert.strictEqual(last.control.spawnInFlight?.node, PEER);
  _resetNotMonitorStreak();
});

test('a settled relay CLEARS the marker so the mission is retryable', async () => {
  _resetNotMonitorStreak();
  const saved: Mission[] = [];
  const m = readyMission('mission_gone', { env: { isolation: 'shared', resources: [], host: PEER } as never });
  const { deps } = starvedDeps(m, {
    relayEnabled: () => true,
    relaySpawn: async () => ({ status: 'unreachable', detail: 'Worker not found' }),
    saveMission: async (x) => { saved.push(JSON.parse(JSON.stringify(x))); },
  });

  await runSupervisorTick(deps);

  const last = saved[saved.length - 1];
  assert.strictEqual(last?.control?.spawnInFlight, undefined, 'nothing was delivered — holding the marker would strand it');
  _resetNotMonitorStreak();
});
