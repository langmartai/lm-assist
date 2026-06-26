# Mission Foundation: Tags, Relationships & Version History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Mission multi-dimensional tags, a `parentId` hierarchy alongside the existing `dependsOn` DAG, and a field-level version history (who changed which field old→new, when) recorded at the store choke point — written through MCP/REST with provenance.

**Architecture:** Pure helpers (`mission-history.ts` diffing/append, `mission-graph.ts` validation/tag-merge) feed the single `putMission` write choke point, which bumps a monotonic `rev`, appends an inline recent-N slice, and best-effort spills the full change to an append-only `mission-history` dataset (unbounded, full-sync, survives controller failover). Routes (`mission.routes.ts`) validate relationships and resolve the actor; MCP tools (`mission.ts`) advertise the new fields plus `mission_tag` (delta) and `mission_history` (paging).

**Tech Stack:** TypeScript (CommonJS core), LMDB via the generic data service, `node:test`, MCP tools proxying REST over loopback.

## Global Constraints

- **Boot-critical scopes:** every advertised MCP tool MUST have a `TOOL_SCOPES` entry in `core/src/mcp-server/configure.ts` or `assertScopesCoverTools()` throws at startup and Core won't boot. New tools: `mission_tag: 'write'`, `mission_history: 'read'`.
- **Leader-anchored writes are fail-closed:** mission writes proxy to the elected leader via `anchorToLeader(..., failClosed=true)`; reads fall back to the local synced copy (`failClosed=false`). New write routes follow the same pattern.
- **Data-service-disabled is a no-op:** all store ports check `isEnabled()`; when off, reads return empty and writes no-op (never throw).
- **MCP args arrive as strings over the connector:** coerce numeric/boolean tool args (`parseInt`, `=== 'true'`), mirroring `mission_session_read`'s `lastN` handling.
- **Inline history cap default = 50** (`missionHistoryInlineCap`); the durable `mission-history` dataset is unbounded.
- **Reserved ids** `__controller__` / `__engagement__` are not real missions — `putMission` must not generate history for them.
- **Test runner:** `cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/<file>.test.js`. A compile error in any test file = the suite is RED.

## File Structure

- **Create** `core/src/mission/mission-history.ts` — `TRACKED_FIELDS`, `FieldDiff` re-export, `diffMission(old,next)`, `appendHistory(next,old,actor,inlineCap)`, `defaultActor()`. Pure, no IO.
- **Create** `core/src/mission/mission-graph.ts` — `normalizeTags`, `mergeTags`, `validateParent`, `validateDependsOn`. Pure, no IO.
- **Modify** `core/src/mission/mission-model.ts` — new `Mission` fields + `MissionChange`/`FieldDiff` + `newMission` defaults + `withActorBackfill` defaults + `NewMissionInput`.
- **Modify** `core/src/mission/mission-store.ts` — `mission-history` dataset + `MissionHistoryPort`/`appendMissionHistory`/`listMissionHistory`; `putMission` gains `opts {actor, historyPort, inlineCap}` and does diff→append→spill.
- **Modify** `core/src/routes/core/mission.routes.ts` — create/patch accept tags/parentId + validate; new `handleTag` + `handleHistory`; register `POST /mission/:id/tags`, `GET /mission/:id/history`.
- **Modify** `core/src/mcp-server/tools/mission.ts` — create/update schemas gain tags/parentId; new `mission_tag` + `mission_history` tools.
- **Modify** `core/src/mcp-server/configure.ts` — `mission_tag`/`mission_history` scopes.
- **Modify** test helpers `core/src/__tests__/mission-sessions.test.ts` + `mission-rails.test.ts` (add the 4 new fields to their `makeMission` base).

---

### Task 1: Model fields, `MissionChange`, defaults & backfill

**Files:**
- Modify: `core/src/mission/mission-model.ts`
- Modify: `core/src/__tests__/mission-sessions.test.ts` (makeMission base), `core/src/__tests__/mission-rails.test.ts` (makeMission base)
- Test: `core/src/__tests__/mission-foundation-model.test.ts`

**Interfaces:**
- Produces: `Mission.tags: Record<string,string[]>`, `Mission.parentId: string|null`, `Mission.rev: number`, `Mission.history: MissionChange[]`; `interface FieldDiff { from: unknown; to: unknown }`; `interface MissionChange { rev: number; at: number; actor: MissionActor; changes: Record<string, FieldDiff> }`; `NewMissionInput.tags?`, `NewMissionInput.parentId?`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-foundation-model.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { newMission, withActorBackfill, type Mission, type MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'api', node: 'n', at: 1 };

test('newMission seeds tags/parentId/rev/history defaults', () => {
  const m = newMission({ title: 't', objective: 'o', ownerNode: 'n', createdBy: actor }, 1000, () => 'mission_x');
  assert.deepEqual(m.tags, {});
  assert.equal(m.parentId, null);
  assert.equal(m.rev, 1);
  assert.deepEqual(m.history, []);
});

test('newMission carries provided tags + parentId', () => {
  const m = newMission({ title: 't', objective: 'o', ownerNode: 'n', createdBy: actor, tags: { project: ['p'] }, parentId: 'mission_p' }, 1000, () => 'mission_x');
  assert.deepEqual(m.tags, { project: ['p'] });
  assert.equal(m.parentId, 'mission_p');
});

test('withActorBackfill synthesizes new fields on a legacy record', () => {
  const legacy = { id: 'mission_y', title: 't', objective: 'o', dependsOn: [], projects: [], env: { isolation: 'cloud', resources: [] }, status: 'active', binding: null, progress: null, control: { nudgeCount: 0, backoffStep: 0 }, results: [], adjustments: [], ownerNode: 'n', createdAt: 1, updatedAt: 1 } as unknown as Mission;
  const m = withActorBackfill(legacy);
  assert.deepEqual(m.tags, {});
  assert.equal(m.parentId, null);
  assert.equal(m.rev, 1);
  assert.deepEqual(m.history, []);
});
```

- [ ] **Step 2: Run it to confirm RED**

Run: `cd core && npm run build:test 2>&1 | grep mission-foundation-model`
Expected: compile error — `tags`/`parentId`/`rev`/`history` not on `Mission`, `NewMissionInput` has no `tags`.

- [ ] **Step 3: Add the types** — in `mission-model.ts`, after `MissionAdjustment` (line 35) add:

```ts
export interface FieldDiff { from: unknown; to: unknown; }
export interface MissionChange {
  rev: number;
  at: number;
  actor: MissionActor;
  changes: Record<string, FieldDiff>;
}
```

In the `Mission` interface, add after `dependsOn: string[];` (line 76):

```ts
  tags: Record<string, string[]>;
  parentId: string | null;
```

and after `lastUpdatedBy: MissionActor;` (line 86):

```ts
  rev: number;
  history: MissionChange[];
