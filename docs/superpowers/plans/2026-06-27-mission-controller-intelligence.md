# Mission Controller Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the elected Mission Controller use the new mission data (tags, parentId, dependsOn, version history) to schedule parallel-vs-sequence, manage epics, smart-tag its own decisions, and react to external changes — via a deterministic scheduler module the LLM controller consumes plus expanded controller prompting.

**Architecture:** A pure `mission-scheduler.ts` computes a deterministic `Schedule` (ready / blocked / serialize-groups / epic-rollups / containers) by reusing `place()`; a pure `mission-changes.ts` surfaces external (non-controller) edits; both are exposed as read-only MCP tools (`mission_schedule`, `mission_changes`) over POST routes; the controller's own MCP writes are attributed `channel:'controller'` via a server-side actor upgrade; and the controller system prompt + pass directive are expanded to consume the schedule, react to external changes, roll up epics, and record decisions as reserved `ctl:*` tags.

**Tech Stack:** TypeScript (core, CommonJS). Pure modules in `core/src/mission/`; MCP tools in `core/src/mcp-server/tools/`; routes in `core/src/routes/core/mission.routes.ts`. Tests use the Node built-in runner (`node:test` + `node:assert`) in `core/src/__tests__/`.

## Global Constraints

- **Test runner:** `node:test` + `node:assert` only (no vitest/jest). Test files live in `core/src/__tests__/*.test.ts`. Run ALL: `cd core && npm run test`. Run ONE file (faster TDD): `cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/<file>.test.js`. Before any impl module exists, `npm run build:test` fails to compile (module-not-found) — that IS the red step.
- **Reads are leader-anchored `failClosed=false`** (fall back to local synced copy on proxy error); writes are `failClosed=true`. New tools here are READS.
- **Route ordering:** every single-segment literal route (`/mission/schedule`, `/mission/changes`) MUST be registered BEFORE any `/mission/(?<id>[^/]+)` pattern, or it matches `/mission/:id`.
- **Boot-critical scopes:** every advertised MCP tool MUST have an entry in `TOOL_SCOPES` (`core/src/mcp-server/configure.ts`) — `assertScopesCoverTools()` throws at startup otherwise.
- **MCP numeric args arrive as strings** over the connector — coerce (`parseInt` + `Number.isNaN` guard).
- **`ctl:` is the controller-reserved tag dimension prefix.** The controller writes only `ctl:*` dimensions (`ctl:readiness`, `ctl:serialize-group`, `ctl:phase`); it never writes author dimensions (project/feature/component).
- **The scheduler NEVER writes.** It computes; the LLM controller applies (epic-rollup status, ctl: tags) via existing write tools.
- **Do NOT bump the version or deploy.** This sub-project merges to main locally; the single program deploy (sub-projects 1+2+3+4) happens after this, separately.
- **Do NOT add dependencies.** chokidar stays `^3.6.0` (unrelated, but never bump it).

---

## File Structure

- **Create** `core/src/mission/mission-scheduler.ts` — pure `computeSchedule(missions): Schedule`. One responsibility: the deterministic schedule.
- **Create** `core/src/mission/mission-changes.ts` — pure `recentExternalChanges(missions, opts): ExternalChange[]`. One responsibility: external-change surfacing.
- **Create** `core/src/mcp-server/tools/mission-schedule.ts` — the 2 read tool defs + handlers (proxy the 2 routes).
- **Modify** `core/src/mission/mission-actor.ts` — add pure `upgradeControllerActor(actor, controllerSessionId)`.
- **Modify** `core/src/routes/core/mission.routes.ts` — add `handleSchedule`/`handleChanges` + 2 routes (before `/:id`); upgrade `actorFor` to stamp `channel:'controller'`.
- **Modify** `core/src/mcp-server/tools/expanded.ts` — register the 2 tool defs + handlers.
- **Modify** `core/src/mcp-server/configure.ts` — add 2 `read` scopes.
- **Modify** `core/src/mission/mission-controller.ts` — expand `CONTROLLER_SYSTEM_PROMPT` + `CONTROLLER_PASS_DIRECTIVE`.
- **Modify** `core/src/mcp-server/tools/guide.ts` — add scheduling-intelligence to the `mission-controller` topic.
- **Tests:** `core/src/__tests__/mission-scheduler.test.ts`, `mission-changes.test.ts`, `mission-actor-controller.test.ts`, `mission-schedule-routes.test.ts`, `mission-schedule-tools.test.ts`, `mission-controller-prompt.test.ts`.

---

### Task 1: Deterministic scheduler (`mission-scheduler.ts`)

**Files:**
- Create: `core/src/mission/mission-scheduler.ts`
- Test: `core/src/__tests__/mission-scheduler.test.ts`

