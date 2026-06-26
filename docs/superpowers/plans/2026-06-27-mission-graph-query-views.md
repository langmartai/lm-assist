# Mission Graph-Query API & Dashboard Views — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a headless graph-query backend for missions — attribute + tag-dimension filtering, relationship traversal (parentId tree + dependsOn DAG), drawable graphs — plus saved "views" (query + display hints) the future dashboard renders.

**Architecture:** Two pure engine modules (`mission-filter.ts`, `mission-traverse.ts`) feed three read-only query tools; a `mission-views` dataset (`mission-views-store.ts`) backs four view CRUD tools + a render route. Tools live in a new `mission-query.ts` MCP file; handlers + routes in `mission.routes.ts`; all leader-anchored, mirroring the foundation (sub-project 1).

**Tech Stack:** TypeScript (CommonJS core), LMDB via the generic data service, `node:test`, MCP tools proxying leader-anchored REST.

## Global Constraints

- **Boot-critical scopes:** every advertised MCP tool needs a `TOOL_SCOPES` entry (`core/src/mcp-server/configure.ts`) or `assertScopesCoverTools()` throws at startup. New: `mission_query:'read'`, `mission_neighbors:'read'`, `mission_graph:'read'`, `mission_view_set:'write'`, `mission_view_list:'read'`, `mission_view_get:'read'`, `mission_view_delete:'write'`.
- **Leader-anchored:** reads use `anchorToLeader(leader, METHOD, path, body?, false)` (falls back to the local synced copy on proxy error); writes use `failClosed=true`. New view writes are fail-closed; all query/render reads fall back.
- **Op vocabulary** (mirror `data_query`): `eq, ne, gt, gte, lt, lte, in, nin, contains, regex, wildcard, exists` (+ symbolic `>=,>,<=,<,=,!=,<>`). Array fields (`tags.<dim>`, `dependsOn`, `projects`): `contains`=array-includes, `in`=intersects, `nin`=disjoint, `exists`=non-empty. Bad op → `BAD_FILTER_OP`; bad regex → `BAD_REGEX` (never silently-empty). Reuse the ReDoS guard (`globToRegExp`/`isDangerousPattern`/`safeTest` from `core/src/data/backends/query-filter.ts`).
- **Edge directions:** `parent` edge = `{from: parentId, to: childId, type:'parent'}`; `dependsOn` edge = `{from: missionId, to: dependencyId, type:'dependsOn'}`.
- **Route ordering:** literal/suffix routes (`/mission/query`, `/mission/graph`, `/mission/views`, `/mission/:id/neighbors`, `/mission/views/:id/graph`) MUST register BEFORE the bare `GET /mission/:id` (`mission.routes.ts:1135`) and `/mission/views/:id/graph` before `/mission/views/:id`.
- **Test runner:** `cd core && npm run build:test` (tsc; a RED test = a COMPILE error or assertion failure). Run one file: `node --test --test-reporter=spec dist-test/__tests__/<f>.test.js`. MCP numeric/bool args arrive as STRINGS over the connector — coerce.

## File Structure

- Create `core/src/mission/mission-filter.ts` — `MissionFilter`/`FilterOp`/`MissionSort`, `missionFieldValue`, `filterMissions`, `FilterError`. Pure.
- Create `core/src/mission/mission-traverse.ts` — `Direction`/`MissionEdge`/`MissionNode`, `toNode`, `neighbors`, `subgraphEdges`. Pure.
- Create `core/src/mission/mission-views.ts` — `MissionView`, `newView`, `normalizeView`, `validateView`. Pure.
- Create `core/src/mission/mission-views-store.ts` — `mission-views` dataset + `MissionViewPort` + `getView`/`listViews`/`putView`/`deleteView`. Mirrors `mission-store.ts`.
- Create `core/src/mcp-server/tools/mission-query.ts` — the 7 tool defs/handlers (`MISSION_QUERY_TOOL_DEFS`/`MISSION_QUERY_HANDLERS`).
- Modify `core/src/routes/core/mission.routes.ts` — `handleQuery`/`handleNeighbors`/`handleGraph`/`handleViewSet`/`handleViewList`/`handleViewGet`/`handleViewDelete`/`handleViewGraph` + route registration.
- Modify `core/src/mcp-server/tools/expanded.ts` — import + spread the new tool arrays.
- Modify `core/src/mcp-server/configure.ts` — 7 scopes.

---

### Task 1: Pure filter engine (`mission-filter.ts`)

**Files:**
- Create: `core/src/mission/mission-filter.ts`
- Test: `core/src/__tests__/mission-filter.test.ts`

**Interfaces:**
- Consumes: `Mission` from `./mission-model`; `globToRegExp`, `isDangerousPattern`, `safeTest` from `../data/backends/query-filter`.
- Produces: `type FilterOp`; `interface MissionFilter { field: string; op: FilterOp; value: unknown; flags?: string }`; `interface MissionSort { field: string; dir: 'asc'|'desc' }`; `class FilterError extends Error { code: 'BAD_FILTER_OP'|'BAD_REGEX' }`; `missionFieldValue(m, field): unknown`; `filterMissions(missions, filter?, opts?: { sort?; limit? }): Mission[]`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-filter.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { filterMissions, missionFieldValue, FilterError, type MissionFilter } from '../mission/mission-filter';
import { newMission, type Mission, type MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
const mk = (id: string, over: Partial<Mission> = {}): Mission => ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: actor }, 1, () => id), id, ...over });
const f = (field: string, op: MissionFilter['op'], value: unknown, flags?: string): MissionFilter => ({ field, op, value, flags });

test('missionFieldValue resolves tag dimensions and top-level fields', () => {
  const m = mk('a', { status: 'active', tags: { component: ['web', 'api'] } });
  assert.equal(missionFieldValue(m, 'status'), 'active');
  assert.deepEqual(missionFieldValue(m, 'tags.component'), ['web', 'api']);
  assert.equal(missionFieldValue(m, 'tags.missing'), undefined);
});

test('scalar ops filter on status', () => {
  const ms = [mk('a', { status: 'active' }), mk('b', { status: 'done' })];
  assert.deepEqual(filterMissions(ms, [f('status', 'eq', 'active')]).map((m) => m.id), ['a']);
  assert.deepEqual(filterMissions(ms, [f('status', 'in', ['done', 'failed'])]).map((m) => m.id), ['b']);
  assert.deepEqual(filterMissions(ms, [f('status', 'ne', 'active')]).map((m) => m.id), ['b']);
});

test('array ops on tag dimensions + dependsOn', () => {
  const ms = [mk('a', { tags: { component: ['web'] }, dependsOn: ['x'] }), mk('b', { tags: { component: ['api'] } })];
  assert.deepEqual(filterMissions(ms, [f('tags.component', 'contains', 'web')]).map((m) => m.id), ['a']);
  assert.deepEqual(filterMissions(ms, [f('tags.component', 'in', ['api', 'cli'])]).map((m) => m.id), ['b']);
  assert.deepEqual(filterMissions(ms, [f('tags.component', 'exists', true)]).map((m) => m.id), ['a', 'b']);
  assert.deepEqual(filterMissions(ms, [f('dependsOn', 'contains', 'x')]).map((m) => m.id), ['a']);
});