```

In `NewMissionInput` (line 98) add: `tags?: Record<string, string[]>;` and `parentId?: string | null;`

In `newMission` return object (after `dependsOn: input.dependsOn ?? [],` line 118) add `tags: input.tags ?? {}, parentId: input.parentId ?? null,` and after `lastUpdatedBy: input.createdBy,` (line 133) add `rev: 1, history: [],`

In `withActorBackfill` (after line 57, before the `adjustments` loop) add:

```ts
  if (!m.tags || typeof m.tags !== 'object') m.tags = {};
  if (m.parentId === undefined) m.parentId = null;
  if (typeof m.rev !== 'number') m.rev = 1;
  if (!Array.isArray(m.history)) m.history = [];
```

- [ ] **Step 4: Fix the two test helpers** — in `mission-sessions.test.ts` and `mission-rails.test.ts`, the `makeMission` base object literal: add `tags: {}, parentId: null, rev: 1, history: [],` alongside the other base fields (before the `...overrides` spread).

- [ ] **Step 5: Run to confirm GREEN**

Run: `cd core && npm run build:test >/dev/null 2>&1 && node --test --test-reporter=spec dist-test/__tests__/mission-foundation-model.test.js`
Expected: 3 pass, 0 fail. Also confirm the wider build still compiles: `cd core && npm run build:test >/dev/null 2>&1 && echo BUILD_OK` → prints `BUILD_OK` (catches any other Mission literal). If `build:test` flags another literal missing the 4 fields, add `tags: {}, parentId: null, rev: 1, history: []` to it.

- [ ] **Step 6: Commit**

```bash
git add core/src/mission/mission-model.ts core/src/__tests__/mission-foundation-model.test.ts core/src/__tests__/mission-sessions.test.ts core/src/__tests__/mission-rails.test.ts
git commit -m "feat(mission): add tags, parentId, rev, history fields + defaults/backfill"
```

---

### Task 2: History engine (`mission-history.ts`)

**Files:**
- Create: `core/src/mission/mission-history.ts`
- Test: `core/src/__tests__/mission-history.test.ts`

**Interfaces:**
- Consumes: `Mission`, `MissionChange`, `FieldDiff`, `MissionActor` (Task 1).
- Produces: `TRACKED_FIELDS: readonly string[]`; `diffMission(old: Mission|null, next: Mission): Record<string, FieldDiff>`; `appendHistory(next: Mission, old: Mission|null, actor: MissionActor|undefined, inlineCap?: number): { mission: Mission; change: MissionChange|null }`; `defaultActor(): MissionActor`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-history.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { diffMission, appendHistory } from '../mission/mission-history';
import { newMission, type Mission, type MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
const mk = (over: Partial<Mission> = {}): Mission => ({ ...newMission({ title: 't', objective: 'o', ownerNode: 'n', createdBy: actor }, 1, () => 'mission_a'), ...over });

test('diffMission detects a tracked field change', () => {
  const a = mk({ status: 'active' });
  const b = mk({ status: 'done' });
  const d = diffMission(a, b);
  assert.deepEqual(d, { status: { from: 'active', to: 'done' } });
});

test('diffMission ignores untracked churn (progress/control/binding)', () => {
  const a = mk();
  const b = mk();
  b.progress = { percent: 50, summary: 's', updatedAt: 2 };
  b.control = { nudgeCount: 9, backoffStep: 3 };
  assert.deepEqual(diffMission(a, b), {});
});

test('diffMission keys tag changes per dimension', () => {
  const a = mk({ tags: { component: ['controller'] } });
  const b = mk({ tags: { component: ['controller', 'web'] } });
  assert.deepEqual(diffMission(a, b), { 'tags.component': { from: ['controller'], to: ['controller', 'web'] } });
});

test('diffMission truncates long string values', () => {
  const big = 'x'.repeat(600);
  const d = diffMission(mk({ objective: 'o' }), mk({ objective: big }));
  assert.equal((d.objective.to as string).startsWith('x'.repeat(500)), true);
  assert.ok((d.objective.to as string).includes('len 600'));
});

test('appendHistory bumps rev, appends, trims to inlineCap, returns change', () => {
  let cur = mk({ rev: 5, history: [] });
  const r = appendHistory(mk({ rev: 5, status: 'done' }), cur, actor, 2);
  assert.equal(r.change?.rev, 6);
  assert.equal(r.mission.rev, 6);
  assert.equal(r.mission.history.length, 1);
  // cap: push two more (revs from old) -> only last 2 kept
  const m2 = appendHistory(mk({ rev: 6, status: 'paused', history: r.mission.history }), mk({ rev: 6, status: 'done', history: r.mission.history }), actor, 2).mission;
  const m3 = appendHistory(mk({ rev: 7, status: 'blocked', history: m2.history }), mk({ rev: 7, status: 'paused', history: m2.history }), actor, 2).mission;
  assert.equal(m3.history.length, 2);
});

test('appendHistory on empty diff returns null change and no rev bump', () => {
  const same = mk({ rev: 4 });
  const r = appendHistory(mk({ rev: 4 }), same, actor, 50);
  assert.equal(r.change, null);
  assert.equal(r.mission.rev, 4);
});
```

- [ ] **Step 2: Run it to confirm RED**

Run: `cd core && npm run build:test 2>&1 | grep mission-history`
Expected: compile error — module `../mission/mission-history` not found.

- [ ] **Step 3: Implement** — create `core/src/mission/mission-history.ts`:

```ts
/** Pure version-history engine for missions: tracked-field diffing + inline append. No IO. */
import type { Mission, MissionChange, FieldDiff, MissionActor } from './mission-model';

/** Semantic fields whose change is versioned. Controller telemetry is intentionally excluded. */
export const TRACKED_FIELDS = [
  'title', 'objective', 'plan', 'nextSteps', 'projects', 'tags', 'parentId', 'dependsOn', 'status', 'env',
] as const;

const MAX_STR = 500;
function trunc(v: unknown): unknown {
  if (typeof v === 'string' && v.length > MAX_STR) return v.slice(0, MAX_STR) + `…(len ${v.length})`;
  return v;
}
function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Compute the per-field diff between a previous mission (or null on create) and the next. */
export function diffMission(old: Mission | null, next: Mission): Record<string, FieldDiff> {
  const changes: Record<string, FieldDiff> = {};
  for (const f of TRACKED_FIELDS) {
    if (f === 'tags') {
      const ot = (old?.tags ?? {}) as Record<string, string[]>;
      const nt = (next.tags ?? {}) as Record<string, string[]>;
      for (const d of new Set([...Object.keys(ot), ...Object.keys(nt)])) {
        if (!eq(ot[d] ?? [], nt[d] ?? [])) changes[`tags.${d}`] = { from: ot[d] ?? null, to: nt[d] ?? null };
      }
      continue;
    }
    const ov = (old as Record<string, unknown> | null)?.[f];
    const nv = (next as unknown as Record<string, unknown>)[f];
    if (!eq(ov, nv)) changes[f] = { from: trunc(ov ?? null), to: trunc(nv ?? null) };
  }
  return changes;
}

/** Unattributed internal write actor (a direct store call that supplies no actor). */
export function defaultActor(): MissionActor {
  return { kind: 'controller', channel: 'controller', node: null, at: Date.now() };
}

/**
 * If `next` changes a tracked field vs `old`, bump rev, append a MissionChange to the
 * inline slice (trimmed to inlineCap), set lastUpdatedBy, and return the change to spill
 * durably. Otherwise no-op (change=null). Mutates and returns `next`.
 */
export function appendHistory(
  next: Mission,
  old: Mission | null,
  actor: MissionActor | undefined,
  inlineCap = 50,
): { mission: Mission; change: MissionChange | null } {
  const changes = diffMission(old, next);
  if (Object.keys(changes).length === 0) return { mission: next, change: null };
  const who = actor ?? defaultActor();
  const change: MissionChange = { rev: (old?.rev ?? 0) + 1, at: Date.now(), actor: who, changes };
  next.rev = change.rev;
  next.history = [...(next.history ?? []), change].slice(-inlineCap);
  next.lastUpdatedBy = who;
  return { mission: next, change };
}
```