**Interfaces:**
- Consumes: `Mission`, `MissionStatus`, `place` from `../mission/mission-model` (`place(m, all): PlacementDecision` where a block is `{go:false, reason:'dependency', waitOn:string[]}` or `{go:false, reason:'resource', conflictWith:string}`, and success is `{go:true, ...}`).
- Produces (Task 4 consumes): `computeSchedule(missions: Mission[]): Schedule`; `CTL_SERIALIZE_DIM` constant; types `Schedule`, `BlockReason`, `BlockedEntry`, `SerializeGroup`, `EpicRollup`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-scheduler.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { computeSchedule, CTL_SERIALIZE_DIM } from '../mission/mission-scheduler';
import { newMission, type Mission, type MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
const mk = (id: string, over: Partial<Mission> = {}): Mission =>
  ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: actor }, 1, () => id), id, ...over });

test('ready: a draft mission with no deps is ready', () => {
  const s = computeSchedule([mk('a', { status: 'draft' })]);
  assert.deepEqual(s.ready, ['a']);
  assert.deepEqual(s.blocked, []);
});

test('blocked dependency: waits until the dep is done', () => {
  const s = computeSchedule([mk('a', { status: 'waiting', dependsOn: ['b'] }), mk('b', { status: 'active' })]);
  assert.deepEqual(s.ready, []);
  assert.deepEqual(s.blocked, [{ id: 'a', reason: 'dependency', waitOn: ['b'] }]);
});

test('dependency met: becomes ready when the dep is done', () => {
  const s = computeSchedule([mk('a', { status: 'waiting', dependsOn: ['b'] }), mk('b', { status: 'done' })]);
  assert.deepEqual(s.ready, ['a']);
});

test('containers: a parent with children is a container, never ready; children are scheduled', () => {
  const s = computeSchedule([mk('epic', { status: 'active' }), mk('c1', { status: 'draft', parentId: 'epic' })]);
  assert.deepEqual(s.containers, ['epic']);
  assert.ok(!s.ready.includes('epic'));
  assert.ok(s.ready.includes('c1'));
});

test('epic rollup: all children done -> done, progress 100', () => {
  const s = computeSchedule([mk('epic', { status: 'active' }), mk('c1', { status: 'done', parentId: 'epic' }), mk('c2', { status: 'done', parentId: 'epic' })]);
  assert.deepEqual(s.epicRollups, [{ parentId: 'epic', status: 'done', progressPercent: 100, childCount: 2, doneCount: 2 }]);
});

test('epic rollup: any active -> active; mixed progress', () => {
  const s = computeSchedule([mk('epic', { status: 'waiting' }), mk('c1', { status: 'done', parentId: 'epic' }), mk('c2', { status: 'active', parentId: 'epic' })]);
  assert.deepEqual(s.epicRollups, [{ parentId: 'epic', status: 'active', progressPercent: 50, childCount: 2, doneCount: 1 }]);
});

test('serialize: a non-running member is serialize-blocked when a group member is active', () => {
  const s = computeSchedule([
    mk('a', { status: 'active', tags: { [CTL_SERIALIZE_DIM]: ['g'] } }),
    mk('b', { status: 'waiting', tags: { [CTL_SERIALIZE_DIM]: ['g'] } }),
  ]);
  assert.deepEqual(s.serializeGroups, [{ group: 'g', missionIds: ['a', 'b'], running: 'a' }]);
  assert.deepEqual(s.blocked, [{ id: 'b', reason: 'serialize' }]);
});

test('serialize: with no running member, members fall through to normal placement (both ready)', () => {
  const s = computeSchedule([
    mk('a', { status: 'waiting', tags: { [CTL_SERIALIZE_DIM]: ['g'] } }),
    mk('b', { status: 'waiting', tags: { [CTL_SERIALIZE_DIM]: ['g'] } }),
  ]);
  assert.equal(s.serializeGroups[0].running, null);
  assert.deepEqual(s.ready.sort(), ['a', 'b']);
});

test('missing parent: a child pointing at a non-existent parent is blocked with reason parent', () => {
  const s = computeSchedule([mk('a', { status: 'draft', parentId: 'ghost' })]);
  assert.deepEqual(s.blocked, [{ id: 'a', reason: 'parent', waitOn: ['ghost'] }]);
});

test('terminal + paused + active are neither ready nor blocked', () => {
  const s = computeSchedule([mk('a', { status: 'done' }), mk('b', { status: 'failed' }), mk('c', { status: 'paused' }), mk('d', { status: 'active' })]);
  assert.deepEqual(s.ready, []);
  assert.deepEqual(s.blocked, []);
});
```

- [ ] **Step 2: Run it to confirm it fails** — `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5`. Expected: compile FAILS with `Cannot find module '../mission/mission-scheduler'`.

- [ ] **Step 3: Write the implementation** — `core/src/mission/mission-scheduler.ts`

```ts
// Pure deterministic mission scheduler. Computes a Schedule from the mission set; never writes.
import { Mission, MissionStatus, place } from './mission-model';

export type BlockReason = 'dependency' | 'parent' | 'resource' | 'serialize';
export interface BlockedEntry { id: string; reason: BlockReason; waitOn?: string[]; }
export interface SerializeGroup { group: string; missionIds: string[]; running: string | null; }
export interface EpicRollup { parentId: string; status: MissionStatus; progressPercent: number; childCount: number; doneCount: number; }
export interface Schedule {
  ready: string[];
  blocked: BlockedEntry[];
  serializeGroups: SerializeGroup[];
  epicRollups: EpicRollup[];
  containers: string[];
}

