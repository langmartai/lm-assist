/**
 * bl_939f2dd3 — the supervisor re-flagged GHOST missions in the drive's
 * "UNPLACED MISSIONS — WHERE THEY BELONG" block (2026-08-04/05, three consecutive
 * passes: mission_d725466a / mission_da7dc4ee, absent from every reachable store —
 * mission_list total:0, node_select "no mission", missing from mission_schedule).
 *
 * Root cause, established by reading the code:
 *
 *  • `buildPlacementAdvisory`'s only candidate validation was `byId.get(id)` over the
 *    SAME raw `listAllForSchedule()` list that produced the ids — a tautology. It can
 *    drop an id whose doc vanished, but never a doc the local replica still CARRIES.
 *
 *  • The local `missions` replica can lawfully carry docs the live fleet does not:
 *    the sync engine is pull-only additive LWW (sync-engine.ts `pullOne` — no deletion
 *    reconciliation, a missed 'deleted' notify is never healed) and cluster scoping is
 *    enforced at PULL time only (`shouldPullDataset`) — a doc synced in before a
 *    cluster/fleet split stays forever. Such a stale/foreign doc is schedulable and
 *    unbound, so it enters `readyUnbound` and the advisory every pass, while every
 *    live query surface (leader-anchored mission_list / mission_schedule / node_select
 *    on the reachable stores) answers "no such mission".
 *
 *  • The advisory also skipped the cluster-ownership gate its OWN sibling applies:
 *    `placeStarvedMissions` refuses to act on a mission this cluster does not own
 *    (`placementAllowed`), but the advisory ranked and advertised it anyway.
 *
 * The fix: validate every advisory candidate against the LIVE filtered universe at
 * emission time — the same `computeSchedule(all).ready` + unbound predicate that
 * defines `mission_schedule.ready` (one shared definition, no parallel reimplementation)
 * — plus the SAME `placementAllowed` cluster gate the spawn safety net uses, keyed on
 * `env.host ?? ownerNode`. Cluster-map read failures fail OPEN (advice must never be
 * silenced by a transient read error).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { runSupervisorTick, _resetNotMonitorStreak, CONTROLLER_PASS_DIRECTIVE } from '../mission/mission-controller';
import type { SupervisorDeps } from '../mission/mission-controller';
import type { ControllerSession, EngagementState } from '../mission/mission-store';
import type { Mission } from '../mission/mission-model';

const SELF = 'gw4-self';
const PEER = 'gw4-peer';
// A node of ANOTHER cluster/fleet — deliberately NOT in this cluster's records.
const FOREIGN = 'gw4-foreign-69652c89';

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

/** Same harness shape as mission-node-selection-wiring.test.ts, with the cluster deps
 *  ALWAYS present — the ghost guard must key on injected cluster state, never the real
 *  files of whatever box runs the suite. `listAllForSchedule` takes a function so a test
 *  can serve DIFFERENT store states to successive reads within one tick. */
function driveDeps(
  listAll: () => Mission[],
  over: Partial<SupervisorDeps> = {},
): { deps: SupervisorDeps; sent: string[] } {
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
    listActiveForEngage: async () => [],
    readSignal: async () => ({ alive: true, gated: false, cursor: 0, newLines: [] }),
    getEngagement: async () => eng,
    putEngagement: async (s) => { eng = s; },
    listAllForSchedule: async () => listAll(),
    listClusterRecords: async () => [
      { gatewayId: SELF, cluster: 'prod' },
      { gatewayId: PEER, cluster: 'prod' },
    ],
    myCluster: () => 'prod',
    selfId: () => SELF,
    ...over,
  };
  return { deps, sent };
}

// ── 1. THE REGRESSION: a foreign-store doc must not be ranked ────────────────

test('THE REGRESSION: a ghost owned by a node outside this cluster is NOT in the advisory', async () => {
  _resetNotMonitorStreak();
  const ghost = readyMission('mission_ghost_d725466a', { ownerNode: FOREIGN } as Partial<Mission>);
  const mine = readyMission('mission_mine');
  const { deps, sent } = driveDeps(() => [ghost, mine]);

  const r = await runSupervisorTick(deps);

  assert.strictEqual(r.action, 'drive');
  assert.match(sent[0] ?? '', /mission_mine/, 'the genuinely schedulable in-cluster mission must still be raised');
  assert.doesNotMatch(sent[0] ?? '', /mission_ghost_d725466a/,
    'a doc this cluster does not own must not be ranked — the controller can only report it not-found forever');
  _resetNotMonitorStreak();
});