- [ ] **Step 4: Run to confirm GREEN**

Run: `cd core && npm run build:test >/dev/null 2>&1 && node --test --test-reporter=spec dist-test/__tests__/mission-history.test.js`
Expected: 6 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add core/src/mission/mission-history.ts core/src/__tests__/mission-history.test.ts
git commit -m "feat(mission): pure history engine — diffMission + appendHistory"
```

---

### Task 3: Graph engine (`mission-graph.ts`)

**Files:**
- Create: `core/src/mission/mission-graph.ts`
- Test: `core/src/__tests__/mission-graph.test.ts`

**Interfaces:**
- Consumes: `Mission` (Task 1).
- Produces: `normalizeTags(tags): Record<string,string[]>`; `interface TagOps { add?; remove?; set?: Record<string,string[]> }`; `mergeTags(current, ops): Record<string,string[]>`; `type RelValidation = {ok:true} | {ok:false; code:'INVALID_RELATIONSHIP'|'CYCLE'; message:string}`; `validateParent(missionId, parentId, all): RelValidation`; `validateDependsOn(missionId, deps, all): RelValidation`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-graph.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeTags, mergeTags, validateParent, validateDependsOn } from '../mission/mission-graph';
import { newMission, type Mission, type MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
const mk = (id: string, over: Partial<Mission> = {}): Mission => ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: actor }, 1, () => id), id, ...over });

test('normalizeTags trims+lowercases dims, dedups+drops-empty values', () => {
  assert.deepEqual(normalizeTags({ ' Component ': ['web', 'web', ' '], Empty: [] }), { component: ['web'] });
});

test('mergeTags add/remove/set', () => {
  assert.deepEqual(mergeTags({ c: ['a'] }, { add: { c: ['b'] } }), { c: ['a', 'b'] });
  assert.deepEqual(mergeTags({ c: ['a', 'b'] }, { remove: { c: ['a'] } }), { c: ['b'] });
  assert.deepEqual(mergeTags({ c: ['a'] }, { set: { c: ['x', 'y'] } }), { c: ['x', 'y'] });
});

test('validateParent: self, missing, ancestor-cycle rejected; valid ok', () => {
  const a = mk('a'), b = mk('b', { parentId: 'a' });
  assert.equal(validateParent('a', 'a', [a]).ok, false);
  assert.equal(validateParent('a', 'zzz', [a]).ok, false);
  // a's parent = b, b's parent = a  -> cycle
  const aWithParent = mk('a', { parentId: 'b' });
  assert.equal(validateParent('a', 'b', [aWithParent, b]).ok, false);
  assert.equal(validateParent('c', 'a', [a, mk('c')]).ok, true);
});

test('validateDependsOn: self, missing, cycle rejected; valid DAG ok', () => {
  const a = mk('a'), b = mk('b', { dependsOn: ['a'] });
  assert.equal(validateDependsOn('a', ['a'], [a]).ok, false);
  assert.equal(validateDependsOn('a', ['zzz'], [a]).ok, false);
  // a depends on b, b depends on a -> cycle
  assert.equal(validateDependsOn('a', ['b'], [mk('a', { dependsOn: ['b'] }), b]).ok, false);
  assert.equal(validateDependsOn('c', ['a'], [a, b, mk('c')]).ok, true);
});
```

- [ ] **Step 2: Run it to confirm RED**

Run: `cd core && npm run build:test 2>&1 | grep mission-graph`
Expected: compile error — module not found.

- [ ] **Step 3: Implement** — create `core/src/mission/mission-graph.ts`:

```ts
/** Pure mission relationship validation + tag merge/normalize. No IO. */
import type { Mission } from './mission-model';

export function normalizeTags(tags: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [dim, vals] of Object.entries(tags ?? {})) {
    const k = String(dim).trim().toLowerCase();
    if (!k) continue;
    const cleaned = Array.from(new Set((vals ?? []).map((v) => String(v).trim()).filter(Boolean)));
    if (cleaned.length) out[k] = cleaned;
  }
  return out;
}

export interface TagOps { add?: Record<string, string[]>; remove?: Record<string, string[]>; set?: Record<string, string[]>; }

export function mergeTags(current: Record<string, string[]>, ops: TagOps): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [d, v] of Object.entries(current ?? {})) next[d] = [...v];
  if (ops.set) for (const [d, v] of Object.entries(ops.set)) next[d] = [...v];
  if (ops.add) for (const [d, v] of Object.entries(ops.add)) next[d] = [...(next[d] ?? []), ...v];
  if (ops.remove) for (const [d, v] of Object.entries(ops.remove)) next[d] = (next[d] ?? []).filter((x) => !v.includes(x));
  return normalizeTags(next);
}

export type RelValidation = { ok: true } | { ok: false; code: 'INVALID_RELATIONSHIP' | 'CYCLE'; message: string };

export function validateParent(missionId: string, parentId: string | null, all: Mission[]): RelValidation {
  if (parentId == null || parentId === '') return { ok: true };
  if (parentId === missionId) return { ok: false, code: 'CYCLE', message: 'a mission cannot be its own parent' };
  const byId = new Map(all.map((m) => [m.id, m]));
  if (!byId.has(parentId)) return { ok: false, code: 'INVALID_RELATIONSHIP', message: `parent ${parentId} does not exist` };
  let cur: string | null = parentId;
  const seen = new Set<string>();
  while (cur != null) {
    if (cur === missionId) return { ok: false, code: 'CYCLE', message: 'parent chain would cycle' };
    if (seen.has(cur)) break;
    seen.add(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return { ok: true };
}

export function validateDependsOn(missionId: string, deps: string[], all: Mission[]): RelValidation {
  const byId = new Map(all.map((m) => [m.id, m]));
  for (const d of deps) {
    if (d === missionId) return { ok: false, code: 'CYCLE', message: 'a mission cannot depend on itself' };
    if (!byId.has(d)) return { ok: false, code: 'INVALID_RELATIONSHIP', message: `dependency ${d} does not exist` };
  }
  const depsOf = (id: string): string[] => (id === missionId ? deps : (byId.get(id)?.dependsOn ?? []));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const dfs = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (done.has(id)) return false;
    visiting.add(id);
    for (const n of depsOf(id)) if (dfs(n)) return true;
    visiting.delete(id);
    done.add(id);
    return false;
  };
  return dfs(missionId) ? { ok: false, code: 'CYCLE', message: 'dependsOn would create a cycle' } : { ok: true };
}
```