/** Reserved controller-owned tag dimension: missions sharing a value run one-at-a-time. */
export const CTL_SERIALIZE_DIM = 'ctl:serialize-group';
/** Statuses that are candidates to START now (active=running, paused=held, done/failed=terminal are excluded). */
const SCHEDULABLE = new Set<MissionStatus>(['draft', 'waiting', 'blocked']);

export function computeSchedule(missions: Mission[]): Schedule {
  const byId = new Map(missions.map((m) => [m.id, m]));

  // Containers + children: a container is any id referenced by an existing child's parentId.
  const childrenByParent = new Map<string, Mission[]>();
  for (const m of missions) {
    if (m.parentId && byId.has(m.parentId)) {
      const arr = childrenByParent.get(m.parentId);
      if (arr) arr.push(m); else childrenByParent.set(m.parentId, [m]);
    }
  }
  const containers = [...childrenByParent.keys()];
  const containerSet = new Set(containers);

  // Epic rollups — computed only; the controller applies them via mission_update.
  const epicRollups: EpicRollup[] = containers.map((parentId) => {
    const children = childrenByParent.get(parentId)!;
    const childCount = children.length;
    const doneCount = children.filter((c) => c.status === 'done').length;
    let status: MissionStatus;
    if (children.every((c) => c.status === 'done')) status = 'done';
    else if (children.some((c) => c.status === 'active')) status = 'active';
    else if (children.some((c) => c.status === 'blocked')) status = 'blocked';
    else status = 'waiting';
    return { parentId, status, progressPercent: Math.round((100 * doneCount) / childCount), childCount, doneCount };
  });

  // Serialize groups — missions sharing a ctl:serialize-group tag value.
  const members = new Map<string, Mission[]>();
  for (const m of missions) {
    for (const g of m.tags?.[CTL_SERIALIZE_DIM] ?? []) {
      const arr = members.get(g);
      if (arr) arr.push(m); else members.set(g, [m]);
    }
  }
  const serializeGroups: SerializeGroup[] = [...members.entries()].map(([group, ms]) => ({
    group,
    missionIds: ms.map((m) => m.id),
    running: ms.find((m) => m.status === 'active')?.id ?? null,
  }));
  // A mission is serialize-blocked iff it is a non-terminal, non-running member of a group that HAS a running member.
  const serializeBlocked = new Set<string>();
  for (const grp of serializeGroups) {
    if (!grp.running) continue;
    for (const id of grp.missionIds) {
      if (id === grp.running) continue;
      const m = byId.get(id);
      if (m && m.status !== 'done' && m.status !== 'failed') serializeBlocked.add(id);
    }
  }

  const ready: string[] = [];
  const blocked: BlockedEntry[] = [];
  for (const m of missions) {
    if (containerSet.has(m.id)) continue;       // epic container — rolled up, not executed
    if (!SCHEDULABLE.has(m.status)) continue;   // active/paused/done/failed
    if (m.parentId && !byId.has(m.parentId)) { blocked.push({ id: m.id, reason: 'parent', waitOn: [m.parentId] }); continue; }
    if (serializeBlocked.has(m.id)) { blocked.push({ id: m.id, reason: 'serialize' }); continue; }
    const p = place(m, missions);
    if (p.go) ready.push(m.id);
    else if (p.reason === 'dependency') blocked.push({ id: m.id, reason: 'dependency', waitOn: p.waitOn });
    else blocked.push({ id: m.id, reason: 'resource' });
  }

  return { ready, blocked, serializeGroups, epicRollups, containers };
}
```

- [ ] **Step 4: Run the test to confirm it passes** — `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/mission-scheduler.test.js`. Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/mission/mission-scheduler.ts core/src/__tests__/mission-scheduler.test.ts && git commit -m "feat(mission): deterministic mission scheduler (ready/blocked/serialize/epic-rollup)"
```

---

### Task 2: External-change surfacing (`mission-changes.ts`)

**Files:**
- Create: `core/src/mission/mission-changes.ts`
- Test: `core/src/__tests__/mission-changes.test.ts`

**Interfaces:**
- Consumes: `Mission`, `MissionActor`, `MissionChange` from `./mission-model` (`MissionChange = { rev:number; at:number; actor:MissionActor; changes:Record<string,{from,to}> }`; a mission carries `history: MissionChange[]`).
- Produces (Task 4 consumes): `recentExternalChanges(missions, opts): ExternalChange[]`; type `ExternalChange`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-changes.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { recentExternalChanges } from '../mission/mission-changes';
import { newMission, type Mission, type MissionActor, type MissionChange } from '../mission/mission-model';

const user: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 10 };
const ctrl: MissionActor = { kind: 'controller', channel: 'controller', node: 'n', at: 10 };
const mk = (id: string, history: MissionChange[]): Mission =>
  ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: user }, 1, () => id), id, history });