test('regex + sort + limit; AND of clauses', () => {
  const ms = [mk('a', { title: 'alpha', status: 'active' }), mk('b', { title: 'beta', status: 'active' }), mk('c', { title: 'gamma', status: 'done' })];
  assert.deepEqual(filterMissions(ms, [f('title', 'regex', '^a|^b', 'i'), f('status', 'eq', 'active')]).map((m) => m.id).sort(), ['a', 'b']);
  assert.deepEqual(filterMissions(ms, undefined, { sort: [{ field: 'title', dir: 'desc' }], limit: 2 }).map((m) => m.id), ['c', 'b']);
});

test('bad op + bad regex throw FilterError with codes', () => {
  assert.throws(() => filterMissions([mk('a')], [f('status', 'bogus' as any, 'x')]), (e) => e instanceof FilterError && e.code === 'BAD_FILTER_OP');
  assert.throws(() => filterMissions([mk('a')], [f('title', 'regex', '(')]), (e) => e instanceof FilterError && e.code === 'BAD_REGEX');
});
```

- [ ] **Step 2: Run it to confirm RED**

Run: `cd core && npm run build:test 2>&1 | grep mission-filter`
Expected: compile error — module `../mission/mission-filter` not found.

- [ ] **Step 3: Implement** — create `core/src/mission/mission-filter.ts`:

```ts
/** Pure attribute filter over missions — the data_query op vocabulary + tag-dimension/array semantics. No IO. */
import type { Mission } from './mission-model';
import { globToRegExp, isDangerousPattern, safeTest } from '../data/backends/query-filter';

export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'contains' | 'regex' | 'wildcard' | 'exists';
export interface MissionFilter { field: string; op: FilterOp; value: unknown; flags?: string; }
export interface MissionSort { field: string; dir: 'asc' | 'desc'; }

export class FilterError extends Error {
  constructor(public code: 'BAD_FILTER_OP' | 'BAD_REGEX', message: string) { super(message); this.name = 'FilterError'; }
}

const OP_ALIAS: Record<string, FilterOp> = { '>=': 'gte', '>': 'gt', '<=': 'lte', '<': 'lt', '=': 'eq', '==': 'eq', '!=': 'ne', '<>': 'ne' };

/** Resolve a filter/sort field to a mission value. `tags.<dim>` → that dimension's string[]; else the top-level field. */
export function missionFieldValue(m: Mission, field: string): unknown {
  if (field.startsWith('tags.')) return (m.tags ?? {})[field.slice(5)];
  return (m as unknown as Record<string, unknown>)[field];
}

function reFor(kind: 'regex' | 'wildcard', value: string, flags?: string): RegExp {
  let re: RegExp;
  try { re = kind === 'wildcard' ? globToRegExp(value, { flags }) : new RegExp(value, flags); }
  catch { throw new FilterError('BAD_REGEX', `invalid ${kind}: ${value}`); }
  if (isDangerousPattern(re.source)) throw new FilterError('BAD_REGEX', `unsafe ${kind}: ${value}`);
  return re;
}

function matchOne(v: unknown, fr: MissionFilter): boolean {
  const op = OP_ALIAS[fr.op as string] ?? fr.op;
  const isArr = Array.isArray(v);
  switch (op) {
    case 'exists': return (isArr ? (v as unknown[]).length > 0 : v !== undefined && v !== null) === Boolean(fr.value);
    case 'contains':
      if (isArr) return (v as unknown[]).includes(fr.value);
      return typeof v === 'string' && typeof fr.value === 'string' && v.toLowerCase().includes(fr.value.toLowerCase());
    case 'in':
      if (!Array.isArray(fr.value)) return false;
      return isArr ? (v as unknown[]).some((x) => (fr.value as unknown[]).includes(x)) : (fr.value as unknown[]).includes(v);
    case 'nin':
      if (!Array.isArray(fr.value)) return false;
      return isArr ? !(v as unknown[]).some((x) => (fr.value as unknown[]).includes(x)) : !(fr.value as unknown[]).includes(v);
    case 'eq': return fr.value === null ? v === undefined || v === null : v === fr.value;
    case 'ne': return fr.value === null ? !(v === undefined || v === null) : v !== fr.value;
    case 'gt': return (v as never) > (fr.value as never);
    case 'gte': return (v as never) >= (fr.value as never);
    case 'lt': return (v as never) < (fr.value as never);
    case 'lte': return (v as never) <= (fr.value as never);
    case 'regex': return safeTest(reFor('regex', String(fr.value), fr.flags), String(v));
    case 'wildcard': return safeTest(reFor('wildcard', String(fr.value), fr.flags), String(v));
    default: throw new FilterError('BAD_FILTER_OP', `unknown filter op: ${fr.op}`);
  }
}

export function filterMissions(missions: Mission[], filter?: MissionFilter[], opts?: { sort?: MissionSort[]; limit?: number }): Mission[] {
  let out = missions;
  if (filter?.length) out = out.filter((m) => filter.every((fr) => matchOne(missionFieldValue(m, fr.field), fr)));
  if (opts?.sort?.length) {
    const s = opts.sort;
    out = out.slice().sort((a, b) => {
      for (const { field, dir } of s) {
        const av = missionFieldValue(a, field) as never, bv = missionFieldValue(b, field) as never;
        if (av < bv) return dir === 'asc' ? -1 : 1;
        if (av > bv) return dir === 'asc' ? 1 : -1;
      }
      return 0;
    });
  }
  if (opts?.limit != null) out = out.slice(0, opts.limit);
  return out;
}
```

(Note: confirm `globToRegExp` in `query-filter.ts` takes `(glob, { flags })` — it does; pass `{ flags }`.)

- [ ] **Step 4: Run to confirm GREEN**

Run: `cd core && npm run build:test >/dev/null 2>&1 && node --test --test-reporter=spec dist-test/__tests__/mission-filter.test.js`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add core/src/mission/mission-filter.ts core/src/__tests__/mission-filter.test.ts
git commit -m "feat(mission): pure attribute filter engine (tag dimensions + array ops)"
```

---

### Task 2: Pure traversal engine (`mission-traverse.ts`)

**Files:**
- Create: `core/src/mission/mission-traverse.ts`
- Test: `core/src/__tests__/mission-traverse.test.ts`

**Interfaces:**
- Consumes: `Mission` from `./mission-model`.
- Produces: `type Direction = 'parents'|'children'|'dependencies'|'dependents'|'all'`; `interface MissionEdge { from: string; to: string; type: 'parent'|'dependsOn' }`; `interface MissionNode { id; title; status; tags; parentId; progressPercent? }`; `toNode(m): MissionNode`; `neighbors(id, all, { direction, depth }): { neighbors: Mission[]; edges: MissionEdge[] }`; `subgraphEdges(nodeIds: Set<string>, all): MissionEdge[]`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-traverse.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { neighbors, subgraphEdges, toNode } from '../mission/mission-traverse';
import { newMission, type Mission, type MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
const mk = (id: string, over: Partial<Mission> = {}): Mission => ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: actor }, 1, () => id), id, ...over });
// parent: a->b->c (b parent a, c parent b);  deps: d depends on e
const ALL = [mk('a', { parentId: 'b' }), mk('b', { parentId: 'c' }), mk('c'), mk('d', { dependsOn: ['e'] }), mk('e')];