- [ ] **Step 4: Run to confirm GREEN**

Run: `cd core && npm run build:test >/dev/null 2>&1 && node --test --test-reporter=spec dist-test/__tests__/mission-graph.test.js`
Expected: 4 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add core/src/mission/mission-graph.ts core/src/__tests__/mission-graph.test.ts
git commit -m "feat(mission): pure graph engine — relationship validation + tag merge"
```

---

### Task 4: Durable history store (`mission-history` dataset)

**Files:**
- Modify: `core/src/mission/mission-store.ts`
- Test: `core/src/__tests__/mission-history-store.test.ts`

**Interfaces:**
- Consumes: `MissionChange` (Task 1), `getDataService` (existing).
- Produces: `interface MissionHistoryRecord { id; missionId; rev; at; actor; changes }`; `interface MissionHistoryPort { isEnabled(); put(rec); query(missionId, opts) }`; `appendMissionHistory(missionId, change, port?): Promise<void>`; `listMissionHistory(missionId, opts?, port?): Promise<MissionHistoryRecord[]>`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-history-store.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { appendMissionHistory, listMissionHistory, type MissionHistoryRecord, type MissionHistoryPort } from '../mission/mission-store';
import type { MissionChange, MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
function memHistoryPort(): MissionHistoryPort & { db: Map<string, MissionHistoryRecord> } {
  const db = new Map<string, MissionHistoryRecord>();
  return {
    db,
    isEnabled: () => true,
    put: async (rec) => { db.set(rec.id, rec); },
    query: async (missionId, opts) => {
      let rows = [...db.values()].filter((r) => r.missionId === missionId);
      if (typeof opts.beforeRev === 'number') rows = rows.filter((r) => r.rev < opts.beforeRev!);
      rows.sort((a, b) => b.rev - a.rev);
      return rows.slice(0, opts.limit ?? 50);
    },
  };
}
const change = (rev: number): MissionChange => ({ rev, at: rev, actor, changes: { status: { from: 'a', to: 'b' } } });

test('appendMissionHistory writes ${id}:${rev} and is idempotent on rev', async () => {
  const p = memHistoryPort();
  await appendMissionHistory('mission_a', change(1), p);
  await appendMissionHistory('mission_a', change(1), p);
  assert.equal(p.db.size, 1);
  assert.ok(p.db.has('mission_a:1'));
});

test('listMissionHistory is newest-first and honours limit + beforeRev', async () => {
  const p = memHistoryPort();
  for (const r of [1, 2, 3, 4]) await appendMissionHistory('mission_a', change(r), p);
  const top2 = await listMissionHistory('mission_a', { limit: 2 }, p);
  assert.deepEqual(top2.map((r) => r.rev), [4, 3]);
  const older = await listMissionHistory('mission_a', { beforeRev: 3 }, p);
  assert.deepEqual(older.map((r) => r.rev), [2, 1]);
});
```

- [ ] **Step 2: Run it to confirm RED**

Run: `cd core && npm run build:test 2>&1 | grep mission-history-store`
Expected: compile error — `appendMissionHistory`/`listMissionHistory`/`MissionHistoryPort` not exported from `mission-store`.

- [ ] **Step 3: Implement** — in `mission-store.ts`:

Add the `MissionChange` import to the existing `mission-model` import line (line 2-3): add `MissionChange` to the `import type { ... }` list.

After the `DATASET`/reserved-id consts (line 13) add:

```ts
const HISTORY_DATASET = 'mission-history';

export interface MissionHistoryRecord {
  id: string;            // `${missionId}:${rev}`
  missionId: string;
  rev: number;
  at: number;
  actor: import('./mission-model').MissionActor;
  changes: Record<string, { from: unknown; to: unknown }>;
}
export interface MissionHistoryPort {
  isEnabled(): boolean;
  put(rec: MissionHistoryRecord): Promise<void>;
  query(missionId: string, opts: { limit?: number; beforeRev?: number }): Promise<MissionHistoryRecord[]>;
}
```

After `livePort()` (around line 103) add:

```ts
let historyEnsured = false;
async function ensureHistoryDataset(svc: ReturnType<typeof getDataService>): Promise<void> {
  if (historyEnsured) return;
  try {
    await svc.createDataset(systemCtx(), {
      id: HISTORY_DATASET, backend: 'cache', title: 'Mission History',
      visibility: 'cross-node-readable', syncMode: 'full', config: { kind: 'cache' },
    } as any);
  } catch { /* already exists — fine */ }
  historyEnsured = true;
}

function liveHistoryPort(): MissionHistoryPort {
  return {
    isEnabled: () => getDataService().isEnabled(),
    put: async (rec) => {
      const svc = getDataService();
      if (!svc.isEnabled()) return;
      await ensureHistoryDataset(svc);
      const now = new Date().toISOString();
      await svc.put(systemCtx(), HISTORY_DATASET, { id: rec.id, version: 0, fields: { ...rec } as Record<string, unknown>, createdAt: now, updatedAt: now });
    },
    query: async (missionId, opts) => {
      const svc = getDataService();
      if (!svc.isEnabled()) return [];
      await ensureHistoryDataset(svc);
      const filter: Array<{ field: string; op: string; value: unknown }> = [{ field: 'missionId', op: 'eq', value: missionId }];
      if (typeof opts.beforeRev === 'number') filter.push({ field: 'rev', op: 'lt', value: opts.beforeRev });
      const r = await svc.query(systemCtx(), HISTORY_DATASET, { filter, sort: [{ field: 'rev', dir: 'desc' }], limit: opts.limit ?? 50 } as any);
      return r.ok ? r.value.records.map((rec) => rec.fields as unknown as MissionHistoryRecord) : [];
    },
  };
}
let _historyDefault: MissionHistoryPort | null = null;
function defaultHistoryPort(): MissionHistoryPort { return _historyDefault ?? (_historyDefault = liveHistoryPort()); }

/** Best-effort durable append of one change to the unbounded mission-history dataset. */
export async function appendMissionHistory(missionId: string, change: MissionChange, port: MissionHistoryPort = defaultHistoryPort()): Promise<void> {
  if (!port.isEnabled()) return;
  await port.put({ id: `${missionId}:${change.rev}`, missionId, rev: change.rev, at: change.at, actor: change.actor, changes: change.changes });
}
/** Page the full history trail, newest-first. */
export async function listMissionHistory(missionId: string, opts: { limit?: number; beforeRev?: number } = {}, port: MissionHistoryPort = defaultHistoryPort()): Promise<MissionHistoryRecord[]> {
  return port.query(missionId, opts);
}
```