test('excludes controller-channel changes, keeps external ones', () => {
  const m = mk('a', [
    { rev: 1, at: 100, actor: ctrl, changes: { 'ctl:readiness': { from: null, to: 'ready' } } },
    { rev: 2, at: 200, actor: user, changes: { objective: { from: 'o', to: 'o2' } } },
  ]);
  const r = recentExternalChanges([m]);
  assert.equal(r.length, 1);
  assert.equal(r[0].rev, 2);
  assert.deepEqual(r[0].changedFields, ['objective']);
});

test('sinceRev boundary: rev <= since is excluded', () => {
  const m = mk('a', [
    { rev: 1, at: 100, actor: user, changes: { title: { from: 'a', to: 'a1' } } },
    { rev: 2, at: 200, actor: user, changes: { title: { from: 'a1', to: 'a2' } } },
  ]);
  const r = recentExternalChanges([m], { sinceRev: { a: 1 } });
  assert.deepEqual(r.map((c) => c.rev), [2]);
});

test('newest-first ordering across missions', () => {
  const a = mk('a', [{ rev: 5, at: 500, actor: user, changes: { title: { from: 'x', to: 'y' } } }]);
  const b = mk('b', [{ rev: 9, at: 900, actor: user, changes: { title: { from: 'x', to: 'y' } } }]);
  const r = recentExternalChanges([a, b]);
  assert.deepEqual(r.map((c) => c.missionId), ['b', 'a']);
});

test('empty history yields nothing', () => {
  assert.deepEqual(recentExternalChanges([mk('a', [])]), []);
});
```

- [ ] **Step 2: Run it to confirm it fails** — `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5`. Expected: compile FAILS with `Cannot find module '../mission/mission-changes'`.

- [ ] **Step 3: Write the implementation** — `core/src/mission/mission-changes.ts`

```ts
// Pure surfacing of recent EXTERNAL (non-controller) mission edits, newest-first.
import { Mission, MissionActor } from './mission-model';

export interface ExternalChange { missionId: string; rev: number; at: number; actor: MissionActor; changedFields: string[]; }

export function recentExternalChanges(
  missions: Mission[],
  opts: { sinceRev?: Record<string, number>; sinceTs?: number; excludeChannel?: string } = {},
): ExternalChange[] {
  const excludeChannel = opts.excludeChannel ?? 'controller';
  const out: ExternalChange[] = [];
  for (const m of missions) {
    const since = opts.sinceRev?.[m.id];
    for (const ch of m.history ?? []) {
      if (ch.actor?.channel === excludeChannel) continue;
      if (since != null && ch.rev <= since) continue;
      if (opts.sinceTs != null && ch.at <= opts.sinceTs) continue;
      out.push({ missionId: m.id, rev: ch.rev, at: ch.at, actor: ch.actor, changedFields: Object.keys(ch.changes ?? {}) });
    }
  }
  out.sort((a, b) => b.at - a.at || b.rev - a.rev);
  return out;
}
```

- [ ] **Step 4: Run the test to confirm it passes** — `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/mission-changes.test.js`. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/mission/mission-changes.ts core/src/__tests__/mission-changes.test.ts && git commit -m "feat(mission): recentExternalChanges — surface non-controller edits"
```

---

### Task 3: Controller write attribution (`upgradeControllerActor` + `actorFor`)

**Files:**
- Modify: `core/src/mission/mission-actor.ts` (add the pure helper)
- Modify: `core/src/routes/core/mission.routes.ts` (`actorFor`, ~line 82-87)
- Test: `core/src/__tests__/mission-actor-controller.test.ts`

**Interfaces:**
- Consumes: `MissionActor` from `./mission-model`; `getControllerSession` from `../mission/mission-store` (returns `{ sessionId: string, ... } | null`); existing `resolveMcpActor`, `coarseActor`, `thisNode`.
- Produces: `upgradeControllerActor(actor: MissionActor, controllerSessionId: string | null | undefined): MissionActor` from `mission-actor`; `actorFor` now stamps `channel:'controller'` for the controller session.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-actor-controller.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { upgradeControllerActor } from '../mission/mission-actor';
import type { MissionActor } from '../mission/mission-model';

const base: MissionActor = { kind: 'local-session', id: 'sess-123', node: 'n', channel: 'mcp', at: 1 };

test('upgrades a local-session whose id is the controller session to channel:controller', () => {
  const up = upgradeControllerActor(base, 'sess-123');
  assert.equal(up.kind, 'controller');
  assert.equal(up.channel, 'controller');
  assert.equal(up.id, 'sess-123');
});

test('leaves a non-controller local-session unchanged', () => {
  const up = upgradeControllerActor(base, 'other-session');
  assert.equal(up.kind, 'local-session');
  assert.equal(up.channel, 'mcp');
});

test('no controller session id -> unchanged', () => {
  assert.equal(upgradeControllerActor(base, null).channel, 'mcp');
  assert.equal(upgradeControllerActor(base, undefined).channel, 'mcp');
});