test('toNode projects the lightweight shape', () => {
  const n = toNode(mk('a', { status: 'active', tags: { x: ['y'] }, parentId: 'b', progress: { percent: 40, summary: 's', updatedAt: 1 } }));
  assert.deepEqual(n, { id: 'a', title: 'a', status: 'active', tags: { x: ['y'] }, parentId: 'b', progressPercent: 40 });
});

test('parents direction walks up to depth', () => {
  const r1 = neighbors('a', ALL, { direction: 'parents', depth: 1 });
  assert.deepEqual(r1.neighbors.map((m) => m.id), ['b']);
  assert.deepEqual(r1.edges, [{ from: 'b', to: 'a', type: 'parent' }]);
  const r2 = neighbors('a', ALL, { direction: 'parents', depth: 2 });
  assert.deepEqual(r2.neighbors.map((m) => m.id).sort(), ['b', 'c']);
});

test('children + dependencies + dependents', () => {
  assert.deepEqual(neighbors('b', ALL, { direction: 'children', depth: 1 }).neighbors.map((m) => m.id), ['a']);
  assert.deepEqual(neighbors('d', ALL, { direction: 'dependencies', depth: 1 }).neighbors.map((m) => m.id), ['e']);
  const dep = neighbors('e', ALL, { direction: 'dependents', depth: 1 });
  assert.deepEqual(dep.neighbors.map((m) => m.id), ['d']);
  assert.deepEqual(dep.edges, [{ from: 'd', to: 'e', type: 'dependsOn' }]);
});

test('all direction is cycle-safe', () => {
  const cyc = [mk('p', { parentId: 'q' }), mk('q', { parentId: 'p' })];
  const r = neighbors('p', cyc, { direction: 'all', depth: 5 });
  assert.deepEqual(r.neighbors.map((m) => m.id), ['q']); // does not loop forever
});

test('subgraphEdges only emits in-set edges', () => {
  const ids = new Set(['a', 'b', 'd']); // c, e excluded
  const edges = subgraphEdges(ids, ALL);
  assert.deepEqual(edges, [{ from: 'b', to: 'a', type: 'parent' }]); // a->b kept; b->c dropped (c out); d->e dropped (e out)
});
```

- [ ] **Step 2: Run it to confirm RED**

Run: `cd core && npm run build:test 2>&1 | grep mission-traverse`
Expected: compile error — module not found.

- [ ] **Step 3: Implement** — create `core/src/mission/mission-traverse.ts`:

```ts
/** Pure mission relationship traversal: parentId tree + dependsOn DAG walks. No IO. */
import type { Mission } from './mission-model';

export type Direction = 'parents' | 'children' | 'dependencies' | 'dependents' | 'all';
export interface MissionEdge { from: string; to: string; type: 'parent' | 'dependsOn'; }
export interface MissionNode { id: string; title: string; status: string; tags: Record<string, string[]>; parentId: string | null; progressPercent?: number; }

export function toNode(m: Mission): MissionNode {
  return { id: m.id, title: m.title, status: m.status, tags: m.tags ?? {}, parentId: m.parentId ?? null, progressPercent: m.progress?.percent };
}

/** One mission's neighbors by direction, BFS to `depth` (cycle-safe). Returns full missions + the edges traversed. */
export function neighbors(id: string, all: Mission[], opts: { direction: Direction; depth: number }): { neighbors: Mission[]; edges: MissionEdge[] } {
  const byId = new Map(all.map((m) => [m.id, m]));
  const want = opts.direction;
  const seen = new Set<string>([id]);
  const resultIds = new Set<string>();
  const edges: MissionEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (e: MissionEdge) => { const k = `${e.type}:${e.from}->${e.to}`; if (!edgeKeys.has(k)) { edgeKeys.add(k); edges.push(e); } };
  const visit = (newId: string, e: MissionEdge): string | null => { addEdge(e); if (seen.has(newId)) return null; seen.add(newId); resultIds.add(newId); return newId; };
  let frontier = [id];
  for (let d = 0; d < Math.max(1, opts.depth) && frontier.length; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const m = byId.get(cur);
      if (!m) continue;
      if ((want === 'parents' || want === 'all') && m.parentId && byId.has(m.parentId)) { const n = visit(m.parentId, { from: m.parentId, to: m.id, type: 'parent' }); if (n) next.push(n); }
      if (want === 'children' || want === 'all') for (const c of all) if (c.parentId === cur) { const n = visit(c.id, { from: cur, to: c.id, type: 'parent' }); if (n) next.push(n); }
      if (want === 'dependencies' || want === 'all') for (const dep of m.dependsOn ?? []) if (byId.has(dep)) { const n = visit(dep, { from: cur, to: dep, type: 'dependsOn' }); if (n) next.push(n); }
      if (want === 'dependents' || want === 'all') for (const c of all) if ((c.dependsOn ?? []).includes(cur)) { const n = visit(c.id, { from: c.id, to: cur, type: 'dependsOn' }); if (n) next.push(n); }
    }
    frontier = next;
  }
  return { neighbors: [...resultIds].map((x) => byId.get(x)!).filter(Boolean), edges };
}

/** Every parent + dependsOn edge BETWEEN nodes in the set. */
export function subgraphEdges(nodeIds: Set<string>, all: Mission[]): MissionEdge[] {
  const edges: MissionEdge[] = [];
  for (const m of all) {
    if (!nodeIds.has(m.id)) continue;
    if (m.parentId && nodeIds.has(m.parentId)) edges.push({ from: m.parentId, to: m.id, type: 'parent' });
    for (const dep of m.dependsOn ?? []) if (nodeIds.has(dep)) edges.push({ from: m.id, to: dep, type: 'dependsOn' });
  }
  return edges;
}
```

- [ ] **Step 4: Run to confirm GREEN**

Run: `cd core && npm run build:test >/dev/null 2>&1 && node --test --test-reporter=spec dist-test/__tests__/mission-traverse.test.js`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add core/src/mission/mission-traverse.ts core/src/__tests__/mission-traverse.test.ts
git commit -m "feat(mission): pure relationship traversal engine (neighbors + subgraphEdges)"
```

---

### Task 3: Query tools + routes (`mission_query`/`mission_neighbors`/`mission_graph`)

**Files:**
- Modify: `core/src/routes/core/mission.routes.ts` (3 handlers + 3 routes)
- Create: `core/src/mcp-server/tools/mission-query.ts` (tool defs/handlers)
- Modify: `core/src/mcp-server/tools/expanded.ts` (register the new file)
- Modify: `core/src/mcp-server/configure.ts` (3 read scopes)
- Test: `core/src/__tests__/mission-query-routes.test.ts`