- [ ] **Step 4: Run to confirm GREEN**

Run: `cd core && npm run build:test >/dev/null 2>&1 && node --test --test-reporter=spec dist-test/__tests__/mission-history-store.test.js`
Expected: 2 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add core/src/mission/mission-store.ts core/src/__tests__/mission-history-store.test.ts
git commit -m "feat(mission): unbounded append-only mission-history dataset + paging"
```

---

### Task 5: `putMission` choke point — diff → inline history → durable spill

**Files:**
- Modify: `core/src/mission/mission-store.ts`
- Test: `core/src/__tests__/mission-putmission-history.test.ts`

**Interfaces:**
- Consumes: `appendHistory` (Task 2), `appendMissionHistory` + `MissionHistoryPort` (Task 4).
- Produces: `putMission(m, port?, opts?: { actor?: MissionActor; historyPort?: MissionHistoryPort; inlineCap?: number }): Promise<Mission>` (3rd param is new, optional — existing `putMission(m, port)` callers unaffected).

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-putmission-history.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { putMission, getMission, type MissionDataPort, type MissionHistoryPort, type MissionHistoryRecord } from '../mission/mission-store';
import { newMission, type Mission, type MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
function memPort(): MissionDataPort & { db: Map<string, Mission> } {
  const db = new Map<string, Mission>();
  // clone on BOTH get and put: simulate LMDB independent reads, so putMission's pre-image diff works.
  return { db, isEnabled: () => true, get: async (id) => { const v = db.get(id); return v ? JSON.parse(JSON.stringify(v)) : null; }, list: async () => [...db.values()], put: async (m) => { db.set(m.id, JSON.parse(JSON.stringify(m))); }, del: async (id) => { db.delete(id); } };
}
function memHistoryPort(fail = false): MissionHistoryPort & { db: Map<string, MissionHistoryRecord> } {
  const db = new Map<string, MissionHistoryRecord>();
  return { db, isEnabled: () => true, put: async (rec) => { if (fail) throw new Error('boom'); db.set(rec.id, rec); }, query: async () => [...db.values()] };
}
const mk = (id: string, over: Partial<Mission> = {}): Mission => ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: actor }, 1, () => id), id, ...over });

test('a tracked change bumps rev, appends inline history, spills durably', async () => {
  const port = memPort(); const hp = memHistoryPort();
  const m = mk('mission_a', { rev: 1, history: [] });
  await port.put(m);
  m.status = 'done';
  await putMission(m, port, { actor, historyPort: hp });
  const saved = await getMission('mission_a', port);
  assert.equal(saved!.rev, 2);
  assert.equal(saved!.history.length, 1);
  assert.deepEqual(saved!.history[0].changes.status, { from: 'active', to: 'done' });
  assert.equal(saved!.lastUpdatedBy.channel, 'mcp');
  assert.ok(hp.db.has('mission_a:2'));
});

test('an untracked-only change records no history and no rev bump', async () => {
  const port = memPort(); const hp = memHistoryPort();
  const m = mk('mission_b', { rev: 3, history: [] });
  await port.put(m);
  m.progress = { percent: 10, summary: 's', updatedAt: 9 };
  await putMission(m, port, { actor, historyPort: hp });
  const saved = await getMission('mission_b', port);
  assert.equal(saved!.rev, 3);
  assert.equal(saved!.history.length, 0);
  assert.equal(hp.db.size, 0);
});

test('inline slice never exceeds inlineCap', async () => {
  const port = memPort(); const hp = memHistoryPort();
  const m = mk('mission_c', { rev: 0, history: [] });
  await port.put(m);
  for (const s of ['active', 'paused', 'active', 'done'] as const) {
    const cur = (await getMission('mission_c', port))!;
    cur.status = s;
    await putMission(cur, port, { actor, historyPort: hp, inlineCap: 2 });
  }
  const saved = await getMission('mission_c', port);
  assert.equal(saved!.history.length, 2);
});

test('a durable-spill failure does not throw out of putMission', async () => {
  const port = memPort(); const hp = memHistoryPort(true);
  const m = mk('mission_d', { rev: 1, history: [] });
  await port.put(m);
  m.status = 'done';
  await putMission(m, port, { actor, historyPort: hp }); // must not throw
  assert.equal((await getMission('mission_d', port))!.rev, 2);
});
```

- [ ] **Step 2: Run it to confirm RED**

Run: `cd core && npm run build:test 2>&1 | grep mission-putmission-history`
Expected: compile error — `putMission`'s 3rd `opts` param does not exist.

- [ ] **Step 3: Implement** — in `mission-store.ts`:

Add imports near the top (after the existing `withActorBackfill` import): `import { appendHistory } from './mission-history';` and add `MissionActor` to the `mission-model` type import.

Replace `putMission` (lines 148-152) with:

```ts
export async function putMission(
  m: Mission,
  port: MissionDataPort = defaultPort(),
  opts: { actor?: import('./mission-model').MissionActor; historyPort?: MissionHistoryPort; inlineCap?: number } = {},
): Promise<Mission> {
  // Reserved records (__controller__/__engagement__) are not real missions — never version them.
  if (RESERVED_IDS.has(m.id)) { m.updatedAt = Date.now(); await port.put(m); return m; }
  const prev = await port.get(m.id);
  const { mission, change } = appendHistory(m, prev, opts.actor, opts.inlineCap ?? 50);
  mission.updatedAt = Date.now();
  await port.put(mission);
  if (change) {
    try { await appendMissionHistory(mission.id, change, opts.historyPort); } catch { /* best-effort durable spill */ }
  }
  return mission;
}
```

- [ ] **Step 4: Run to confirm GREEN** (plus the existing store/route suites still pass — putMission is widely called)