test('a non-local-session actor is never upgraded even on id match', () => {
  const ai: MissionActor = { kind: 'claudeai-conversation', id: 'sess-123', channel: 'mcp', at: 1 };
  assert.equal(upgradeControllerActor(ai, 'sess-123').channel, 'mcp');
});
```

- [ ] **Step 2: Run it to confirm it fails** — `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5`. Expected: compile FAILS — `upgradeControllerActor` is not exported from `mission-actor`.

- [ ] **Step 3: Add the pure helper** to `core/src/mission/mission-actor.ts` (append after `resolveMcpActor`):

```ts
/**
 * Stamp channel:'controller' on a write that originates from the elected controller session,
 * so it is distinguishable from a human MCP edit (used by recentExternalChanges to exclude it).
 * Pure: callers pass the current controller session id (e.g. (await getControllerSession())?.sessionId).
 */
export function upgradeControllerActor(actor: MissionActor, controllerSessionId: string | null | undefined): MissionActor {
  if (controllerSessionId && actor.kind === 'local-session' && actor.id === controllerSessionId) {
    return { ...actor, kind: 'controller', channel: 'controller' };
  }
  return actor;
}
```

(Ensure `MissionActor` is imported in `mission-actor.ts` — it already imports from `./mission-model`; add `upgradeControllerActor`'s `MissionActor` use to the existing import if not present.)

- [ ] **Step 4: Wire it into `actorFor`** in `core/src/routes/core/mission.routes.ts`. Add the imports (extend the existing imports): `getControllerSession` from `../../mission/mission-store`, and `upgradeControllerActor` from `../../mission/mission-actor` (the file already imports `resolveMcpActor` from there). Replace the `actorFor` body (currently lines ~82-87):

```ts
async function actorFor(b: Record<string, unknown>): Promise<MissionActor> {
  const hint = b._actor as { channel?: string; toolUseId?: string | null } | undefined;
  delete (b as any)._actor;
  if (hint && hint.channel === 'mcp') {
    const resolved = await resolveMcpActor(hint.toolUseId, thisNode(), Date.now());
    const ctrl = await getControllerSession();
    return upgradeControllerActor(resolved, ctrl?.sessionId);
  }
  return coarseActor('user', thisNode(), Date.now());
}
```

- [ ] **Step 5: Run the test + build to confirm pass + no regressions** — `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/mission-actor-controller.test.js`. Expected: all PASS, build clean.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/mission/mission-actor.ts core/src/routes/core/mission.routes.ts core/src/__tests__/mission-actor-controller.test.ts && git commit -m "feat(mission): attribute controller-session MCP writes as channel:controller"
```

---

### Task 4: Routes `handleSchedule` + `handleChanges`

**Files:**
- Modify: `core/src/routes/core/mission.routes.ts` (add 2 handlers + 2 route registrations)
- Test: `core/src/__tests__/mission-schedule-routes.test.ts`

**Interfaces:**
- Consumes: `computeSchedule` from `../../mission/mission-scheduler` (Task 1); `recentExternalChanges` from `../../mission/mission-changes` (Task 2); existing `anchorToLeader`, `listMissions`, `realLeaderAnchor`, `ok`, `MissionDataPort`, `LeaderAnchorDeps`, `Envelope`.
- Produces (Task 5 consumes): `handleSchedule(b, port?, leader?): Promise<Envelope>` → `ok(Schedule)`; `handleChanges(b, port?, leader?): Promise<Envelope>` → `ok({changes})`; routes `POST /mission/schedule`, `POST /mission/changes`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-schedule-routes.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { handleSchedule, handleChanges } from '../routes/core/mission.routes';
import { newMission, type Mission, type MissionActor, type MissionChange } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
const mk = (id: string, over: Partial<Mission> = {}): Mission =>
  ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: actor }, 1, () => id), id, ...over });
function memPort(seed: Mission[]) {
  const db = new Map(seed.map((m) => [m.id, m]));
  return { db, get: async (id: string) => db.get(id) ?? null, list: async () => [...db.values()], put: async (m: Mission) => { db.set(m.id, m); } };
}

test('handleSchedule returns the deterministic schedule', async () => {
  const port = memPort([mk('a', { status: 'waiting', dependsOn: ['b'] }), mk('b', { status: 'done' })]);
  const r = await handleSchedule({}, port as any);
  const d = r.data as { ready: string[]; blocked: unknown[] };
  assert.deepEqual(d.ready, ['a']);
});

test('handleChanges returns external changes only', async () => {
  const ctrlChange: MissionChange = { rev: 1, at: 100, actor: { kind: 'controller', channel: 'controller', node: 'n', at: 100 }, changes: { 'ctl:readiness': { from: null, to: 'ready' } } };
  const userChange: MissionChange = { rev: 2, at: 200, actor, changes: { objective: { from: 'o', to: 'o2' } } };
  const port = memPort([mk('a', { history: [ctrlChange, userChange] })]);
  const r = await handleChanges({}, port as any);
  const d = r.data as { changes: Array<{ rev: number }> };
  assert.deepEqual(d.changes.map((c) => c.rev), [2]);
});
```

- [ ] **Step 2: Run it to confirm it fails** — `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5`. Expected: compile FAILS — `handleSchedule`/`handleChanges` not exported.

- [ ] **Step 3: Add the handlers** to `core/src/routes/core/mission.routes.ts` (place them next to `handleGraph`; add the imports `computeSchedule` from `../../mission/mission-scheduler` and `recentExternalChanges` from `../../mission/mission-changes`):

```ts
export async function handleSchedule(b: Record<string, unknown>, port?: MissionDataPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'POST', '/mission/schedule', b, false);
  if (anchored) return anchored;
  const all = await listMissions(port);
  return ok(computeSchedule(all));
}