**Interfaces:**
- Consumes: `filterMissions`/`FilterError` (Task 1); `neighbors`/`subgraphEdges`/`toNode` (Task 2); `listMissions`/`getMission` + `anchorToLeader`/`ok`/`fail`/`Envelope` (existing in routes); `obj`/`S`/`workerGet`/`workerPost`/`err`/`pretty` (existing in `mission.ts` — re-create the sugar locally in `mission-query.ts`).
- Produces: `handleQuery`/`handleNeighbors`/`handleGraph`; routes `POST /mission/query`, `GET /mission/:id/neighbors`, `POST /mission/graph`; `MISSION_QUERY_TOOL_DEFS`/`MISSION_QUERY_HANDLERS` (extended in Task 6).

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-query-routes.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { handleQuery, handleNeighbors, handleGraph } from '../routes/core/mission.routes';
import { newMission, type Mission, type MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
const mk = (id: string, over: Partial<Mission> = {}): Mission => ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: actor }, 1, () => id), id, ...over });
function memPort(seed: Mission[]) {
  const db = new Map(seed.map((m) => [m.id, m]));
  return { db, get: async (id: string) => db.get(id) ?? null, list: async () => [...db.values()], put: async (m: Mission) => { db.set(m.id, m); } };
}

test('handleQuery filters by status', async () => {
  const port = memPort([mk('a', { status: 'active' }), mk('b', { status: 'done' })]);
  const r = await handleQuery({ filter: [{ field: 'status', op: 'eq', value: 'active' }] }, port as any);
  assert.deepEqual((r.data as { missions: Mission[] }).missions.map((m) => m.id), ['a']);
});

test('handleQuery surfaces a bad op as a structured error', async () => {
  const port = memPort([mk('a')]);
  const r = await handleQuery({ filter: [{ field: 'status', op: 'bogus', value: 'x' }] }, port as any);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'BAD_FILTER_OP');
});

test('handleNeighbors returns neighbors + edges; NOT_FOUND for missing', async () => {
  const port = memPort([mk('a', { parentId: 'b' }), mk('b')]);
  const r = await handleNeighbors('a', { direction: 'parents', depth: 1 }, port as any);
  const d = r.data as { neighbors: Array<{ id: string }>; edges: unknown[] };
  assert.deepEqual(d.neighbors.map((n) => n.id), ['b']);
  assert.deepEqual(d.edges, [{ from: 'b', to: 'a', type: 'parent' }]);
  assert.equal((await handleNeighbors('zzz', {}, port as any)).error!.code, 'NOT_FOUND');
});

test('handleGraph returns nodes + edges, with expand', async () => {
  const port = memPort([mk('a', { status: 'active', dependsOn: ['b'] }), mk('b', { status: 'done' })]);
  const r = await handleGraph({ filter: [{ field: 'status', op: 'eq', value: 'active' }], expand: { direction: 'dependencies', depth: 1 } }, port as any);
  const d = r.data as { nodes: Array<{ id: string }>; edges: Array<{ from: string; to: string; type: string }> };
  assert.deepEqual(d.nodes.map((n) => n.id).sort(), ['a', 'b']);
  assert.deepEqual(d.edges, [{ from: 'a', to: 'b', type: 'dependsOn' }]);
});
```

- [ ] **Step 2: Run it to confirm RED**

Run: `cd core && npm run build:test 2>&1 | grep mission-query-routes`
Expected: compile error — `handleQuery`/`handleNeighbors`/`handleGraph` not exported.

- [ ] **Step 3: Add the route handlers** — in `mission.routes.ts`, add imports near the other mission imports:

```ts
import { filterMissions, FilterError, type MissionFilter, type MissionSort } from '../../mission/mission-filter';
import { neighbors, subgraphEdges, toNode, type Direction } from '../../mission/mission-traverse';
```

After `handleHistory` (or near the other read handlers), add:

```ts
function asFilter(v: unknown): MissionFilter[] | undefined { return Array.isArray(v) ? (v as MissionFilter[]) : undefined; }
function asSort(v: unknown): MissionSort[] | undefined { return Array.isArray(v) ? (v as MissionSort[]) : undefined; }
const DIRS = new Set<Direction>(['parents', 'children', 'dependencies', 'dependents', 'all']);

export async function handleQuery(b: Record<string, unknown>, port?: MissionDataPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'POST', '/mission/query', b, false);
  if (anchored) return anchored;
  try {
    const limit = typeof b.limit === 'number' ? b.limit : (typeof b.limit === 'string' ? parseInt(b.limit, 10) : undefined);
    const missions = filterMissions(await listMissions(port), asFilter(b.filter), { sort: asSort(b.sort), limit: limit != null && !Number.isNaN(limit) ? limit : undefined });
    return ok({ missions });
  } catch (e) { if (e instanceof FilterError) return fail(e.code, e.message); throw e; }
}

export async function handleNeighbors(id: string, b: Record<string, unknown>, port?: MissionDataPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const dir = (typeof b.direction === 'string' && DIRS.has(b.direction as Direction)) ? (b.direction as Direction) : 'all';
  const depth = typeof b.depth === 'number' ? b.depth : (typeof b.depth === 'string' ? parseInt(b.depth, 10) : 1);
  const anchored = await anchorToLeader(leader, 'POST', `/mission/${encodeURIComponent(id)}/neighbors`, { direction: dir, depth }, false);
  if (anchored) return anchored;
  const m = await getMission(id, port);
  if (!m) return fail('NOT_FOUND', `no mission ${id}`);
  const all = await listMissions(port);
  const r = neighbors(id, all, { direction: dir, depth: !Number.isNaN(depth) ? depth : 1 });
  return ok({ mission: m, neighbors: r.neighbors.map(toNode), edges: r.edges });
}

export async function handleGraph(b: Record<string, unknown>, port?: MissionDataPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'POST', '/mission/graph', b, false);
  if (anchored) return anchored;
  try {
    const all = await listMissions(port);
    const matches = filterMissions(all, asFilter(b.filter));
    const nodeIds = new Set(matches.map((m) => m.id));
    const exp = b.expand as { direction?: string; depth?: number } | undefined;
    if (exp && typeof exp === 'object') {
      const dir = (typeof exp.direction === 'string' && DIRS.has(exp.direction as Direction)) ? (exp.direction as Direction) : 'all';
      const depth = typeof exp.depth === 'number' ? exp.depth : 1;
      for (const m of matches) for (const n of neighbors(m.id, all, { direction: dir, depth }).neighbors) nodeIds.add(n.id);
    }
    const byId = new Map(all.map((m) => [m.id, m]));
    const nodes = [...nodeIds].map((id) => byId.get(id)).filter(Boolean).map((m) => toNode(m!));
    return ok({ nodes, edges: subgraphEdges(nodeIds, all) });
  } catch (e) { if (e instanceof FilterError) return fail(e.code, e.message); throw e; }
}
```

- [ ] **Step 4: Register the routes** — `/mission/query` and `/mission/graph` are single-segment, so they MUST come before **every** `/mission/:id` pattern (both `GET` at `mission.routes.ts:1135` and the `PATCH`/`POST` mirrors right after it) — else `POST /mission/query` matches `POST /mission/:id` with `id='query'`. Place the two literal routes with the top literal routes (right after `/mission/sessions` / `/mission/controller`); place `/:id/neighbors` (a suffix route) before the bare `GET /mission/:id`:

```ts
    // literal — register with /mission/sessions and /mission/controller, before any /mission/:id pattern:
    { method: 'POST', pattern: /^\/mission\/query$/, handler: async (req) => handleQuery((req.body || {}) as Record<string, unknown>, undefined, realLeaderAnchor()) },
    { method: 'POST', pattern: /^\/mission\/graph$/, handler: async (req) => handleGraph((req.body || {}) as Record<string, unknown>, undefined, realLeaderAnchor()) },
    // suffix — before the bare GET /mission/:id:
    { method: 'POST', pattern: /^\/mission\/(?<id>[^/]+)\/neighbors$/, handler: async (req) => handleNeighbors(req.params.id, (req.body || {}) as Record<string, unknown>, undefined, realLeaderAnchor()) },