test('a ghost-only store adds NO advisory block at all', async () => {
  _resetNotMonitorStreak();
  const ghost = readyMission('mission_ghost_da7dc4ee', { ownerNode: FOREIGN } as Partial<Mission>);
  const { deps, sent } = driveDeps(() => [ghost]);

  await runSupervisorTick(deps);

  assert.strictEqual(sent[0], CONTROLLER_PASS_DIRECTIVE,
    'with every candidate a ghost the drive must be byte-identical to the plain pass directive');
  _resetNotMonitorStreak();
});

test('an in-cluster PEER-owned mission is still ranked (the gate is cluster scope, not self)', async () => {
  _resetNotMonitorStreak();
  const peers = readyMission('mission_peer_owned', { ownerNode: PEER } as Partial<Mission>);
  const { deps, sent } = driveDeps(() => [peers]);

  await runSupervisorTick(deps);

  assert.match(sent[0] ?? '', /mission_peer_owned/, 'in-cluster ownership by ANOTHER node is not ghostliness');
  _resetNotMonitorStreak();
});

test('an explicit in-cluster env.host outranks a foreign ownerNode (host is the placement truth)', async () => {
  _resetNotMonitorStreak();
  const adopted = readyMission('mission_adopted', {
    ownerNode: FOREIGN,
    env: { isolation: 'shared', resources: [], host: SELF },
  } as Partial<Mission>);
  const { deps, sent } = driveDeps(() => [adopted]);

  await runSupervisorTick(deps);

  assert.match(sent[0] ?? '', /mission_adopted/,
    'a human pinned this mission to an in-cluster host — that decision owns it here');
  _resetNotMonitorStreak();
});

// ── 2. the advisory must re-validate against the LIVE universe, not its snapshot ──

test('a candidate that left the schedulable universe between snapshot and advisory is dropped', async () => {
  _resetNotMonitorStreak();
  // First read (readyUnbound snapshot): schedulable + unbound. Later reads (the
  // advisory's own): the SAME doc still exists but is no longer schedulable — the
  // presence-only `byId.get(id)` check can never catch this.
  let reads = 0;
  const { deps, sent } = driveDeps(() => {
    reads++;
    return reads === 1
      ? [readyMission('mission_done_race')]
      : [readyMission('mission_done_race', { status: 'done' } as Partial<Mission>)];
  });

  await runSupervisorTick(deps);

  assert.ok(reads >= 2, `the advisory must RE-READ the store, not trust the snapshot (reads=${reads})`);
  assert.strictEqual(sent[0], CONTROLLER_PASS_DIRECTIVE,
    'a mission that is done by emission time must not be advertised as unplaced');
  _resetNotMonitorStreak();
});

test('a candidate BOUND between snapshot and advisory is dropped', async () => {
  _resetNotMonitorStreak();
  // The starvation safety net runs BETWEEN the readyUnbound snapshot and the advisory —
  // a mission it just placed must not also be advertised as unplaced.
  let reads = 0;
  const { deps, sent } = driveDeps(() => {
    reads++;
    return reads === 1
      ? [readyMission('mission_bound_race')]
      : [readyMission('mission_bound_race', { binding: { sessionId: 'sid-placed', kind: 'worker' } } as unknown as Partial<Mission>)];
  });

  await runSupervisorTick(deps);

  assert.strictEqual(sent[0], CONTROLLER_PASS_DIRECTIVE,
    'a mission with an executor must not be advertised as unplaced');
  _resetNotMonitorStreak();
});

test('an id whose doc vanished entirely stays dropped (the pre-existing guard still holds)', async () => {
  _resetNotMonitorStreak();
  let reads = 0;
  const { deps, sent } = driveDeps(() => {
    reads++;
    return reads === 1 ? [readyMission('mission_deleted_race')] : [];
  });

  await runSupervisorTick(deps);

  assert.strictEqual(sent[0], CONTROLLER_PASS_DIRECTIVE);
  _resetNotMonitorStreak();
});

// ── 3. failure posture: advice fails OPEN ────────────────────────────────────

test('a cluster-map read failure never silences in-cluster advice', async () => {
  _resetNotMonitorStreak();
  const mine = readyMission('mission_still_advised');
  const { deps, sent } = driveDeps(() => [mine], {
    listClusterRecords: async () => { throw new Error('cluster map not warmed'); },
  });

  const r = await runSupervisorTick(deps);

  assert.strictEqual(r.action, 'drive', 'placement advice is best-effort — the pass still happens');
  assert.match(sent[0] ?? '', /mission_still_advised/,
    'the ownership check is skipped on a read failure — advice fails open, never dark');
  _resetNotMonitorStreak();
});