Run: `cd core && npm run build:test >/dev/null 2>&1 && node --test --test-reporter=spec dist-test/__tests__/mission-putmission-history.test.js dist-test/__tests__/mission-store.test.js dist-test/__tests__/mission-provenance-routes.test.js`
Expected: all pass. (The provenance-routes suite's `patch ... appends an attributed adjustment` test still passes because Task 6 has not yet removed that adjustment; it is updated in Task 6.)

- [ ] **Step 5: Commit**

```bash
git add core/src/mission/mission-store.ts core/src/__tests__/mission-putmission-history.test.ts
git commit -m "feat(mission): putMission records rev/history at the store choke point"
```

---

### Task 6: Route create/patch — accept tags/parentId, validate, version via putMission

**Files:**
- Modify: `core/src/routes/core/mission.routes.ts`
- Modify: `core/src/mcp-server/tools/mission.ts` (schemas only)
- Modify: `core/src/__tests__/mission-provenance-routes.test.ts` (the adjustment assertion → history assertion)
- Test: `core/src/__tests__/mission-foundation-routes.test.ts`

**Interfaces:**
- Consumes: `normalizeTags`, `validateParent`, `validateDependsOn` (Task 3); `putMission(opts)` (Task 5); `listMissions` (existing).
- Produces: `handleCreate`/`handlePatch` now accept `tags`/`parentId`, validate relationships, and version via `putMission`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-foundation-routes.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { handleCreate, handlePatch } from '../routes/core/mission.routes';
import type { Mission, MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'user', node: 'n', at: 1 };
function memPort() {
  const db = new Map<string, Mission>();
  // clone on BOTH get and put: simulate LMDB independent reads, so putMission's pre-image diff works.
  return { db, get: async (id: string) => { const v = db.get(id); return v ? JSON.parse(JSON.stringify(v)) : null; }, list: async () => [...db.values()], put: async (m: Mission) => { db.set(m.id, JSON.parse(JSON.stringify(m))); } };
}

test('create stamps rev 1 + initial history + createdBy + tags/parentId', async () => {
  const port = memPort();
  const r = await handleCreate({ title: 't', objective: 'o', tags: { project: ['lm'] } }, 'n', port as any, actor);
  const m = r.data as Mission;
  assert.equal(m.rev, 1);
  assert.equal(m.history.length, 1);
  assert.equal(m.history[0].rev, 1);
  assert.deepEqual(m.tags, { project: ['lm'] });
  assert.equal(m.createdBy.kind, 'user');
});

test('patch of a tracked field records a grouped diff + bumps rev + sets lastUpdatedBy', async () => {
  const port = memPort();
  const created = (await handleCreate({ title: 't', objective: 'o' }, 'n', port as any, actor)).data as Mission;
  const r = await handlePatch(created.id, { status: 'paused', title: 't2' }, port as any, actor);
  const m = r.data as Mission;
  assert.equal(m.rev, 2);
  const last = m.history[m.history.length - 1];
  assert.deepEqual(last.changes.status, { from: 'active', to: 'paused' });
  assert.deepEqual(last.changes.title, { from: 't', to: 't2' });
});

test('an untracked-only patch (binding) records no history', async () => {
  const port = memPort();
  const created = (await handleCreate({ title: 't', objective: 'o' }, 'n', port as any, actor)).data as Mission;
  const r = await handlePatch(created.id, { binding: { sessionId: 's', kind: 'worker' } }, port as any, actor);
  assert.equal((r.data as Mission).rev, 1);
  assert.equal((r.data as Mission).history.length, 1); // only the create entry
});

test('a cyclic parentId is rejected', async () => {
  const port = memPort();
  const a = (await handleCreate({ title: 'a', objective: 'o' }, 'n', port as any, actor)).data as Mission;
  const r = await handlePatch(a.id, { parentId: a.id }, port as any, actor);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'CYCLE');
});

test('a non-existent dependsOn is rejected', async () => {
  const port = memPort();
  const a = (await handleCreate({ title: 'a', objective: 'o' }, 'n', port as any, actor)).data as Mission;
  const r = await handlePatch(a.id, { dependsOn: ['mission_zzz'] }, port as any, actor);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'INVALID_RELATIONSHIP');
});
```

- [ ] **Step 2: Run it to confirm RED**

Run: `cd core && npm run build:test >/dev/null 2>&1 && node --test --test-reporter=spec dist-test/__tests__/mission-foundation-routes.test.js`
Expected: failures — create has no history/tags handling; patch still bumps via the old adjustment path; no validation.

- [ ] **Step 3: Implement route changes** — in `mission.routes.ts`:

Add imports: extend the `mission-model` import (line 5) with nothing new needed; add a new import line:
```ts
import { normalizeTags, validateParent, validateDependsOn } from '../../mission/mission-graph';
```

In `handleCreate` (after `const env = ...` at line 90, before `const m = newMission(...)`), parse tags/parentId and pass them; then validate after construction. Replace the `const m = newMission({...}, Date.now(), genId); await putMission(m, port); return ok(m);` block (lines 91-103) with:

```ts
  const tags = (b.tags && typeof b.tags === 'object') ? normalizeTags(b.tags as Record<string, string[]>) : {};
  const parentId = (b.parentId === null || b.parentId === '') ? null : (str(b.parentId) ?? null);
  const m = newMission({
    title, objective, ownerNode, createdBy: who,
    projects: arr(b.projects), dependsOn: arr(b.dependsOn),
    plan: str(b.plan), nextSteps: arr(b.nextSteps), tags, parentId,
    env: {
      isolation: (str(env.isolation) as Isolation) ?? 'cloud',
      host: str(env.host), repo: str(env.repo), branch: str(env.branch),
      resources: arr(env.resources) ?? [],
      exclusive: env.exclusive === true || env.exclusive === 'true',
    },
  }, Date.now(), genId);
  const all = await listMissions(port);
  const pv = validateParent(m.id, m.parentId, all);
  if (!pv.ok) return fail(pv.code, pv.message);
  const dv = validateDependsOn(m.id, m.dependsOn, [...all, m]);
  if (!dv.ok) return fail(dv.code, dv.message);
  await putMission(m, port, { actor: who });
  return ok(m);
```

In `handlePatch`: replace the dependsOn line (line 132) `if (arr(b.dependsOn)) m.dependsOn = arr(b.dependsOn)!;` with:

```ts
  if (arr(b.dependsOn)) {
    const deps = arr(b.dependsOn)!;
    const dv = validateDependsOn(m.id, deps, await listMissions(port));
    if (!dv.ok) return fail(dv.code, dv.message);
    m.dependsOn = deps;
  }
  if (b.tags && typeof b.tags === 'object') m.tags = normalizeTags(b.tags as Record<string, string[]>);
  if (b.parentId !== undefined) {
    const pid = (b.parentId === null || b.parentId === '') ? null : (str(b.parentId) ?? null);
    const pv = validateParent(m.id, pid, await listMissions(port));
    if (!pv.ok) return fail(pv.code, pv.message);
    m.parentId = pid;
  }
```

Then replace the tail of `handlePatch` (lines 171-174):

```ts
  m.lastUpdatedBy = who;
  m.adjustments.push({ at: Date.now(), trigger: 'user-edit', change: 'mission updated via API', by: 'user', actor: who });
  await putMission(m, port);
  return ok(m);
```

with:

```ts
  await putMission(m, port, { actor: who });
  return ok(m);