```

- [ ] **Step 5: Create the MCP tools** — create `core/src/mcp-server/tools/mission-query.ts`:

```ts
/** Mission graph-query + view MCP tools (proxy the /mission query/view routes). */
import type { McpToolResult } from '../configure';
import { ok, err, workerPost } from './_passthrough';
import { currentMcpContext } from '../principal-context';

export function withActorHint(args: Record<string, unknown>, toolUseId: string | undefined): Record<string, unknown> {
  return { ...args, _actor: { channel: 'mcp', toolUseId: toolUseId ?? null } };
}
const S = { type: 'string' as const };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties: props, required });
const pretty = (v: unknown): McpToolResult => ok(JSON.stringify(v, null, 2));
const FILTER = { type: 'array' as const, items: { type: 'object' as const, properties: { field: S, op: S, value: {}, flags: S }, required: ['field', 'op'] }, description: 'AND-ed clauses {field,op,value,flags?}; op ∈ eq/ne/gt/gte/lt/lte/in/nin/contains/regex/wildcard/exists. tags.<dim>/dependsOn/projects are array fields (contains=includes, in=intersects, exists=non-empty).' };
const EXPAND = { type: 'object' as const, properties: { direction: { ...S, enum: ['parents', 'children', 'dependencies', 'dependents', 'all'] }, depth: { type: 'number' as const } } };

export const MISSION_QUERY_TOOL_DEFS = [
  { name: 'mission_query', description: 'Filter missions by attributes incl. tag dimensions (tags.<dim>). Returns the matching missions. {filter?:[{field,op,value}], sort?:[{field,dir}], limit?}.', inputSchema: obj({ filter: FILTER, sort: { type: 'array' as const, items: { type: 'object' as const } }, limit: { type: 'number' as const } }) },
  { name: 'mission_neighbors', description: 'Relationship neighbors of ONE mission: parents/children (parentId) + dependencies/dependents (dependsOn), BFS to depth. {id, direction?:parents|children|dependencies|dependents|all (default all), depth?(default 1)}.', inputSchema: obj({ id: S, direction: { ...S, enum: ['parents', 'children', 'dependencies', 'dependents', 'all'] }, depth: { type: 'number' as const } }, ['id']) },
  { name: 'mission_graph', description: 'Drawable graph: filter selects matches, optional expand pulls in their neighbors; returns {nodes,edges:[{from,to,type:parent|dependsOn}]}. {filter?, expand?:{direction,depth}}.', inputSchema: obj({ filter: FILTER, expand: EXPAND }) },
] as const;

export const MISSION_QUERY_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  mission_query: async (a) => { try { return pretty(await workerPost('/mission/query', a)); } catch (e) { return err((e as Error).message); } },
  mission_neighbors: async (a) => { try { const id = String(a.id || ''); if (!id) return err('id is required'); return pretty(await workerPost(`/mission/${encodeURIComponent(id)}/neighbors`, a)); } catch (e) { return err((e as Error).message); } },
  mission_graph: async (a) => { try { return pretty(await workerPost('/mission/graph', a)); } catch (e) { return err((e as Error).message); } },
};
```

- [ ] **Step 6: Register in `expanded.ts`** — add after the `./mission` import (`expanded.ts:52`):

```ts
import { MISSION_QUERY_TOOL_DEFS, MISSION_QUERY_HANDLERS } from './mission-query';
```
After `...MISSION_TOOL_DEFS,` (line 922) add `...MISSION_QUERY_TOOL_DEFS,`; after `...MISSION_HANDLERS,` (line 1677) add `...MISSION_QUERY_HANDLERS,`.

- [ ] **Step 7: Add scopes** — in `configure.ts`, after `mission_history: 'read',` (line 265) add:

```ts
  mission_query: 'read',
  mission_neighbors: 'read',
  mission_graph: 'read',
```

- [ ] **Step 8: Run to confirm GREEN + scope coverage**

Run: `cd core && npm run build:test >/dev/null 2>&1 && node --test --test-reporter=spec dist-test/__tests__/mission-query-routes.test.js && node -e "require('./dist/mcp-server/configure').assertScopesCoverTools(); console.log('SCOPES_OK')"`
Expected: 4 pass; prints `SCOPES_OK`.

- [ ] **Step 9: Commit**

```bash
git add core/src/routes/core/mission.routes.ts core/src/mcp-server/tools/mission-query.ts core/src/mcp-server/tools/expanded.ts core/src/mcp-server/configure.ts core/src/__tests__/mission-query-routes.test.ts
git commit -m "feat(mission): mission_query/mission_neighbors/mission_graph tools + routes"
```

---

### Task 4: Pure view model (`mission-views.ts`)

**Files:**
- Create: `core/src/mission/mission-views.ts`
- Test: `core/src/__tests__/mission-views.test.ts`

**Interfaces:**
- Consumes: `MissionActor` from `./mission-model`; `MissionFilter` (Task 1); `Direction` (Task 2).
- Produces: `interface MissionView { id; name; query: { filter?; expand? }; display: { groupBy?; highlight?; layout?; nodeFields? }; createdBy; lastUpdatedBy; createdAt; updatedAt }`; `newView(input, now, genId): MissionView`; `normalizeView(v): MissionView`; `validateView(v): { ok: true } | { ok: false; message: string }`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-views.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { newView, normalizeView, validateView, type MissionView } from '../mission/mission-views';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };

test('newView seeds defaults + provenance', () => {
  const v = newView({ name: 'Active by project', query: { filter: [{ field: 'status', op: 'eq', value: 'active' }] }, display: { groupBy: 'project', layout: 'dag' }, createdBy: actor }, 1000, () => 'view_x');
  assert.equal(v.id, 'view_x');
  assert.equal(v.name, 'Active by project');
  assert.equal(v.display.layout, 'dag');
  assert.equal(v.createdBy.kind, 'user');
  assert.equal(v.createdAt, 1000);
});

test('normalizeView trims name + drops an invalid layout', () => {
  const v = normalizeView({ id: 'view_y', name: '  v  ', query: {}, display: { layout: 'bogus' as never, groupBy: 'project' }, createdBy: actor, lastUpdatedBy: actor, createdAt: 1, updatedAt: 1 } as MissionView);
  assert.equal(v.name, 'v');
  assert.equal(v.display.layout, undefined);
  assert.equal(v.display.groupBy, 'project');
});

test('validateView rejects empty name + bad direction', () => {
  assert.equal(validateView({ name: '' } as MissionView).ok, false);
  assert.equal(validateView({ name: 'ok', query: { expand: { direction: 'sideways' as never } } } as MissionView).ok, false);
  assert.equal(validateView({ name: 'ok', query: { expand: { direction: 'all' } }, display: {} } as MissionView).ok, true);
});
```