export async function handleChanges(b: Record<string, unknown>, port?: MissionDataPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'POST', '/mission/changes', b, false);
  if (anchored) return anchored;
  const all = await listMissions(port);
  const sinceRev = (b.sinceRev && typeof b.sinceRev === 'object') ? (b.sinceRev as Record<string, number>) : undefined;
  const sinceTsRaw = typeof b.sinceTs === 'number' ? b.sinceTs : (typeof b.sinceTs === 'string' ? parseInt(b.sinceTs, 10) : undefined);
  const sinceTs = sinceTsRaw != null && !Number.isNaN(sinceTsRaw) ? sinceTsRaw : undefined;
  return ok({ changes: recentExternalChanges(all, { sinceRev, sinceTs }) });
}
```

- [ ] **Step 4: Register the routes** in the route array of `core/src/routes/core/mission.routes.ts`, IMMEDIATELY AFTER the existing `POST /mission/graph` registration (so they sit with the other single-segment literals, BEFORE every `/mission/:id` pattern):

```ts
{ method: 'POST', pattern: /^\/mission\/schedule$/, handler: async (req) => handleSchedule((req.body || {}) as Record<string, unknown>, undefined, realLeaderAnchor()) },
{ method: 'POST', pattern: /^\/mission\/changes$/, handler: async (req) => handleChanges((req.body || {}) as Record<string, unknown>, undefined, realLeaderAnchor()) },
```

- [ ] **Step 5: Run the test to confirm it passes** — `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/mission-schedule-routes.test.js`. Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/routes/core/mission.routes.ts core/src/__tests__/mission-schedule-routes.test.ts && git commit -m "feat(mission): POST /mission/schedule + /mission/changes read routes"
```

---

### Task 5: MCP tools `mission_schedule` + `mission_changes`

**Files:**
- Create: `core/src/mcp-server/tools/mission-schedule.ts`
- Modify: `core/src/mcp-server/tools/expanded.ts` (register defs + handlers)
- Modify: `core/src/mcp-server/configure.ts` (2 read scopes)
- Test: `core/src/__tests__/mission-schedule-tools.test.ts`

**Interfaces:**
- Consumes: `workerPost` from `./_passthrough`; the routes `POST /mission/schedule`, `POST /mission/changes` (Task 4); the `McpToolResult`, `ok`, `err` helpers (mirror `mission-query.ts`).
- Produces: `MISSION_SCHEDULE_TOOL_DEFS` (2 tool defs), `MISSION_SCHEDULE_HANDLERS` (2 handlers); scopes `mission_schedule:'read'`, `mission_changes:'read'`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-schedule-tools.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { MISSION_SCHEDULE_TOOL_DEFS } from '../mcp-server/tools/mission-schedule';
import { TOOL_SCOPES } from '../mcp-server/configure';

test('exposes exactly the two read tools with the right names', () => {
  assert.deepEqual(MISSION_SCHEDULE_TOOL_DEFS.map((t) => t.name).sort(), ['mission_changes', 'mission_schedule']);
});

test('both tools are scoped read in TOOL_SCOPES (boot-critical)', () => {
  assert.equal(TOOL_SCOPES['mission_schedule'], 'read');
  assert.equal(TOOL_SCOPES['mission_changes'], 'read');
});
```

- [ ] **Step 2: Run it to confirm it fails** — `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5`. Expected: compile FAILS — module `mission-schedule` not found.

- [ ] **Step 3: Create the tools** — `core/src/mcp-server/tools/mission-schedule.ts`

```ts
/** Mission scheduling-intelligence read tools (proxy the /mission/schedule + /mission/changes routes). */
import type { McpToolResult } from '../configure';
import { ok, err, workerPost } from './_passthrough';

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties: props, required });
const pretty = (v: unknown): McpToolResult => ok(JSON.stringify(v, null, 2));

export const MISSION_SCHEDULE_TOOL_DEFS = [
  {
    name: 'mission_schedule',
    description:
      'Deterministic mission schedule (hard constraints). Returns {ready[], blocked[{id,reason}], serializeGroups[], epicRollups[], containers[]}. ' +
      'ready = startable now (deps done, no resource/serialize conflict, not an epic container). Always defer dependency/resource/serialize/epic gating to THIS tool — do not re-derive it.',
    inputSchema: obj({}),
  },
  {
    name: 'mission_changes',
    description:
      'Recent EXTERNAL mission edits (changes by anyone other than the controller) newest-first, so you can react to human/other-node edits before acting. ' +
      'Optional {sinceRev:{<missionId>:<rev>}, sinceTs} to only see changes after a point. Returns {changes:[{missionId,rev,at,actor,changedFields}]}.',
    inputSchema: obj({ sinceRev: { type: 'object' as const }, sinceTs: { type: 'number' as const } }),
  },
] as const;