```

- [ ] **Step 4: Update the MCP create/update schemas** — in `mission.ts`, in `mission_create`'s `inputSchema` props (after `nextSteps: SARR,` line 53) add `tags: { type: 'object' as const }, parentId: S,`. In `mission_update`'s `inputSchema` props (after `projects: SARR,` line 91) add `tags: { type: 'object' as const }, parentId: S,`.

- [ ] **Step 5: Update the provenance-routes test** — in `mission-provenance-routes.test.ts`, the test `patch sets lastUpdatedBy and appends an attributed adjustment`: the generic adjustment is gone. Replace its body's last two assertions with the history-based equivalent:

```ts
  assert.equal(m.lastUpdatedBy.kind, 'user');
  assert.equal(m.history[m.history.length - 1].actor.kind, 'user');
```

(and rename the test to `patch sets lastUpdatedBy and records an attributed history entry`).

- [ ] **Step 6: Run to confirm GREEN** (new suite + the provenance + store suites)

Run: `cd core && npm run build:test >/dev/null 2>&1 && node --test --test-reporter=spec dist-test/__tests__/mission-foundation-routes.test.js dist-test/__tests__/mission-provenance-routes.test.js dist-test/__tests__/mission-routes.test.js`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add core/src/routes/core/mission.routes.ts core/src/mcp-server/tools/mission.ts core/src/__tests__/mission-foundation-routes.test.ts core/src/__tests__/mission-provenance-routes.test.ts
git commit -m "feat(mission): create/patch accept tags+parentId, validate, version via putMission"
```

---

### Task 7: `mission_tag` tool + `POST /mission/:id/tags`

**Files:**
- Modify: `core/src/routes/core/mission.routes.ts` (handleTag + route)
- Modify: `core/src/mcp-server/tools/mission.ts` (tool def + handler)
- Modify: `core/src/mcp-server/configure.ts` (scope)
- Test: `core/src/__tests__/mission-tag.test.ts`

**Interfaces:**
- Consumes: `mergeTags` (Task 3), `putMission(opts)` (Task 5), `actorFor`/`anchorToLeader`/`getMission` (existing).
- Produces: `handleTag(id, b, port?, actor?, leader?): Promise<Envelope>`; route `POST /mission/:id/tags`; MCP `mission_tag`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-tag.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { handleCreate, handleTag } from '../routes/core/mission.routes';
import type { Mission, MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
function memPort() {
  const db = new Map<string, Mission>();
  // clone on BOTH get and put: simulate LMDB independent reads, so putMission's pre-image diff works.
  return { db, get: async (id: string) => { const v = db.get(id); return v ? JSON.parse(JSON.stringify(v)) : null; }, list: async () => [...db.values()], put: async (m: Mission) => { db.set(m.id, JSON.parse(JSON.stringify(m))); } };
}

test('mission_tag add/remove/set merges and flows through history', async () => {
  const port = memPort();
  const m = (await handleCreate({ title: 't', objective: 'o', tags: { component: ['controller'] } }, 'n', port as any, actor)).data as Mission;
  const r1 = await handleTag(m.id, { add: { component: ['web'] } }, port as any, actor);
  assert.deepEqual((r1.data as Mission).tags.component, ['controller', 'web']);
  assert.equal((r1.data as Mission).rev, 2);
  const last = (r1.data as Mission).history.at(-1)!;
  assert.deepEqual(last.changes['tags.component'], { from: ['controller'], to: ['controller', 'web'] });
  const r2 = await handleTag(m.id, { remove: { component: ['controller'] } }, port as any, actor);
  assert.deepEqual((r2.data as Mission).tags.component, ['web']);
});

test('mission_tag on a missing mission returns NOT_FOUND', async () => {
  const port = memPort();
  const r = await handleTag('mission_zzz', { add: { x: ['y'] } }, port as any, actor);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'NOT_FOUND');
});
```

- [ ] **Step 2: Run it to confirm RED**

Run: `cd core && npm run build:test 2>&1 | grep mission-tag`
Expected: compile error — `handleTag` not exported.

- [ ] **Step 3: Implement** — in `mission.routes.ts`:

Add `mergeTags` to the graph import: `import { normalizeTags, mergeTags, validateParent, validateDependsOn } from '../../mission/mission-graph';`

After `handlePatch` (line 175) add:

```ts
export async function handleTag(id: string, b: Record<string, unknown>, port?: MissionDataPort, actor?: MissionActor, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'POST', `/mission/${encodeURIComponent(id)}/tags`, b, true);
  if (anchored) return anchored;
  const who = actor ?? await actorFor(b);
  const m = await getMission(id, port);
  if (!m) return fail('NOT_FOUND', `no mission ${id}`);
  const asMap = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, string[]> : undefined;
  m.tags = mergeTags(m.tags ?? {}, { add: asMap(b.add), remove: asMap(b.remove), set: asMap(b.set) });
  await putMission(m, port, { actor: who });
  return ok(m);
}
```

In `createMissionRoutes`, add BEFORE the `GET /mission/:id` route (before line 1080):

```ts
    { method: 'POST', pattern: /^\/mission\/(?<id>[^/]+)\/tags$/, handler: async (req) => handleTag(req.params.id, (req.body || {}) as Record<string, unknown>, undefined, undefined, realLeaderAnchor()) },
```

- [ ] **Step 4: Add the MCP tool** — in `mission.ts`, append to `MISSION_TOOL_DEFS` (after `mission_session_resume`, before the closing `] as const;`):

```ts
  {
    name: 'mission_tag',
    description:
      'Add/remove/set a mission\'s tags by dimension (e.g. project/feature/component) without read-modify-write. ' +
      '{id, add?:{dim:[vals]}, remove?:{dim:[vals]}, set?:{dim:[vals]}}. set replaces a dimension; add/remove merge or subtract. ' +
      'Recorded in the mission history with provenance.',
    inputSchema: obj({ id: S, add: { type: 'object' as const }, remove: { type: 'object' as const }, set: { type: 'object' as const } }, ['id']),
  },
```

and add to `MISSION_HANDLERS`:

```ts
  mission_tag: async (a) => {
    try {
      const id = String(a.id || '');
      if (!id) return err('id is required');
      const body: Record<string, unknown> = {};
      if (a.add) body.add = a.add;
      if (a.remove) body.remove = a.remove;
      if (a.set) body.set = a.set;
      return pretty(await workerPost(`/mission/${encodeURIComponent(id)}/tags`, withActorHint(body, currentMcpContext()?.toolUseId)));
    } catch (e) { return err((e as Error).message); }
  },