- [ ] **Step 2: Run it to confirm RED**

Run: `cd core && npm run build:test 2>&1 | grep mission-views.test`
Expected: compile error — module not found.

- [ ] **Step 3: Implement** — create `core/src/mission/mission-views.ts`:

```ts
/** Pure mission-view model: a saved query + display hints the dashboard renders. No IO. */
import type { MissionActor } from './mission-model';
import type { MissionFilter } from './mission-filter';
import type { Direction } from './mission-traverse';

export interface MissionView {
  id: string;
  name: string;
  query: { filter?: MissionFilter[]; expand?: { direction?: Direction; depth?: number } };
  display: { groupBy?: string; highlight?: MissionFilter[]; layout?: 'tree' | 'dag'; nodeFields?: string[] };
  createdBy: MissionActor;
  lastUpdatedBy: MissionActor;
  createdAt: number;
  updatedAt: number;
}

const LAYOUTS = new Set(['tree', 'dag']);
const DIRS = new Set(['parents', 'children', 'dependencies', 'dependents', 'all']);

export interface NewViewInput { name: string; query?: MissionView['query']; display?: MissionView['display']; createdBy: MissionActor; }

export function newView(input: NewViewInput, now: number, genId: () => string): MissionView {
  return normalizeView({
    id: genId(), name: input.name, query: input.query ?? {}, display: input.display ?? {},
    createdBy: input.createdBy, lastUpdatedBy: input.createdBy, createdAt: now, updatedAt: now,
  });
}

/** Trim name, coerce display enums, keep only known display keys. */
export function normalizeView(v: MissionView): MissionView {
  const d = v.display ?? {};
  return {
    ...v,
    name: String(v.name ?? '').trim(),
    query: v.query ?? {},
    display: {
      groupBy: typeof d.groupBy === 'string' ? d.groupBy : undefined,
      highlight: Array.isArray(d.highlight) ? d.highlight : undefined,
      layout: LAYOUTS.has(d.layout as string) ? d.layout : undefined,
      nodeFields: Array.isArray(d.nodeFields) ? d.nodeFields.filter((x) => typeof x === 'string') : undefined,
    },
  };
}

export function validateView(v: MissionView): { ok: true } | { ok: false; message: string } {
  if (!v.name || !String(v.name).trim()) return { ok: false, message: 'view name is required' };
  const dir = v.query?.expand?.direction;
  if (dir != null && !DIRS.has(dir)) return { ok: false, message: `invalid expand direction "${dir}"` };
  if (v.display?.layout != null && !LAYOUTS.has(v.display.layout)) return { ok: false, message: `invalid layout "${v.display.layout}"` };
  return { ok: true };
}
```

- [ ] **Step 4: Run to confirm GREEN**

Run: `cd core && npm run build:test >/dev/null 2>&1 && node --test --test-reporter=spec dist-test/__tests__/mission-views.test.js`
Expected: 3 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add core/src/mission/mission-views.ts core/src/__tests__/mission-views.test.ts
git commit -m "feat(mission): pure mission-view model (query + display hints)"
```

---

### Task 5: View store (`mission-views-store.ts`)

**Files:**
- Create: `core/src/mission/mission-views-store.ts`
- Test: `core/src/__tests__/mission-views-store.test.ts`

**Interfaces:**
- Consumes: `MissionView` (Task 4); `getDataService` from `../data/data-service`.
- Produces: `interface MissionViewPort { isEnabled(); get(id); list(); put(v); del(id) }`; `getView(id, port?)`; `listViews(port?)`; `putView(v, port?)`; `deleteView(id, port?)`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-views-store.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { getView, listViews, putView, deleteView, type MissionViewPort } from '../mission/mission-views-store';
import type { MissionView } from '../mission/mission-views';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
const v = (id: string): MissionView => ({ id, name: id, query: {}, display: {}, createdBy: actor, lastUpdatedBy: actor, createdAt: 1, updatedAt: 1 });
function memPort(): MissionViewPort & { db: Map<string, MissionView> } {
  const db = new Map<string, MissionView>();
  return { db, isEnabled: () => true, get: async (id) => db.get(id) ?? null, list: async () => [...db.values()], put: async (x) => { db.set(x.id, x); }, del: async (id) => { db.delete(id); } };
}

test('put/get/list/delete round-trip', async () => {
  const p = memPort();
  await putView(v('view_a'), p);
  await putView(v('view_b'), p);
  assert.equal((await getView('view_a', p))!.name, 'view_a');
  assert.deepEqual((await listViews(p)).map((x) => x.id).sort(), ['view_a', 'view_b']);
  await deleteView('view_a', p);
  assert.equal(await getView('view_a', p), null);
  assert.deepEqual((await listViews(p)).map((x) => x.id), ['view_b']);
});
```

- [ ] **Step 2: Run it to confirm RED**

Run: `cd core && npm run build:test 2>&1 | grep mission-views-store`
Expected: compile error — module not found.

- [ ] **Step 3: Implement** — create `core/src/mission/mission-views-store.ts` (mirrors the `livePort()` pattern in `mission-store.ts`):

```ts
/** Cross-node mission-view store backed by the data service (dataset `mission-views`, syncMode:'full'). */
import type { MissionView } from './mission-views';
import { getDataService } from '../data/data-service';
import type { CallCtx } from '../data/data-service';
import type { DataRecord } from '../data/types';

const DATASET = 'mission-views';
function systemCtx(): CallCtx { return { principal: { type: 'local' } }; }

export interface MissionViewPort {
  isEnabled(): boolean;
  get(id: string): Promise<MissionView | null>;
  list(): Promise<MissionView[]>;
  put(v: MissionView): Promise<void>;
  del(id: string): Promise<void>;
}

let ensured = false;
async function ensureDataset(svc: ReturnType<typeof getDataService>): Promise<void> {
  if (ensured) return;
  try {
    await svc.createDataset(systemCtx(), { id: DATASET, backend: 'cache', title: 'Mission Views', visibility: 'cross-node-readable', syncMode: 'full', config: { kind: 'cache' } } as any);
  } catch { /* already exists — fine */ }
  ensured = true;
}

function livePort(): MissionViewPort {
  return {
    isEnabled: () => getDataService().isEnabled(),
    get: async (id) => { const svc = getDataService(); if (!svc.isEnabled()) return null; await ensureDataset(svc); const r = await svc.get(systemCtx(), DATASET, id); return r.ok && r.value ? (r.value.fields as unknown as MissionView) : null; },
    list: async () => { const svc = getDataService(); if (!svc.isEnabled()) return []; await ensureDataset(svc); const r = await svc.query(systemCtx(), DATASET, { limit: 10000 } as any); return r.ok ? r.value.records.map((rec) => rec.fields as unknown as MissionView) : []; },
    put: async (v) => { const svc = getDataService(); if (!svc.isEnabled()) return; await ensureDataset(svc); const now = new Date().toISOString(); await svc.put(systemCtx(), DATASET, { id: v.id, version: 0, fields: { ...v } as Record<string, unknown>, createdAt: now, updatedAt: now } as DataRecord); },
    del: async (id) => { const svc = getDataService(); if (!svc.isEnabled()) return; await ensureDataset(svc); await svc.del(systemCtx(), DATASET, id); },
  };
}
let _default: MissionViewPort | null = null;
function defaultPort(): MissionViewPort { return _default ?? (_default = livePort()); }

export async function getView(id: string, port: MissionViewPort = defaultPort()): Promise<MissionView | null> { return port.get(id); }
export async function listViews(port: MissionViewPort = defaultPort()): Promise<MissionView[]> { return port.list(); }
export async function putView(v: MissionView, port: MissionViewPort = defaultPort()): Promise<void> { v.updatedAt = Date.now(); await port.put(v); }
export async function deleteView(id: string, port: MissionViewPort = defaultPort()): Promise<void> { await port.del(id); }
```