export const MISSION_SCHEDULE_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  mission_schedule: async () => { try { return pretty(await workerPost('/mission/schedule', {})); } catch (e) { return err((e as Error).message); } },
  mission_changes: async (a) => { try { return pretty(await workerPost('/mission/changes', a)); } catch (e) { return err((e as Error).message); } },
};
```

- [ ] **Step 4: Register in `expanded.ts`.** Add the import near the `mission-query` import (~line 53):

```ts
import { MISSION_SCHEDULE_TOOL_DEFS, MISSION_SCHEDULE_HANDLERS } from './mission-schedule';
```
Add the defs to the tool-defs array next to `...MISSION_QUERY_TOOL_DEFS` (~line 925):
```ts
  ...MISSION_SCHEDULE_TOOL_DEFS,
```
Add the handlers to the handlers object next to `...MISSION_QUERY_HANDLERS` (~line 1682):
```ts
  ...MISSION_SCHEDULE_HANDLERS,
```

- [ ] **Step 5: Add the scopes** in `core/src/mcp-server/configure.ts`, next to the `mission_query: 'read'` block (~line 266):

```ts
  mission_schedule: 'read',
  mission_changes: 'read',
```

- [ ] **Step 6: Run the test + full build to confirm pass + scope-coverage holds** — `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/mission-schedule-tools.test.js`. Expected: PASS. Then sanity-check the server boots its scope assertion: `node -e "require('./dist/mcp-server/configure').assertScopesCoverTools(); console.log('scopes ok')"` (after `npm run build`) — expected `scopes ok` with no throw.

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/mcp-server/tools/mission-schedule.ts core/src/mcp-server/tools/expanded.ts core/src/mcp-server/configure.ts core/src/__tests__/mission-schedule-tools.test.ts && git commit -m "feat(mcp): mission_schedule + mission_changes read tools"
```

---

### Task 6: Controller prompt, directive, and guide

**Files:**
- Modify: `core/src/mission/mission-controller.ts` (`CONTROLLER_SYSTEM_PROMPT`, `CONTROLLER_PASS_DIRECTIVE`)
- Modify: `core/src/mcp-server/tools/guide.ts` (`mission-controller` topic)
- Test: `core/src/__tests__/mission-controller-prompt.test.ts`

**Interfaces:**
- Consumes: tool names `mission_schedule`, `mission_changes` (Task 5); the `ctl:` reserved dimensions.
- Produces: the controller prompt/directive/guide now instruct the scheduling-intelligence loop. (Text change; the test asserts the wiring keywords are present so the instruction can never silently drop.)

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-controller-prompt.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { CONTROLLER_SYSTEM_PROMPT, CONTROLLER_PASS_DIRECTIVE } from '../mission/mission-controller';

test('the system prompt teaches the scheduling-intelligence tools + ctl namespace', () => {
  for (const needle of ['mission_schedule', 'mission_changes', 'ctl:']) {
    assert.ok(CONTROLLER_SYSTEM_PROMPT.includes(needle), `system prompt must mention ${needle}`);
  }
});

test('the pass directive tells the controller to start from mission_schedule and react to mission_changes', () => {
  assert.ok(CONTROLLER_PASS_DIRECTIVE.includes('mission_schedule'));
  assert.ok(CONTROLLER_PASS_DIRECTIVE.includes('mission_changes'));
});
```

- [ ] **Step 2: Run it to confirm it fails** — `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test dist-test/__tests__/mission-controller-prompt.test.js 2>&1 | tail -10`. Expected: tests FAIL (the prompts don't yet mention the new tools).

- [ ] **Step 3: Expand `CONTROLLER_PASS_DIRECTIVE`** in `core/src/mission/mission-controller.ts`. Replace it with:

```ts
export const CONTROLLER_PASS_DIRECTIVE =
  'Run a controller pass now. FIRST call mission_changes — re-evaluate any mission an external actor (a human or another node) edited since your last pass BEFORE anything else, and adapt rather than override. THEN call mission_schedule for the deterministic plan: act on each id in `ready` (place/spawn an executor via ccr_cloud_start, NEVER agent_execute, then bind with mission_update({binding})); for each `epicRollups` entry whose status/progress differs from the stored parent, apply it with mission_update; leave `blocked` and `containers` alone (they are gated/rolled-up by code). For two ready missions that touch the same area with no explicit dependsOn, decide parallel-vs-sequence (use mission_neighbors/mission_graph to see structure) and if you serialize them, tag them mission_tag({add:{"ctl:serialize-group":["<group>"]}}) so the scheduler enforces it next pass. Record your view with ctl: tags (e.g. ctl:readiness). Answer any worker pendingQuestion IMMEDIATELY via mission_session_answer; resume a non-live bound worker with mission_session_resume(sid) before respawning. Then await the next pass.';