```

- [ ] **Step 5: Add the scope** — in `configure.ts`, after `mission_session_resume: 'write',` (line 263) add `mission_tag: 'write',`.

- [ ] **Step 6: Run to confirm GREEN + scope coverage**

Run: `cd core && npm run build:test >/dev/null 2>&1 && node --test --test-reporter=spec dist-test/__tests__/mission-tag.test.js && node -e "require('./dist/mcp-server/configure').assertScopesCoverTools(); console.log('SCOPES_OK')"`
Expected: tests pass; prints `SCOPES_OK`.

- [ ] **Step 7: Commit**

```bash
git add core/src/routes/core/mission.routes.ts core/src/mcp-server/tools/mission.ts core/src/mcp-server/configure.ts core/src/__tests__/mission-tag.test.ts
git commit -m "feat(mission): mission_tag delta tool + POST /mission/:id/tags"
```

---

### Task 8: `mission_history` tool + `GET /mission/:id/history`

**Files:**
- Modify: `core/src/routes/core/mission.routes.ts` (handleHistory + route)
- Modify: `core/src/mcp-server/tools/mission.ts` (tool def + handler)
- Modify: `core/src/mcp-server/configure.ts` (scope)
- Test: `core/src/__tests__/mission-history-route.test.ts`

**Interfaces:**
- Consumes: `listMissionHistory` + `MissionHistoryRecord` (Task 4).
- Produces: `handleHistory(id, opts, port?, leader?, listHistory?): Promise<Envelope>`; route `GET /mission/:id/history`; MCP `mission_history`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-history-route.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { handleHistory } from '../routes/core/mission.routes';
import type { MissionHistoryRecord } from '../mission/mission-store';

const rec = (rev: number): MissionHistoryRecord => ({ id: `mission_a:${rev}`, missionId: 'mission_a', rev, at: rev, actor: { kind: 'user', channel: 'mcp', node: 'n', at: rev }, changes: { status: { from: 'a', to: 'b' } } });

test('handleHistory returns rows from the injected lister, newest-first', async () => {
  const fakeList = async (id: string, opts: { limit?: number; beforeRev?: number }) => {
    assert.equal(id, 'mission_a');
    assert.equal(opts.limit, 2);
    return [rec(4), rec(3)];
  };
  const r = await handleHistory('mission_a', { limit: 2 }, undefined, fakeList as any);
  assert.equal(r.success, true);
  assert.deepEqual(((r.data as { history: MissionHistoryRecord[] }).history).map((x) => x.rev), [4, 3]);
});
```

- [ ] **Step 2: Run it to confirm RED**

Run: `cd core && npm run build:test 2>&1 | grep mission-history-route`
Expected: compile error — `handleHistory` not exported.

- [ ] **Step 3: Implement** — in `mission.routes.ts`:

Add to the `mission-store` import (lines 7-9): add `listMissionHistory`. After `handleTag` add:

```ts
export async function handleHistory(
  id: string,
  opts: { limit?: number; beforeRev?: number },
  leader?: LeaderAnchorDeps,
  listHistory: typeof listMissionHistory = listMissionHistory,
): Promise<Envelope> {
  const qs = new URLSearchParams();
  if (opts.limit != null) qs.set('limit', String(opts.limit));
  if (opts.beforeRev != null) qs.set('beforeRev', String(opts.beforeRev));
  const path = `/mission/${encodeURIComponent(id)}/history${qs.toString() ? `?${qs}` : ''}`;
  const anchored = await anchorToLeader(leader, 'GET', path);
  if (anchored) return anchored;
  return ok({ history: await listHistory(id, opts) });
}
```

`listMissionHistory` uses its own default history port; the `listHistory` param is injected only by the unit test (signature: `handleHistory(id, opts, leader?, listHistory?)`). The route calls `handleHistory(id, opts, realLeaderAnchor())`.

In `createMissionRoutes`, add BEFORE the `GET /mission/:id` route (before line 1080):

```ts
    { method: 'GET', pattern: /^\/mission\/(?<id>[^/]+)\/history$/, handler: async (req) => {
        const limit = req.query?.limit ? parseInt(String(req.query.limit), 10) : undefined;
        const beforeRev = req.query?.beforeRev ? parseInt(String(req.query.beforeRev), 10) : undefined;
        return handleHistory(req.params.id, { limit, beforeRev }, realLeaderAnchor());
      } },
```

- [ ] **Step 4: Add the MCP tool** — in `mission.ts`, append to `MISSION_TOOL_DEFS`:

```ts
  {
    name: 'mission_history',
    description:
      'Page a mission\'s full version history (UNBOUNDED — beyond the recent entries embedded in the mission record). ' +
      'Each entry: {rev, at, actor, changes:{field:{from,to}}}. {id, limit?(default 50), beforeRev?(page older)}. Newest-first.',
    inputSchema: obj({ id: S, limit: { type: 'number' as const }, beforeRev: { type: 'number' as const } }, ['id']),
  },
```

and to `MISSION_HANDLERS` (coerce numeric args — they arrive as strings over the connector):

```ts
  mission_history: async (a) => {
    try {
      const id = String(a.id || '');
      if (!id) return err('id is required');
      const num = (v: unknown) => typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? parseInt(v, 10) : undefined);
      const qs = new URLSearchParams();
      const limit = num(a.limit); const beforeRev = num(a.beforeRev);
      if (limit != null && !Number.isNaN(limit)) qs.set('limit', String(limit));
      if (beforeRev != null && !Number.isNaN(beforeRev)) qs.set('beforeRev', String(beforeRev));
      return pretty(await workerGet(`/mission/${encodeURIComponent(id)}/history${qs.toString() ? `?${qs}` : ''}`));
    } catch (e) { return err((e as Error).message); }
  },
```

- [ ] **Step 5: Add the scope** — in `configure.ts`, after `mission_tag: 'write',` add `mission_history: 'read',`.

- [ ] **Step 6: Run to confirm GREEN + scope coverage + full mission suite**

Run: `cd core && npm run build:test >/dev/null 2>&1 && node --test --test-reporter=spec dist-test/__tests__/mission-history-route.test.js && node -e "require('./dist/mcp-server/configure').assertScopesCoverTools(); console.log('SCOPES_OK')"`
Expected: pass + `SCOPES_OK`.

- [ ] **Step 7: Run the whole mission test set to confirm no regressions**

Run: `cd core && npm run build:test >/dev/null 2>&1 && node --test --test-reporter=spec dist-test/__tests__/mission-*.test.js`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add core/src/routes/core/mission.routes.ts core/src/mcp-server/tools/mission.ts core/src/mcp-server/configure.ts core/src/__tests__/mission-history-route.test.ts
git commit -m "feat(mission): mission_history paging tool + GET /mission/:id/history"
```

---

## Done criteria

- `Mission` carries `tags`, `parentId`, `rev`, `history`; legacy records backfill on read.
- Every tracked-field write (create/patch/tag, via MCP/API/controller) bumps `rev`, appends an inline recent-N entry, and durably spills to `mission-history` (unbounded), with the resolved `MissionActor`.
- Relationship cycles/missing targets are rejected (`CYCLE`/`INVALID_RELATIONSHIP`).
- `mission_create`/`mission_update` accept tags/parentId; `mission_tag` (delta) and `mission_history` (paging) tools exist with boot-safe scopes.
- `./core.sh build` compiles; `node --test dist-test/__tests__/mission-*.test.js` all green; `assertScopesCoverTools()` does not throw.

**Out of scope (later sub-projects):** graph-query API, controller scheduling on tags/deps/history, Mission Dashboard.
