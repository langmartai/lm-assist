/**
 * Missions created through the API never started (bl_28543c78, 2026-07-26).
 *
 * Four deterministic defects, verified live on prod 117 before this suite existed:
 *
 *  1. `newMission` was born `status:'active'`, but the scheduler only starts
 *     {draft,waiting,blocked} — so an API-created mission was invisible to it forever.
 *     `active` is a RUNTIME state the controller writes after `startExecutor`
 *     (mission-controller.ts) and that `isRunning()` reads, so `waiting` is the
 *     correct birth state.
 *  2. `newMission` rebuilt `env` field-by-field and omitted `effort` — so the MCP
 *     alias (`liftEffort`) and the route's own validation both worked and the value
 *     was still discarded by the constructor, one hop later.
 *  3. `handleMissionSpawn` set `binding` but never `status`, so a manually-spawned
 *     mission stayed `waiting`+bound and sat in `computeSchedule().ready` FOREVER —
 *     which is what made "ready but never placed" look like a broken placement loop.
 *  4. A non-absolute `env.repo` resolved against Core's cwd (its npm install dir) and
 *     died deep in git as a bare `spawnSync git ENOENT`, which reads as a missing git
 *     binary and is actually a bad cwd. Rejected at the boundary instead.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { newMission, coarseActor, type Mission } from '../mission/mission-model';
import { computeSchedule, isSchedulableStatus } from '../mission/mission-scheduler';
import { shouldEngage, advanceStarvation } from '../mission/mission-engagement';
import { MissionDataPort } from '../mission/mission-store';
import { handleCreate, handlePatch, handleMissionSpawn, handlePlace, type MissionSpawnDeps } from '../routes/core/mission.routes';

function fakePort(): MissionDataPort {
  const map = new Map<string, Mission>();
  return {
    isEnabled: () => true,
    get: async (id) => map.get(id) ?? null,
    list: async () => [...map.values()],
    put: async (m) => { map.set(m.id, JSON.parse(JSON.stringify(m))); },
    del: async (id) => { map.delete(id); },
  };
}

const actor = () => coarseActor('api', 'gw4-1', 1000);

// ── 1. birth status ─────────────────────────────────────────────────────────

test('newMission is born WAITING — active means an executor is already running it', () => {
  const m = newMission({ title: 'T', objective: 'O', ownerNode: 'gw4-1', createdBy: actor() }, 1000, () => 'mission_a');
  assert.strictEqual(m.status, 'waiting');
  assert.strictEqual(m.binding, null, 'a newborn mission has no executor');
});

test('a freshly created mission is SCHEDULABLE — it reaches computeSchedule().ready', async () => {
  const port = fakePort();
  const created = await handleCreate({ title: 'T', objective: 'O' }, 'gw4-1', port, actor());
  assert.strictEqual(created.success, true);
  const id = (created.data as Mission).id;

  const sched = computeSchedule(await port.list());
  assert.ok(
    sched.ready.includes(id),
    `a mission created through the API must be startable; ready=${JSON.stringify(sched.ready)}`,
  );
});

// ── 2. env.effort survives the constructor ──────────────────────────────────

test('newMission keeps env.effort — the constructor used to drop it', () => {
  const m = newMission(
    { title: 'T', objective: 'O', ownerNode: 'gw4-1', createdBy: actor(), env: { isolation: 'cloud', effort: 'max' } },
    1000, () => 'mission_b',
  );
  assert.strictEqual(m.env.effort, 'max');
});

test('handleCreate persists a valid env.effort end-to-end', async () => {
  const port = fakePort();
  const r = await handleCreate({ title: 'T', objective: 'O', env: { effort: 'max' } }, 'gw4-1', port, actor());
  assert.strictEqual(r.success, true);
  assert.strictEqual((r.data as Mission).env.effort, 'max');
});

test('handleCreate still refuses an INVALID effort rather than storing it', async () => {
  const port = fakePort();
  const r = await handleCreate({ title: 'T', objective: 'O', env: { effort: 'turbo' } }, 'gw4-1', port, actor());
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error?.code, 'INVALID_EFFORT');
});

// ── 3. spawn must leave the mission RUNNING, not schedulable ────────────────

const spawnDeps = (over: Partial<MissionSpawnDeps> = {}, calls: Record<string, unknown[]> = {}): MissionSpawnDeps => ({
  getMission: async (id) => (id === 'mission_sp1'
    ? { id: 'mission_sp1', title: 'Spawn me', objective: 'obj', status: 'waiting', binding: null, env: { repo: '/repo' } }
    : null),
  listMissions: async () => [],
  place: () => ({ go: true, env: 'worktree', repo: '/repo', branch: 'feat/x' }) as never,
  startNative: async () => ({ sessionId: 'uuid-new', node: 'local', kind: 'worker', boundAt: 1 }) as never,
  buildNativeDeps: async () => ({ fake: true }) as never,
  persist: async (m) => { (calls.persist ??= []).push(JSON.parse(JSON.stringify(m))); },
  ...over,
});

test('spawn flips the mission to ACTIVE so it leaves the ready list', async () => {
  const calls: Record<string, unknown[]> = {};
  const r = await handleMissionSpawn('mission_sp1', {}, spawnDeps({}, calls));
  assert.strictEqual(r.success, true);

  const persisted = calls.persist?.[0] as { status?: string; binding?: { sessionId?: string } };
  assert.ok(persisted, 'spawn must persist the mission');
  assert.strictEqual(persisted.binding?.sessionId, 'uuid-new');
  assert.strictEqual(persisted.status, 'active', 'a spawned mission is RUNNING, not still queued');
});

test('a bound+active mission is NOT offered for placement again', () => {
  const bound = {
    id: 'mission_run', title: 't', objective: 'o', dependsOn: [], projects: [], tags: {}, parentId: null,
    env: { isolation: 'worktree', resources: [] }, status: 'active',
    binding: { sessionId: 'sid-1', kind: 'worker' },
    progress: null, control: { nudgeCount: 0, backoffStep: 0 }, results: [], adjustments: [],
    rev: 1, history: [], ownerNode: 'gw4-1', createdAt: 1, updatedAt: 1,
  } as unknown as Mission;
  const sched = computeSchedule([bound]);
  assert.ok(!sched.ready.includes('mission_run'), 'a mission with a live executor must not be in ready');
});

// ── 4. env.repo must be absolute ────────────────────────────────────────────

test('handleCreate REJECTS a relative env.repo instead of failing later in git', async () => {
  const port = fakePort();
  const r = await handleCreate(
    { title: 'T', objective: 'O', env: { isolation: 'worktree', repo: 'lm-assist' } }, 'gw4-1', port, actor(),
  );
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error?.code, 'INVALID_REPO');
  assert.match(r.error?.message ?? '', /absolute/i);
  assert.match(r.error?.message ?? '', /lm-assist/, 'the refusal must echo what was sent');
});

test('handleCreate accepts an absolute env.repo', async () => {
  const port = fakePort();
  const r = await handleCreate(
    { title: 'T', objective: 'O', env: { isolation: 'worktree', repo: '/home/ubuntu/lm-assist' } }, 'gw4-1', port, actor(),
  );
  assert.strictEqual(r.success, true);
  assert.strictEqual((r.data as Mission).env.repo, '/home/ubuntu/lm-assist');
});

test('handlePatch also REJECTS a relative env.repo', async () => {
  const port = fakePort();
  const created = await handleCreate({ title: 'T', objective: 'O' }, 'gw4-1', port, actor());
  const id = (created.data as Mission).id;

  const r = await handlePatch(id, { env: { repo: 'lm-assist' } }, port, actor());
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error?.code, 'INVALID_REPO');
});

// ── 4b. default isolation is NATIVE, and the flavour follows the work ───────
//
// `cloud` was the default, and neither mission_spawn nor the supervisor safety net
// can place a cloud mission (CLOUD_PLACEMENT — it needs ccr_cloud_start). So the
// most common mission in the fleet was precisely the one no automated placement
// path could rescue (bl_1c861246).

test('a mission with a repo is born WORKTREE — branch isolation', async () => {
  const port = fakePort();
  const r = await handleCreate(
    { title: 'T', objective: 'O', env: { repo: '/home/ubuntu/lm-assist' } }, 'gw4-1', port, actor(),
  );
  assert.strictEqual(r.success, true);
  assert.strictEqual((r.data as Mission).env.isolation, 'worktree');
});

test('a repo-less mission is born SHARED, not cloud — it must stay placeable', async () => {
  const port = fakePort();
  const r = await handleCreate({ title: 'T', objective: 'O' }, 'gw4-1', port, actor());
  assert.strictEqual((r.data as Mission).env.isolation, 'shared',
    'research/fleet-ops work has no repo, but must still be spawnable by the net');
});

test('an EXPLICIT cloud request is still honoured — it is opt-in, not removed', async () => {
  const port = fakePort();
  const r = await handleCreate(
    { title: 'T', objective: 'O', env: { isolation: 'cloud' } }, 'gw4-1', port, actor(),
  );
  assert.strictEqual((r.data as Mission).env.isolation, 'cloud');
});

// ── 5. mission_place must not report go:true for something never scheduled ──
//
// The trap that HID defect 1: an operator checks placement, sees go:true, and concludes
// the mission is queued. `place()` itself stays status-blind on purpose (the controller
// calls it on `active` missions during nudge/rebind); the API surface applies the filter.

test('handlePlace refuses a non-schedulable mission and NAMES the status', async () => {
  const port = fakePort();
  const created = await handleCreate({ title: 'T', objective: 'O' }, 'gw4-1', port, actor());
  const id = (created.data as Mission).id;
  await handlePatch(id, { status: 'active' }, port, actor());

  const r = await handlePlace(id, port);
  assert.strictEqual(r.success, true);
  const d = r.data as { go: boolean; reason?: string; status?: string; schedulable?: boolean; detail?: string };
  assert.strictEqual(d.go, false, 'an active mission is never scheduled — go:true would be a false confirmation');
  assert.strictEqual(d.reason, 'status');
  assert.strictEqual(d.status, 'active');
  assert.strictEqual(d.schedulable, false);
  assert.match(d.detail ?? '', /active/, 'the refusal must name the disqualifying status');
});

test('handlePlace still evaluates deps/resources for a SCHEDULABLE mission', async () => {
  const port = fakePort();
  const created = await handleCreate({ title: 'T', objective: 'O' }, 'gw4-1', port, actor());
  const r = await handlePlace((created.data as Mission).id, port);
  const d = r.data as { go: boolean; schedulable?: boolean; status?: string };
  assert.strictEqual(d.go, true);
  assert.strictEqual(d.schedulable, true);
  assert.strictEqual(d.status, 'waiting');
});

test('isSchedulableStatus is the ONE definition both surfaces read', () => {
  for (const s of ['draft', 'waiting', 'blocked'] as const) assert.ok(isSchedulableStatus(s), s);
  for (const s of ['active', 'paused', 'done', 'failed'] as const) assert.ok(!isSchedulableStatus(s), s);
});

// ── 6. unplaced work must be able to re-raise itself (defect 5) ──────────────
//
// Measured on prod 2026-07-26: a mission flipped active→waiting at 12:30:33 produced NO
// supervisor tick until 12:48:45. `activeIds` covers active AND waiting, so the flip that
// made it schedulable did not change the set; and an unbound mission has no executor, so
// it can never raise materialCount. Nothing could see it.

const base = {
  now: 1_000_000,
  lastEngagedAt: 900_000,
  safetyIntervalMin: 45,
  materialCount: 0,
  activeIds: ['mission_a'],
  lastActiveIds: ['mission_a'],
  anyUpdateSinceEngage: false,
};

test('THE REGRESSION: an unplaced mission engages even when nothing else changed', () => {
  // Exactly the prod shape: same id set, no executor activity, mission now schedulable.
  assert.strictEqual(shouldEngage({ ...base, readyUnbound: [], lastReadyUnbound: [] }), false,
    'control: with nothing to place this tick stays idle');
  assert.strictEqual(shouldEngage({ ...base, readyUnbound: ['mission_a'], lastReadyUnbound: [] }), true,
    'a mission needing placement must re-engage the controller');
});

test('an ALREADY-RAISED unplaced set does not re-engage every tick', () => {
  assert.strictEqual(
    shouldEngage({ ...base, readyUnbound: ['mission_a'], lastReadyUnbound: ['mission_a'] }),
    false,
    'the controller was already shown this exact set — re-driving every tick would burn an LLM pass a minute',
  );
});

test('…but it IS re-raised once placementRetryMin has elapsed', () => {
  assert.strictEqual(
    shouldEngage({
      ...base, now: 900_000 + 11 * 60_000,
      readyUnbound: ['mission_a'], lastReadyUnbound: ['mission_a'], placementRetryMin: 10,
    }),
    true,
    'a declined placement must be asked again, not never again',
  );
});

test('omitting the new fields preserves the old behavior exactly', () => {
  assert.strictEqual(shouldEngage(base), false);
  assert.strictEqual(shouldEngage({ ...base, materialCount: 1 }), true);
  assert.strictEqual(shouldEngage({ ...base, lastActiveIds: [] }), true);
});

test('starvation counts only CONSECUTIVE unplaced ticks and resets on placement', () => {
  let s = advanceStarvation(['m1'], undefined, 3);
  assert.deepStrictEqual(s.next, { m1: 1 });
  assert.deepStrictEqual(s.starved, []);

  s = advanceStarvation(['m1'], s.next, 3);
  assert.deepStrictEqual(s.starved, [], 'not yet at the threshold');

  s = advanceStarvation(['m1'], s.next, 3);
  assert.deepStrictEqual(s.starved, ['m1'], 'threshold reached → the net fires');

  // Placed (or paused/done) → it leaves readyUnbound and its counter must not persist.
  const after = advanceStarvation([], s.next, 3);
  assert.deepStrictEqual(after.next, {}, 'a placed mission must not carry a stale counter');
  const back = advanceStarvation(['m1'], after.next, 3);
  assert.deepStrictEqual(back.starved, [], 'and if it returns it starts counting from scratch');
});