```

- [ ] **Step 4: Add a scheduling-intelligence section to `CONTROLLER_SYSTEM_PROMPT`** in `core/src/mission/mission-controller.ts`. Insert these array entries immediately BEFORE the `'HEARTBEAT: ...'` line:

```ts
  'SCHEDULING INTELLIGENCE (tags · dependencies · history): each pass is driven by two read tools.',
  '  • `mission_schedule` is the DETERMINISTIC plan — {ready, blocked[{id,reason}], serializeGroups,',
  '    epicRollups, containers}. ALWAYS take the hard gating (dependency / resource / serialize / epic',
  '    rollup) from it; never re-derive those yourself. Act on `ready`; never spawn for a `container`',
  '    (an epic with children) — schedule its children instead and apply its `epicRollups` status via',
  '    mission_update when it differs from the stored parent.',
  '  • `mission_changes` lists recent EXTERNAL edits (anyone but you). Call it FIRST each pass and',
  '    re-evaluate those missions before acting — a human may have re-scoped or re-tagged one; adapt,',
  '    do not blindly override.',
  'SMART-TAGGING (you OWN the `ctl:` tag dimensions; NEVER write author dims project/feature/component):',
  '  use mission_tag to record decisions — `ctl:readiness` (ready/blocked/running/done), `ctl:serialize-group`',
  '  (<group> — missions sharing a value run one-at-a-time; the scheduler enforces it), `ctl:phase` (a batch',
  '  label). For two `ready` missions that touch the same area with no dependsOn, judge parallel-vs-sequence',
  '  via mission_neighbors/mission_graph; to serialize them, tag them the same `ctl:serialize-group`. Your tag',
  '  writes are auto-versioned + attributed, so the dashboard + history show what you decided.',
```

- [ ] **Step 5: Add the same summary to the `mission-controller` guide topic** in `core/src/mcp-server/tools/guide.ts`. Inside the `mission-controller` topic string, append before the `SELF-HEAL:` line:

```
SCHEDULING INTELLIGENCE (sub-project 3): each pass, FIRST call mission_changes (react to external edits before acting), THEN mission_schedule for the deterministic plan {ready, blocked[{id,reason}], serializeGroups, epicRollups, containers}. Act on ready; never spawn for a container (schedule its children, apply epicRollups status via mission_update); take all dependency/resource/serialize/epic gating from mission_schedule. You OWN the ctl: tag dimensions (ctl:readiness, ctl:serialize-group, ctl:phase) — write them via mission_tag to record/serialize; NEVER write author dims (project/feature/component). To serialize two same-area missions with no dependsOn, tag them the same ctl:serialize-group.
```

- [ ] **Step 6: Run the test + full suite** — `cd /home/ubuntu/lm-assist/core && npm run test 2>&1 | tail -15`. Expected: the new prompt test PASSES and the FULL mission suite stays green (no regressions). Confirm the total test count is the prior count + the new tests, 0 failures.

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/mission/mission-controller.ts core/src/mcp-server/tools/guide.ts core/src/__tests__/mission-controller-prompt.test.ts && git commit -m "feat(mission): teach the controller scheduling intelligence (schedule/changes/ctl tags)"
```

---

## Self-Review

**1. Spec coverage:**
- Spec §1 (deterministic scheduler) → Task 1. ✅
- Spec §2 (recentExternalChanges) → Task 2. ✅
- Spec §3 (two read tools + routes) → Tasks 4 (routes) + 5 (tools). ✅
- Spec §4 (`ctl:` tags) → Task 1 (`CTL_SERIALIZE_DIM` read by scheduler) + Task 6 (controller writes them via prompt). ✅
- Spec §4a (controller write attribution) → Task 3. ✅
- Spec §5 (expanded prompting) → Task 6. ✅
- Spec §6 (no dashboard / no place() change) → respected (only additive code + prompt). ✅
- Spec §7 (testing) → each task is TDD; Task 6 runs the full suite. ✅
- Spec §8 (files) → matches the File Structure section. ✅

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has an expected result. ✅

**3. Type consistency:** `computeSchedule`/`Schedule`/`CTL_SERIALIZE_DIM` (Task 1) are consumed by Task 4 with the same names; `recentExternalChanges` (Task 2) → Task 4; `upgradeControllerActor` (Task 3) signature matches its test + `actorFor` call; `handleSchedule`/`handleChanges` (Task 4) → consumed by Task 5's routes; tool names `mission_schedule`/`mission_changes` consistent across Tasks 5+6 and the scopes. `MissionStatus` union, `PlacementDecision` reasons (`dependency`/`resource`), and `MissionActor.channel` values used verbatim from the source. ✅

**Note on the one risk (Task 3 / spec §4a):** the chosen mechanism is the server-side `actorFor` upgrade keyed on `getControllerSession()?.sessionId` — verified in research that `getControllerSession()` is in-process on the leader and the controller's MCP writes land via the loopback `/mcp` route on the same Core, so no relay/protocol change is needed. The pure `upgradeControllerActor` is unit-tested; the `actorFor` wiring is exercised by the full build + the existing mission-route tests.