- [ ] **Step 4: Run to confirm GREEN**

Run: `cd core && npm run build:test >/dev/null 2>&1 && node --test --test-reporter=spec dist-test/__tests__/mission-views-store.test.js`
Expected: 1 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add core/src/mission/mission-views-store.ts core/src/__tests__/mission-views-store.test.ts
git commit -m "feat(mission): mission-views dataset + store (full-sync, leader-anchored)"
```

---

### Task 6: View tools + routes + render

**Files:**
- Modify: `core/src/routes/core/mission.routes.ts` (5 handlers + 5 routes)
- Modify: `core/src/mcp-server/tools/mission-query.ts` (4 view tools)
- Modify: `core/src/mcp-server/configure.ts` (4 scopes)
- Test: `core/src/__tests__/mission-view-routes.test.ts`

**Interfaces:**
- Consumes: `newView`/`normalizeView`/`validateView`/`MissionView` (Task 4); `getView`/`listViews`/`putView`/`deleteView`/`MissionViewPort` (Task 5); `filterMissions`/`neighbors`/`subgraphEdges`/`toNode` (Tasks 1–2); `actorFor`/`anchorToLeader`/`listMissions`/`ok`/`fail` (existing in routes).
- Produces: `handleViewSet`/`handleViewList`/`handleViewGet`/`handleViewDelete`/`handleViewGraph`; routes `POST/GET /mission/views`, `GET/DELETE /mission/views/:id`, `GET /mission/views/:id/graph`; 4 view MCP tools.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-view-routes.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { handleViewSet, handleViewList, handleViewGet, handleViewDelete, handleViewGraph } from '../routes/core/mission.routes';
import { newMission, type Mission, type MissionActor } from '../mission/mission-model';
import type { MissionView } from '../mission/mission-views';

const actor: MissionActor = { kind: 'user', channel: 'user', node: 'n', at: 1 };
const mk = (id: string, over: Partial<Mission> = {}): Mission => ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: actor }, 1, () => id), id, ...over });
function missionPort(seed: Mission[]) { const db = new Map(seed.map((m) => [m.id, m])); return { db, get: async (id: string) => db.get(id) ?? null, list: async () => [...db.values()], put: async (m: Mission) => { db.set(m.id, m); } }; }
function viewPort() { const db = new Map<string, MissionView>(); return { db, isEnabled: () => true, get: async (id: string) => db.get(id) ?? null, list: async () => [...db.values()], put: async (v: MissionView) => { db.set(v.id, v); }, del: async (id: string) => { db.delete(id); } }; }

test('view set → get → list → delete', async () => {
  const vp = viewPort();
  const set = await handleViewSet({ name: 'Active', query: { filter: [{ field: 'status', op: 'eq', value: 'active' }] }, display: { layout: 'dag' } }, vp as any, actor);
  const id = (set.data as MissionView).id;
  assert.ok(id.startsWith('view_'));
  assert.equal((set.data as MissionView).createdBy.kind, 'user');
  assert.equal((await handleViewGet(id, vp as any)).success, true);
  assert.deepEqual((((await handleViewList(vp as any)).data) as { views: MissionView[] }).views.map((v) => v.id), [id]);
  await handleViewDelete(id, vp as any);
  assert.equal((await handleViewGet(id, vp as any)).error!.code, 'NOT_FOUND');
});

test('view set rejects an empty name', async () => {
  const r = await handleViewSet({ name: '' }, viewPort() as any, actor);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'INVALID_VIEW');
});

test('view render runs the query → {view, nodes, edges}', async () => {
  const vp = viewPort();
  const mp = missionPort([mk('a', { status: 'active', dependsOn: ['b'] }), mk('b', { status: 'done' })]);
  const set = await handleViewSet({ name: 'G', query: { filter: [{ field: 'status', op: 'eq', value: 'active' }], expand: { direction: 'dependencies', depth: 1 } } }, vp as any, actor);
  const id = (set.data as MissionView).id;
  const r = await handleViewGraph(id, vp as any, mp as any);
  const d = r.data as { view: MissionView; nodes: Array<{ id: string }>; edges: unknown[] };
  assert.equal(d.view.id, id);
  assert.deepEqual(d.nodes.map((n) => n.id).sort(), ['a', 'b']);
  assert.deepEqual(d.edges, [{ from: 'a', to: 'b', type: 'dependsOn' }]);
});
```

- [ ] **Step 2: Run it to confirm RED**

Run: `cd core && npm run build:test 2>&1 | grep mission-view-routes`
Expected: compile error — view handlers not exported.

- [ ] **Step 3: Add the handlers** — in `mission.routes.ts`, add imports:

```ts
import { newView, normalizeView, validateView, type MissionView } from '../../mission/mission-views';
import { getView, listViews, putView, deleteView, type MissionViewPort } from '../../mission/mission-views-store';
```

Add a view id generator near `genId` and the handlers:

```ts
const genViewId = () => 'view_' + randomBytes(4).toString('hex');

export async function handleViewSet(b: Record<string, unknown>, port?: MissionViewPort, actor?: MissionActor, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'POST', '/mission/views', b, true);
  if (anchored) return anchored;
  const who = actor ?? await actorFor(b);
  const id = str(b.id);
  const existing = id ? await getView(id, port) : null;
  const base: MissionView = existing
    ? { ...existing, name: str(b.name) ?? existing.name, query: (b.query as MissionView['query']) ?? existing.query, display: (b.display as MissionView['display']) ?? existing.display, lastUpdatedBy: who }
    : newView({ name: str(b.name) ?? '', query: b.query as MissionView['query'], display: b.display as MissionView['display'], createdBy: who }, Date.now(), genViewId);
  const view = normalizeView(base);
  const v = validateView(view);
  if (!v.ok) return fail('INVALID_VIEW', v.message);
  await putView(view, port);
  return ok(view);
}

export async function handleViewList(port?: MissionViewPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'GET', '/mission/views');
  if (anchored) return anchored;
  return ok({ views: await listViews(port) });
}

export async function handleViewGet(id: string, port?: MissionViewPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'GET', `/mission/views/${encodeURIComponent(id)}`);
  if (anchored) return anchored;
  const view = await getView(id, port);
  return view ? ok(view) : fail('NOT_FOUND', `no view ${id}`);
}

export async function handleViewDelete(id: string, port?: MissionViewPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'POST', `/mission/views/${encodeURIComponent(id)}/delete`, {}, true);
  if (anchored) return anchored;
  await deleteView(id, port);
  return ok({ deleted: id });
}

export async function handleViewGraph(id: string, viewPort?: MissionViewPort, missionPort?: MissionDataPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'GET', `/mission/views/${encodeURIComponent(id)}/graph`);
  if (anchored) return anchored;
  const view = await getView(id, viewPort);
  if (!view) return fail('NOT_FOUND', `no view ${id}`);
  try {
    const all = await listMissions(missionPort);
    const matches = filterMissions(all, view.query?.filter);
    const nodeIds = new Set(matches.map((m) => m.id));
    const exp = view.query?.expand;
    if (exp?.direction) for (const m of matches) for (const n of neighbors(m.id, all, { direction: exp.direction, depth: exp.depth ?? 1 }).neighbors) nodeIds.add(n.id);
    const byId = new Map(all.map((m) => [m.id, m]));
    const nodes = [...nodeIds].map((x) => byId.get(x)).filter(Boolean).map((m) => toNode(m!));
    return ok({ view, nodes, edges: subgraphEdges(nodeIds, all) });
  } catch (e) { if (e instanceof FilterError) return fail(e.code, e.message); throw e; }
}
```

- [ ] **Step 4: Register the routes** — `POST`/`GET /mission/views` are single-segment, so they MUST precede **every** `/mission/:id` pattern (place with the top literal routes, like the query routes in Task 3). The `/mission/views/:id...` suffix routes go before the bare `GET /mission/:id`, and `/mission/views/:id/graph` before `/mission/views/:id`:

```ts
    // literal — with the top literal routes, before any /mission/:id pattern:
    { method: 'POST', pattern: /^\/mission\/views$/, handler: async (req) => handleViewSet((req.body || {}) as Record<string, unknown>, undefined, undefined, realLeaderAnchor()) },
    { method: 'GET', pattern: /^\/mission\/views$/, handler: async () => handleViewList(undefined, realLeaderAnchor()) },
    // suffix — before the bare GET /mission/:id; /graph before /views/:id:
    { method: 'GET', pattern: /^\/mission\/views\/(?<id>[^/]+)\/graph$/, handler: async (req) => handleViewGraph(req.params.id, undefined, undefined, realLeaderAnchor()) },
    { method: 'POST', pattern: /^\/mission\/views\/(?<id>[^/]+)\/delete$/, handler: async (req) => handleViewDelete(req.params.id, undefined, realLeaderAnchor()) },
    { method: 'DELETE', pattern: /^\/mission\/views\/(?<id>[^/]+)$/, handler: async (req) => handleViewDelete(req.params.id, undefined, realLeaderAnchor()) },
    { method: 'GET', pattern: /^\/mission\/views\/(?<id>[^/]+)$/, handler: async (req) => handleViewGet(req.params.id, undefined, realLeaderAnchor()) },
```

(The `POST .../delete` mirror exists because MCP `workerPost` is POST-only, like the existing `POST /mission/:id` mirror of PATCH.)

- [ ] **Step 5: Add the MCP view tools** — first update the `_passthrough` import at the top of `mission-query.ts` to include `workerGet`: `import { ok, err, workerGet, workerPost } from './_passthrough';`. Then append to `MISSION_QUERY_TOOL_DEFS`:

```ts
  { name: 'mission_view_set', description: 'Create or update a saved dashboard view = a query (filter+expand) + display hints (groupBy a tag dimension, highlight, layout tree|dag, nodeFields). Omit id to create. {id?, name, query?, display?}.', inputSchema: obj({ id: S, name: S, query: { type: 'object' as const }, display: { type: 'object' as const } }, ['name']) },
  { name: 'mission_view_list', description: 'List saved dashboard views.', inputSchema: obj({}) },
  { name: 'mission_view_get', description: 'Get one saved dashboard view by id.', inputSchema: obj({ id: S }, ['id']) },
  { name: 'mission_view_delete', description: 'Delete a saved dashboard view by id.', inputSchema: obj({ id: S }, ['id']) },
```

and append to `MISSION_QUERY_HANDLERS`:

```ts
  mission_view_set: async (a) => { try { return pretty(await workerPost('/mission/views', withActorHint(a, currentMcpContext()?.toolUseId))); } catch (e) { return err((e as Error).message); } },
  mission_view_list: async () => { try { return pretty(await workerGet('/mission/views')); } catch (e) { return err((e as Error).message); } },
  mission_view_get: async (a) => { try { const id = String(a.id || ''); if (!id) return err('id is required'); return pretty(await workerGet(`/mission/views/${encodeURIComponent(id)}`)); } catch (e) { return err((e as Error).message); } },
  mission_view_delete: async (a) => { try { const id = String(a.id || ''); if (!id) return err('id is required'); return pretty(await workerPost(`/mission/views/${encodeURIComponent(id)}/delete`, {})); } catch (e) { return err((e as Error).message); } },
```

- [ ] **Step 6: Add scopes** — in `configure.ts`, after the 3 query scopes add:

```ts
  mission_view_set: 'write',
  mission_view_list: 'read',
  mission_view_get: 'read',
  mission_view_delete: 'write',
```

- [ ] **Step 7: Run to confirm GREEN + scope coverage + full mission suite**

Run: `cd core && npm run build:test >/dev/null 2>&1 && node --test --test-reporter=spec dist-test/__tests__/mission-view-routes.test.js && node -e "require('./dist/mcp-server/configure').assertScopesCoverTools(); console.log('SCOPES_OK')"`
Expected: 3 pass; `SCOPES_OK`.

- [ ] **Step 8: Run the whole mission suite to confirm no regressions**

Run: `cd core && npm run build:test >/dev/null 2>&1 && node --test --test-reporter=spec dist-test/__tests__/mission-*.test.js`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add core/src/routes/core/mission.routes.ts core/src/mcp-server/tools/mission-query.ts core/src/mcp-server/configure.ts core/src/__tests__/mission-view-routes.test.ts
git commit -m "feat(mission): mission_view_* tools + routes + GET /mission/views/:id/graph render"
```

---

## Done criteria

- `mission_query`/`mission_neighbors`/`mission_graph` filter + traverse missions (tag dimensions + array ops; parentId/dependsOn directions); `mission_graph` returns `{nodes, edges}` mapping to the web `DagGraph`.
- `mission_view_set/list/get/delete` manage saved views (query + display hints) in the `mission-views` dataset; `GET /mission/views/:id/graph` renders a view → `{view, nodes, edges}`.
- All 7 scopes in `TOOL_SCOPES` (`assertScopesCoverTools()` clean); `./core.sh build` compiles; `node --test dist-test/__tests__/mission-*.test.js` all green.

**Out of scope (sub-project 4):** the web dashboard rendering.
