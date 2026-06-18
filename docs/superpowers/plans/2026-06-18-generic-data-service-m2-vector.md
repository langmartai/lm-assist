# Generic Data Service — M2a: Vector Backend + `data_search` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic `vector` (RAG) `StorageBackend` to the data service — one LanceDB table per dataset, semantic + full-text hybrid search — and expose it through `DataService.search`, a `POST /data/:dataset/search` REST route, and a `data_search` MCP tool.

**Architecture:** A new `VectorBackend implements StorageBackend` persists each `DataRecord` as JSON in a `doc` column of a per-dataset LanceDB table (`ds_<id>`) living in a dedicated store dir (`<dataRoot>/vectors`), isolated from the existing knowledge `lance-store/vectors` table. `vector` + `text` columns power hybrid (vector cosine + full-text) Reciprocal-Rank-Fusion search; `version` + `updatedAt` power export watermarking and Last-Writer-Wins. The embedder is injectable so the entire unit suite stays model-free; the real model is proven in the deploy e2e. The backend slots into the existing `BackendRegistry` and reuses the existing access-key enforcement, redaction, and sync hooks unchanged.

**Tech Stack:** TypeScript (CommonJS), `@lancedb/lancedb@^0.26.2` (loaded via `require`), existing `core/src/vector/embedder.ts` (`getEmbedder()`, 384-dim all-MiniLM-L6-v2 in a worker thread), `node:test` + `node:assert/strict`.

## Global Constraints

- **CommonJS only.** Load LanceDB with `const lancedb = require('@lancedb/lancedb')` (never `import`). The embedder is a normal static `import` from `../../vector/embedder` (it is CJS-safe).
- **Isolation from existing vectors.** Generic datasets use tables named **`ds_<datasetId>`** in **`vectorStoreDir()`** = `path.join(dataRoot(), 'vectors')`. NEVER touch, open, or drop the existing `vectors` table or the `lance-store` dir used by `core/src/vector/vector-store.ts`.
- **Dev/prod + test isolation.** `vectorStoreDir()` derives from `dataRoot()`, which already carries the `-dev` suffix and honors `LM_ASSIST_DATA_DIR`. Tests MUST pass an explicit `storeDir` (a tmp dir) and an injected `embed` fn — never the defaults.
- **Logical key = `record.id`.** Exactly one LanceDB row per record id. Writes upsert via `table.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows)`. No duplicate rows per id, ever.
- **Faithful round-trip.** The full `DataRecord` is stored as `JSON.stringify(record)` in the `doc` column and returned by `JSON.parse(row.doc)`. `vector`/`text`/`version`/`updatedAt` are denormalized copies for search/export only — `doc` is the source of truth.
- **RRF + similarity constants must equal those in `core/src/vector/vector-store.ts`:** `K = 60`, `VEC_WEIGHT = 1.0`, `FTS_WEIGHT = 0.8`, `MIN_SIMILARITY = 0.57`; cosine similarity = `Math.max(0, 1 - distance / 2)`.
- **LWW is the shared `isNewer` from `../types`** (version desc → updatedAt desc → origin.machineId desc). `importBatch` stamps `origin` on every applied record and **re-embeds** its text.
- **The backend never enforces access or redacts.** `DataService` owns `authorize` (the access-key check) and `redactRecord`. The backend is a dumb store. Do not add auth/redaction inside the backend.
- **SQL escaping.** Any value interpolated into a LanceDB `where` clause must escape single quotes: `value.replace(/'/g, "''")`. (Record ids are validated `^[a-z0-9][a-z0-9_-]{0,63}$` at the registry, but escape anyway — defense in depth, matches `vector-store.ts`.)
- **Tests:** `node:test` + `node:assert/strict`, compiled via `tsc -p core/tsconfig.test.json` → `core/dist-test/`, run with `node --test core/dist-test/__tests__/data/<file>.test.js`. Hermetic: tmp `storeDir` + injected fake embedder. No test may load the real model.
- **`expanded.ts` needs no edit** — it already spreads `...DATA_TOOL_DEFS` and `...DATA_HANDLERS`. Adding `data_search` to those arrays flows through automatically. The ONLY hardcoded tool list to update is `core/src/__tests__/data/data-tools.test.ts:17`.

## File Structure

- **Create** `core/src/data/backends/query-filter.ts` — extracted `getField` / `matches` / `applyQuery` (filter+sort+offset+limit), shared by cache + vector backends (kills verbatim duplication).
- **Create** `core/src/data/backends/vector-backend.ts` — `VectorBackend implements StorageBackend`.
- **Create** `core/src/__tests__/data/_fake-embed.ts` — deterministic token-hash embedder for hermetic tests.
- **Create** tests: `core/src/__tests__/data/query-filter.test.ts`, `core/src/__tests__/data/vector-backend.test.ts`.
- **Modify** `core/src/data/paths.ts` — add `vectorStoreDir()`.
- **Modify** `core/src/data/backends/cache-backend.ts` — `query()` delegates to `applyQuery`; drop the now-shared private `getField`/`matches`.
- **Modify** `core/src/data/data-service.ts` — register `VectorBackend`; add `search()`; import `SearchSpec`.
- **Modify** `core/src/routes/core/data.routes.ts` — add `POST /data/:dataset/search`.
- **Modify** `core/src/mcp-server/tools/data-tools.ts` — add `data_search` def + handler.
- **Modify** `core/src/__tests__/data/data-service.test.ts` — add vector search + NOT_SUPPORTED tests.
- **Modify** `core/src/__tests__/data/data-tools.test.ts` — expect 7 tools; add `data_search` NOT_SUPPORTED test.

**Base commit before Task 1:** `aa92162` (HEAD of `feat/generic-data-backends`).

---

### Task 1: Shared `query-filter` helper + `vectorStoreDir()` path

**Files:**
- Create: `core/src/data/backends/query-filter.ts`
- Modify: `core/src/data/backends/cache-backend.ts` (lines 13–32 = the private `getField`/`matches`; lines 76–96 = `query`)
- Modify: `core/src/data/paths.ts:20-22` (add `vectorStoreDir` after `cacheDirFor`)
- Test: `core/src/__tests__/data/query-filter.test.ts`

**Interfaces:**
- Produces: `getField(rec: DataRecord, field: string): unknown`, `matches(rec: DataRecord, f: QueryFilter): boolean`, `applyQuery(rows: DataRecord[], q: QuerySpec): { records: DataRecord[]; total?: number }`, and `vectorStoreDir(): string`. Tasks 2–8 consume all four.

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/data/query-filter.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getField, matches, applyQuery } from '../../data/backends/query-filter';
import type { DataRecord } from '../../data/types';

function rec(id: string, fields: Record<string, unknown>, metadata?: Record<string, unknown>): DataRecord {
  return { id, version: 1, fields, metadata, createdAt: 't', updatedAt: 't' };
}

test('getField: reads fields, then metadata, then top-level', () => {
  const r = rec('a', { x: 1 }, { y: 2 });
  assert.equal(getField(r, 'x'), 1);
  assert.equal(getField(r, 'y'), 2);
  assert.equal(getField(r, 'id'), 'a');
});

test('matches: each operator', () => {
  const r = rec('a', { n: 5, tag: 'hello' });
  assert.equal(matches(r, { field: 'n', op: 'eq', value: 5 }), true);
  assert.equal(matches(r, { field: 'n', op: 'ne', value: 5 }), false);
  assert.equal(matches(r, { field: 'n', op: 'gt', value: 4 }), true);
  assert.equal(matches(r, { field: 'n', op: 'gte', value: 5 }), true);
  assert.equal(matches(r, { field: 'n', op: 'lt', value: 5 }), false);
  assert.equal(matches(r, { field: 'n', op: 'lte', value: 5 }), true);
  assert.equal(matches(r, { field: 'n', op: 'in', value: [4, 5, 6] }), true);
  assert.equal(matches(r, { field: 'tag', op: 'contains', value: 'ell' }), true);
});

test('applyQuery: filter + sort + offset + limit, total is pre-pagination', () => {
  const rows = [rec('a', { n: 3, t: 'x' }), rec('b', { n: 1, t: 'y' }), rec('c', { n: 2, t: 'x' })];
  const r = applyQuery(rows, {
    filter: [{ field: 't', op: 'eq', value: 'x' }],
    sort: [{ field: 'n', dir: 'asc' }],
  });
  assert.deepEqual(r.records.map((x) => x.id), ['c', 'a']); // n=2 before n=3
  assert.equal(r.total, 2);

  const paged = applyQuery(rows, { sort: [{ field: 'n', dir: 'desc' }], offset: 1, limit: 1 });
  assert.deepEqual(paged.records.map((x) => x.id), ['c']); // desc: a(3),c(2),b(1); offset 1 -> c
  assert.equal(paged.total, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/query-filter.test.js`
Expected: FAIL — `Cannot find module '.../data/backends/query-filter'`.

- [ ] **Step 3: Create `core/src/data/backends/query-filter.ts`**

```typescript
// core/src/data/backends/query-filter.ts
// Shared in-memory filter/sort/limit logic for backends that don't push these
// down to a native engine (cache = LMDB range scan; vector = post-fetch over docs).
import type { DataRecord, QuerySpec, QueryFilter } from '../types';

export function getField(rec: DataRecord, field: string): unknown {
  if (rec.fields && field in rec.fields) return rec.fields[field];
  if (rec.metadata && field in rec.metadata) return rec.metadata[field];
  return (rec as unknown as Record<string, unknown>)[field];
}

export function matches(rec: DataRecord, f: QueryFilter): boolean {
  const v = getField(rec, f.field);
  switch (f.op) {
    case 'eq': return v === f.value;
    case 'ne': return v !== f.value;
    case 'gt': return (v as any) > (f.value as any);
    case 'gte': return (v as any) >= (f.value as any);
    case 'lt': return (v as any) < (f.value as any);
    case 'lte': return (v as any) <= (f.value as any);
    case 'in': return Array.isArray(f.value) && (f.value as unknown[]).includes(v);
    case 'contains': return typeof v === 'string' && typeof f.value === 'string' && v.includes(f.value);
    default: return false;
  }
}

/** Apply a QuerySpec's filter + sort + offset/limit to an in-memory row set. `total` is the count after filtering, before pagination. */
export function applyQuery(rows: DataRecord[], q: QuerySpec): { records: DataRecord[]; total?: number } {
  let out = rows;
  if (q.filter?.length) out = out.filter((r) => q.filter!.every((f) => matches(r, f)));
  if (q.sort?.length) {
    const s = q.sort;
    out = out.slice().sort((a, b) => {
      for (const { field, dir } of s) {
        const av = getField(a, field) as any, bv = getField(b, field) as any;
        if (av < bv) return dir === 'asc' ? -1 : 1;
        if (av > bv) return dir === 'asc' ? 1 : -1;
      }
      return 0;
    });
  }
  const total = out.length;
  const offset = q.offset ?? 0;
  const limit = q.limit ?? out.length;
  return { records: out.slice(offset, offset + limit), total };
}
```

- [ ] **Step 4: Refactor `cache-backend.ts` to use the shared helper**

In `core/src/data/backends/cache-backend.ts`:
1. Replace the import block at the top so `QueryFilter` is no longer needed locally and `applyQuery` is imported:

```typescript
import { open, RootDatabase, Database } from 'lmdb';
import * as fs from 'fs';
import * as path from 'path';
import type {
  StorageBackend, BackendKind, DatasetDescriptor, DataRecord, QuerySpec, NodeOrigin,
} from '../types';
import { isNewer } from '../types';
import { applyQuery } from './query-filter';
import { cacheDirFor } from '../paths';
```

2. Delete the now-shared private helpers `getField` (lines ~13–17) and `matches` (lines ~19–32) entirely.
3. Replace the body of `query` with the delegated version:

```typescript
  async query(dataset: string, q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }> {
    const { db } = this.envFor(dataset);
    const rows: DataRecord[] = [];
    for (const { value } of db.getRange()) rows.push(value as DataRecord);
    return applyQuery(rows, q);
  }
```

Leave `put`, `get`, `delete`, `exportSince`, `importBatch`, `createDataset`, `dropDataset` unchanged.

- [ ] **Step 5: Add `vectorStoreDir()` to `paths.ts`**

In `core/src/data/paths.ts`, immediately after `cacheDirFor` (line 22):

```typescript
/** Store dir for the generic vector backend's per-dataset LanceDB tables (ds_<id>).
 *  Separate from the knowledge `lance-store/vectors` table so the two never collide. */
export function vectorStoreDir(): string {
  return path.join(dataRoot(), 'vectors');
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/query-filter.test.js dist-test/__tests__/data/cache-backend.test.js`
Expected: PASS — new query-filter tests green AND the existing cache-backend tests still green (proves the refactor is behavior-preserving).

- [ ] **Step 7: Commit**

```bash
git add core/src/data/backends/query-filter.ts core/src/data/backends/cache-backend.ts core/src/data/paths.ts core/src/__tests__/data/query-filter.test.ts
git commit -m "refactor(data): extract shared query-filter helper; add vectorStoreDir()"
```

---

### Task 2: VectorBackend skeleton — connect, createDataset, dropDataset, fake embedder

**Files:**
- Create: `core/src/data/backends/vector-backend.ts`
- Create: `core/src/__tests__/data/_fake-embed.ts`
- Test: `core/src/__tests__/data/vector-backend.test.ts`

**Interfaces:**
- Consumes: `vectorStoreDir` (Task 1), `getEmbedder`/`VECTOR_DIM` from `../../vector/embedder`, `isNewer` from `../types`, `applyQuery`/`matches` from `./query-filter` (Task 1).
- Produces: `class VectorBackend implements StorageBackend` with `constructor(opts?: { storeDir?: string; embed?: (text: string) => Promise<number[]> })`; `fakeEmbed(text: string): Promise<number[]>` from the test helper. Tasks 3–8 consume both.

- [ ] **Step 1: Create the deterministic test embedder `core/src/__tests__/data/_fake-embed.ts`**

```typescript
// Deterministic, model-free embedder for hermetic tests.
// Hashes whitespace tokens into a 384-dim bag-of-tokens vector, then L2-normalizes.
// Same text -> same vector; texts sharing tokens have higher cosine similarity.
import { VECTOR_DIM } from '../../vector/embedder';

export function fakeEmbed(text: string): Promise<number[]> {
  const v = new Array(VECTOR_DIM).fill(0);
  for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) % VECTOR_DIM;
    v[h] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return Promise.resolve(v.map((x) => x / norm));
}
```

- [ ] **Step 2: Write the failing test**

`core/src/__tests__/data/vector-backend.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { VectorBackend } from '../../data/backends/vector-backend';
import { fakeEmbed } from './_fake-embed';
import type { DatasetDescriptor, DataRecord } from '../../data/types';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'lm-vec-')); }
function be(dir = tmp()): VectorBackend { return new VectorBackend({ storeDir: dir, embed: fakeEmbed }); }
function descriptor(id: string): DatasetDescriptor {
  return { id, backend: 'vector', ownerNode: 'n', visibility: 'local-only',
    config: { kind: 'vector' }, acl: [], createdAt: 't', updatedAt: 't' };
}

test('vector backend: createDataset then dropDataset', async () => {
  const dir = tmp();
  const b = be(dir);
  await b.createDataset(descriptor('d1'));
  // get on an empty (but existing) table returns null, not a throw
  assert.equal(await b.get('d1', 'missing'), null);
  await b.dropDataset('d1');
  // after drop, get returns null (table gone)
  assert.equal(await b.get('d1', 'missing'), null);
});

test('vector backend: two datasets coexist independently', async () => {
  const b = be();
  await b.createDataset(descriptor('alpha'));
  await b.createDataset(descriptor('beta'));
  assert.equal(await b.get('alpha', 'x'), null);
  assert.equal(await b.get('beta', 'x'), null);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/vector-backend.test.js`
Expected: FAIL — `Cannot find module '.../data/backends/vector-backend'`.

- [ ] **Step 4: Create `core/src/data/backends/vector-backend.ts` (skeleton — lifecycle only)**

```typescript
// core/src/data/backends/vector-backend.ts
// Generic vector (RAG) backend. One LanceDB table per dataset (`ds_<id>`) in a
// dedicated store dir, isolated from the knowledge `lance-store/vectors` table.
// The full DataRecord is persisted as JSON in a `doc` column (faithful round-trip);
// `vector`/`text` power semantic + full-text search; `version`/`updatedAt` power
// export watermarking and LWW. Embedding is injectable for hermetic tests.
import * as fs from 'fs';
import type {
  StorageBackend, BackendKind, DatasetDescriptor, DataRecord, QuerySpec, SearchSpec, NodeOrigin,
} from '../types';
import { isNewer } from '../types';
import { applyQuery, matches } from './query-filter';
import { getEmbedder, VECTOR_DIM } from '../../vector/embedder';
import { vectorStoreDir } from '../paths';

const lancedb = require('@lancedb/lancedb');

// RRF + similarity constants — kept identical to core/src/vector/vector-store.ts.
const RRF_K = 60;
const VEC_WEIGHT = 1.0;
const FTS_WEIGHT = 0.8;
const MIN_SIMILARITY = 0.57;

interface LanceDoc {
  id: string;
  vector: number[];
  text: string;
  doc: string;       // JSON.stringify(DataRecord) — source of truth
  version: number;
  updatedAt: string;
}

function tableName(datasetId: string): string { return `ds_${datasetId}`; }
function esc(v: string): string { return v.replace(/'/g, "''"); }

/** Text we embed + FTS-index: the record's text, else its string fields, else its id. */
function embedText(rec: DataRecord): string {
  if (rec.text && rec.text.trim()) return rec.text;
  const parts = Object.values(rec.fields || {}).filter((v): v is string => typeof v === 'string');
  const joined = parts.join(' ').trim();
  return joined || rec.id;
}

export class VectorBackend implements StorageBackend {
  readonly kind: BackendKind = 'vector';
  private storeDir: string;
  private embedFn: (text: string) => Promise<number[]>;
  private dbPromise: Promise<any> | null = null;
  private tables = new Map<string, any>();
  private ftsDirty = new Set<string>();

  constructor(opts?: { storeDir?: string; embed?: (text: string) => Promise<number[]> }) {
    this.storeDir = opts?.storeDir || vectorStoreDir();
    this.embedFn = opts?.embed || ((t: string) => getEmbedder().embed(t));
    if (!fs.existsSync(this.storeDir)) fs.mkdirSync(this.storeDir, { recursive: true });
  }

  private db(): Promise<any> {
    if (!this.dbPromise) this.dbPromise = lancedb.connect(this.storeDir);
    return this.dbPromise;
  }

  /** Open the dataset's table, or null if it doesn't exist yet. */
  private async openOrNull(datasetId: string): Promise<any | null> {
    const cached = this.tables.get(datasetId);
    if (cached) return cached;
    const db = await this.db();
    const names: string[] = await db.tableNames();
    if (!names.includes(tableName(datasetId))) return null;
    const t = await db.openTable(tableName(datasetId));
    this.tables.set(datasetId, t);
    return t;
  }

  /** Open the dataset's table, creating it (seed-then-delete for schema inference) if absent. */
  private async tableFor(datasetId: string): Promise<any> {
    const existing = await this.openOrNull(datasetId);
    if (existing) return existing;
    const db = await this.db();
    const seed: LanceDoc = {
      id: '__seed__', vector: new Array(VECTOR_DIM).fill(0), text: '', doc: '', version: 0, updatedAt: '',
    };
    const t = await db.createTable(tableName(datasetId), [seed]);
    try { await t.delete("id = '__seed__'"); } catch { /* best effort */ }
    this.tables.set(datasetId, t);
    return t;
  }

  async createDataset(d: DatasetDescriptor): Promise<void> { await this.tableFor(d.id); }

  async dropDataset(id: string): Promise<void> {
    const db = await this.db();
    try { await db.dropTable(tableName(id)); } catch { /* best effort */ }
    this.tables.delete(id);
    this.ftsDirty.delete(id);
  }

  async get(dataset: string, id: string): Promise<DataRecord | null> {
    const table = await this.openOrNull(dataset);
    if (!table) return null;
    const rows = await table.query().where(`id = '${esc(id)}'`).select(['doc']).toArray();
    if (!rows.length) return null;
    return JSON.parse(rows[0].doc) as DataRecord;
  }

  // put/query/delete added in Task 3; search in Task 5; exportSince/importBatch in Task 6.
  async put(_dataset: string, _record: DataRecord): Promise<{ id: string }> { throw new Error('not implemented'); }
  async query(_dataset: string, _q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }> { throw new Error('not implemented'); }
  async delete(_dataset: string, _id: string): Promise<boolean> { throw new Error('not implemented'); }
  async exportSince(_dataset: string, _since?: string): Promise<DataRecord[]> { throw new Error('not implemented'); }
  async importBatch(_dataset: string, _records: DataRecord[], _origin: NodeOrigin): Promise<{ applied: number; skipped: number }> { throw new Error('not implemented'); }
}
```

> NOTE TO IMPLEMENTER: the `throw new Error('not implemented')` stubs exist ONLY so the class satisfies `StorageBackend` and this task's lifecycle tests compile and pass. Tasks 3, 5, and 6 replace each stub with a real body. Do not leave any stub after Task 6. (`search` is optional on the interface, so it is added fresh in Task 5, not stubbed here.) Keep the unused-param underscore names so tsc's `noUnusedParameters`, if on, stays quiet.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/vector-backend.test.js`
Expected: PASS — both lifecycle tests green (LanceDB table created in the tmp dir, dropped, coexistence holds).

- [ ] **Step 6: Commit**

```bash
git add core/src/data/backends/vector-backend.ts core/src/__tests__/data/_fake-embed.ts core/src/__tests__/data/vector-backend.test.ts
git commit -m "feat(data): VectorBackend skeleton — LanceDB per-dataset table lifecycle + fake embedder"
```

---

### Task 3: put / get / delete with `mergeInsert` upsert + doc round-trip

**Files:**
- Modify: `core/src/data/backends/vector-backend.ts` (replace the `put` and `delete` stubs; add a private `row` + `upsert`)
- Test: `core/src/__tests__/data/vector-backend.test.ts` (add cases)

**Interfaces:**
- Produces: working `put(dataset, record) -> { id }`, `delete(dataset, id) -> boolean`. `get` already works from Task 2.

- [ ] **Step 1: Write the failing test (append to `vector-backend.test.ts`)**

```typescript
test('vector backend: put/get round-trip preserves the full record', async () => {
  const b = be();
  await b.createDataset(descriptor('rt'));
  const rec: DataRecord = {
    id: 'r1', version: 3, fields: { title: 'Hello', n: 42 }, text: 'hello world',
    metadata: { src: 'unit' }, createdAt: 'c', updatedAt: 'u',
  };
  await b.put('rt', rec);
  const got = await b.get('rt', 'r1');
  assert.deepEqual(got, rec); // doc column is the faithful source of truth
});

test('vector backend: re-put same id upserts (no duplicate rows)', async () => {
  const b = be();
  await b.createDataset(descriptor('up'));
  await b.put('up', { id: 'r1', version: 1, fields: { v: 'first' }, text: 'first', createdAt: 'c', updatedAt: 'u1' });
  await b.put('up', { id: 'r1', version: 2, fields: { v: 'second' }, text: 'second', createdAt: 'c', updatedAt: 'u2' });
  const got = await b.get('up', 'r1');
  assert.equal(got?.fields.v, 'second');
  assert.equal(got?.version, 2);
});

test('vector backend: delete removes the record', async () => {
  const b = be();
  await b.createDataset(descriptor('del'));
  await b.put('del', { id: 'r1', version: 1, fields: {}, text: 't', createdAt: 'c', updatedAt: 'u' });
  assert.equal(await b.delete('del', 'r1'), true);
  assert.equal(await b.get('del', 'r1'), null);
  assert.equal(await b.delete('del', 'r1'), false); // already gone
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/vector-backend.test.js`
Expected: FAIL — the new tests hit `throw new Error('not implemented')` for `put`.

- [ ] **Step 3: Implement `put`, `delete`, and the private `row`/`upsert` helpers**

In `vector-backend.ts`, add these two private methods (place them above `get`):

```typescript
  private async row(rec: DataRecord): Promise<LanceDoc> {
    const text = embedText(rec);
    const vector = await this.embedFn(text);
    return { id: rec.id, vector, text, doc: JSON.stringify(rec), version: rec.version ?? 0, updatedAt: rec.updatedAt };
  }

  private async upsert(table: any, rows: LanceDoc[]): Promise<void> {
    await table.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
  }
```

Replace the `put` stub:

```typescript
  async put(dataset: string, record: DataRecord): Promise<{ id: string }> {
    const table = await this.tableFor(dataset);
    await this.upsert(table, [await this.row(record)]);
    this.ftsDirty.add(dataset);
    return { id: record.id };
  }
```

Replace the `delete` stub:

```typescript
  async delete(dataset: string, id: string): Promise<boolean> {
    const table = await this.openOrNull(dataset);
    if (!table) return false;
    if (!(await this.get(dataset, id))) return false;
    await table.delete(`id = '${esc(id)}'`);
    this.ftsDirty.add(dataset);
    return true;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/vector-backend.test.js`
Expected: PASS — round-trip, upsert (no dup), and delete tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/data/backends/vector-backend.ts core/src/__tests__/data/vector-backend.test.ts
git commit -m "feat(data): VectorBackend put/get/delete with mergeInsert upsert + faithful doc round-trip"
```

---

### Task 4: query (in-memory filter/sort/limit over docs)

**Files:**
- Modify: `core/src/data/backends/vector-backend.ts` (replace the `query` stub)
- Test: `core/src/__tests__/data/vector-backend.test.ts` (add cases)

**Interfaces:**
- Produces: working `query(dataset, q) -> { records, total }`, behaviorally identical to `CacheBackend.query` (both delegate to `applyQuery`).

- [ ] **Step 1: Write the failing test (append)**

```typescript
test('vector backend: query filter + sort + limit', async () => {
  const b = be();
  await b.createDataset(descriptor('q'));
  await b.put('q', { id: 'a', version: 1, fields: { tag: 'x', n: 1 }, text: 'a', createdAt: 'c', updatedAt: 'u' });
  await b.put('q', { id: 'b', version: 1, fields: { tag: 'y', n: 2 }, text: 'b', createdAt: 'c', updatedAt: 'u' });
  await b.put('q', { id: 'c', version: 1, fields: { tag: 'x', n: 3 }, text: 'c', createdAt: 'c', updatedAt: 'u' });
  const filtered = await b.query('q', { filter: [{ field: 'tag', op: 'eq', value: 'x' }] });
  assert.deepEqual(filtered.records.map((r) => r.id).sort(), ['a', 'c']);
  assert.equal(filtered.total, 2);
  const limited = await b.query('q', { sort: [{ field: 'n', dir: 'desc' }], limit: 1 });
  assert.deepEqual(limited.records.map((r) => r.id), ['c']);
  assert.equal(limited.total, 3);
});

test('vector backend: query on a never-created dataset returns empty', async () => {
  const b = be();
  const r = await b.query('nope', {});
  assert.deepEqual(r.records, []);
  assert.equal(r.total, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/vector-backend.test.js`
Expected: FAIL — `query` hits `throw new Error('not implemented')`.

- [ ] **Step 3: Implement `query`**

Replace the `query` stub:

```typescript
  async query(dataset: string, q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }> {
    const table = await this.openOrNull(dataset);
    if (!table) return { records: [], total: 0 };
    const rows = await table.query().select(['doc']).toArray();
    const records = rows.map((r: any) => JSON.parse(r.doc) as DataRecord);
    return applyQuery(records, q);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/vector-backend.test.js`
Expected: PASS — filter/sort/limit + empty-dataset tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/data/backends/vector-backend.ts core/src/__tests__/data/vector-backend.test.ts
git commit -m "feat(data): VectorBackend query via shared applyQuery over stored docs"
```

---

### Task 5: search (hybrid vector + FTS, RRF merge, lazy FTS rebuild)

**Files:**
- Modify: `core/src/data/backends/vector-backend.ts` (add `search` + private `ensureFts`)
- Test: `core/src/__tests__/data/vector-backend.test.ts` (add cases)

**Interfaces:**
- Produces: `search(dataset, s: SearchSpec) -> Array<DataRecord & { score: number }>`. `DataService.search` (Task 7) consumes it.

**Note on the FTS index lifecycle (read before implementing):** LanceDB FTS indexes do NOT auto-update when rows are added — they must be rebuilt with `replace: true`. We therefore mark a dataset's FTS as "dirty" on every write (`put`/`importBatch`/`delete`, already done) and rebuild it lazily on the next `search`. Rebuilding on an empty table throws — we catch and fall back to vector-only. The query vector path always runs; FTS is best-effort. This matches `vector-store.ts`'s `ensureFtsIndex` (fire-and-forget, errors swallowed).

- [ ] **Step 1: Write the failing test (append)**

```typescript
test('vector backend: hybrid search ranks token-overlapping records above unrelated ones', async () => {
  const b = be();
  await b.createDataset(descriptor('s'));
  // SHORT texts (<=3 distinct tokens) on purpose: the token-bag fakeEmbed L2-normalizes,
  // so a single-token query ("fruit") vs a k-token doc has cosine ~= 1/sqrt(k). With k<=3
  // that is >= 0.577 > MIN_SIMILARITY (0.57), so the relevant docs survive the VECTOR path
  // (and FTS also matches them) — the test exercises BOTH RRF inputs, not FTS alone. Longer
  // texts would dilute the cosine below the cutoff and make the test FTS-only and fragile.
  await b.put('s', { id: 'fruit1', version: 1, fields: {}, text: 'fresh fruit', createdAt: 'c', updatedAt: 'u' });
  await b.put('s', { id: 'fruit2', version: 1, fields: {}, text: 'fruit salad', createdAt: 'c', updatedAt: 'u' });
  await b.put('s', { id: 'cat', version: 1, fields: {}, text: 'sleepy cat', createdAt: 'c', updatedAt: 'u' });

  const results = await b.search('s', { query: 'fruit', limit: 3 });
  const ids = results.map((r) => r.id);
  assert.ok(ids[0] === 'fruit1' || ids[0] === 'fruit2', `expected a fruit record first, got ${ids[0]}`);
  // the unrelated 'cat' record must not outrank the fruit records
  assert.ok(ids.indexOf('cat') === -1 || ids.indexOf('cat') > 1, `cat ranked too high: ${ids}`);
  // scores are attached and descending
  assert.equal(typeof results[0].score, 'number');
  for (let i = 1; i < results.length; i++) assert.ok(results[i - 1].score >= results[i].score);
});

test('vector backend: search honors filter and limit', async () => {
  const b = be();
  await b.createDataset(descriptor('sf'));
  await b.put('sf', { id: 'a', version: 1, fields: { kind: 'doc' }, text: 'shared topic alpha', createdAt: 'c', updatedAt: 'u' });
  await b.put('sf', { id: 'b', version: 1, fields: { kind: 'note' }, text: 'shared topic beta', createdAt: 'c', updatedAt: 'u' });
  const filtered = await b.search('sf', { query: 'shared topic', filter: [{ field: 'kind', op: 'eq', value: 'doc' }], limit: 10 });
  assert.deepEqual(filtered.map((r) => r.id), ['a']); // only kind=doc survives the post-filter
  const capped = await b.search('sf', { query: 'shared topic', limit: 1 });
  assert.equal(capped.length, 1);
});

test('vector backend: search on empty/missing dataset returns []', async () => {
  const b = be();
  assert.deepEqual(await b.search('ghost', { query: 'anything' }), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/vector-backend.test.js`
Expected: FAIL — `search` is not defined on `VectorBackend` (TypeScript error: property 'search' does not exist).

- [ ] **Step 3: Implement `ensureFts` + `search`**

Add the private `ensureFts` (place it above `search`):

```typescript
  /** Rebuild the FTS index if writes have happened since the last build. Returns false if FTS is unavailable (e.g. empty table). */
  private async ensureFts(dataset: string, table: any): Promise<boolean> {
    if (!this.ftsDirty.has(dataset)) return true;
    try {
      await table.createIndex('text', { config: lancedb.Index.fts({ withPosition: true }), replace: true });
      this.ftsDirty.delete(dataset);
      return true;
    } catch {
      return false; // empty table or transient — fall back to vector-only
    }
  }
```

Add the `search` method (this is a NEW method — the interface declares `search?` optional, so it was not stubbed in Task 2):

```typescript
  async search(dataset: string, s: SearchSpec): Promise<Array<DataRecord & { score: number }>> {
    const table = await this.openOrNull(dataset);
    if (!table) return [];
    const limit = s.limit ?? 20;
    const fetchCount = limit * 3; // over-fetch for dedup + post-filter
    const queryVector = await this.embedFn(s.query);
    const ftsOk = await this.ensureFts(dataset, table);

    const vecPromise: Promise<any[]> = table.search(queryVector).limit(fetchCount).toArray();
    const ftsPromise: Promise<any[]> = ftsOk
      ? table.query().fullTextSearch(s.query, { columns: ['text'] }).limit(fetchCount).toArray().catch(() => [])
      : Promise.resolve([]);
    const [vecRows, ftsRows] = await Promise.all([vecPromise, ftsPromise]);

    // id -> best vector similarity (drop low-similarity noise)
    const vec = new Map<string, { row: any; sim: number }>();
    for (const r of vecRows) {
      const sim = Math.max(0, 1 - (r._distance ?? 0) / 2);
      if (sim < MIN_SIMILARITY) continue;
      const cur = vec.get(r.id);
      if (!cur || sim > cur.sim) vec.set(r.id, { row: r, sim });
    }
    // id -> best FTS score
    const fts = new Map<string, { row: any; score: number }>();
    for (const r of ftsRows) {
      const score = r._score ?? 0;
      const cur = fts.get(r.id);
      if (!cur || score > cur.score) fts.set(r.id, { row: r, score });
    }

    // 1-indexed rank maps
    const vecRanked = [...vec.entries()].sort((a, b) => b[1].sim - a[1].sim);
    const ftsRanked = [...fts.entries()].sort((a, b) => b[1].score - a[1].score);
    const vecRank = new Map<string, number>(); vecRanked.forEach(([id], i) => vecRank.set(id, i + 1));
    const ftsRank = new Map<string, number>(); ftsRanked.forEach(([id], i) => ftsRank.set(id, i + 1));

    const ids = new Set<string>([...vecRank.keys(), ...ftsRank.keys()]);
    let merged: Array<DataRecord & { score: number }> = [];
    for (const id of ids) {
      let rrf = 0;
      const vr = vecRank.get(id); if (vr !== undefined) rrf += VEC_WEIGHT / (RRF_K + vr);
      const fr = ftsRank.get(id); if (fr !== undefined) rrf += FTS_WEIGHT / (RRF_K + fr);
      const row = vec.get(id)?.row ?? fts.get(id)?.row;
      merged.push({ ...(JSON.parse(row.doc) as DataRecord), score: rrf });
    }

    if (s.filter?.length) merged = merged.filter((rec) => s.filter!.every((f) => matches(rec, f)));
    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, limit);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/vector-backend.test.js`
Expected: PASS — ranking, filter+limit, and empty-dataset search tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/data/backends/vector-backend.ts core/src/__tests__/data/vector-backend.test.ts
git commit -m "feat(data): VectorBackend hybrid vector+FTS RRF search with lazy FTS rebuild"
```

---

### Task 6: exportSince + importBatch (LWW, re-embed, stamp origin)

**Files:**
- Modify: `core/src/data/backends/vector-backend.ts` (replace `exportSince` + `importBatch` stubs)
- Test: `core/src/__tests__/data/vector-backend.test.ts` (add cases)

**Interfaces:**
- Produces: working `exportSince(dataset, since?)` (ascending by `updatedAt`, watermark-filtered) and `importBatch(dataset, records, origin)` (LWW via `isNewer`, re-embeds, stamps origin, returns `{ applied, skipped }`). The SyncEngine + DataService consume these unchanged from M5.

- [ ] **Step 1: Write the failing test (append)**

Add this import at the TOP of `vector-backend.test.ts` (with the other imports), then append the tests below:

```typescript
import type { NodeOrigin } from '../../data/types';
```

```typescript
const ORIGIN: NodeOrigin = { machineId: 'remote1', hostname: 'r1', os: 'linux' };

test('vector backend: exportSince filters by watermark, ascending', async () => {
  const b = be();
  await b.createDataset(descriptor('ex'));
  await b.put('ex', { id: 'a', version: 1, fields: {}, text: 'a', createdAt: 'c', updatedAt: '2026-01-01T00:00:00Z' });
  await b.put('ex', { id: 'b', version: 1, fields: {}, text: 'b', createdAt: 'c', updatedAt: '2026-02-01T00:00:00Z' });
  const all = await b.exportSince('ex');
  assert.deepEqual(all.map((r) => r.id), ['a', 'b']); // ascending by updatedAt
  const since = await b.exportSince('ex', '2026-01-15T00:00:00Z');
  assert.deepEqual(since.map((r) => r.id), ['b']);
});

test('vector backend: importBatch applies newer, skips older (LWW), stamps origin', async () => {
  const b = be();
  await b.createDataset(descriptor('im'));
  await b.put('im', { id: 'a', version: 2, fields: { v: 'local' }, text: 'local', createdAt: 'c', updatedAt: 'u2' });

  // incoming v1 (older) is skipped; incoming v3 (newer) is applied
  const res = await b.importBatch('im', [
    { id: 'a', version: 1, fields: { v: 'old' }, text: 'old', createdAt: 'c', updatedAt: 'u1' },
    { id: 'z', version: 3, fields: { v: 'new' }, text: 'searchable new content', createdAt: 'c', updatedAt: 'u3' },
  ], ORIGIN);
  assert.equal(res.applied, 1);
  assert.equal(res.skipped, 1);

  const a = await b.get('im', 'a');
  assert.equal(a?.fields.v, 'local'); // local v2 preserved over incoming v1

  const z = await b.get('im', 'z');
  assert.equal(z?.fields.v, 'new');
  assert.deepEqual(z?.origin, ORIGIN); // origin stamped on the replica

  // re-embedded on import -> findable by search
  const found = await b.search('im', { query: 'searchable new content', limit: 5 });
  assert.ok(found.some((r) => r.id === 'z'));
});

test('vector backend: importBatch upserts (no duplicate rows)', async () => {
  const b = be();
  await b.createDataset(descriptor('iu'));
  await b.importBatch('iu', [{ id: 'a', version: 1, fields: { v: '1' }, text: 't', createdAt: 'c', updatedAt: 'u1' }], ORIGIN);
  await b.importBatch('iu', [{ id: 'a', version: 2, fields: { v: '2' }, text: 't', createdAt: 'c', updatedAt: 'u2' }], ORIGIN);
  const got = await b.get('iu', 'a');
  assert.equal(got?.version, 2);
  const all = await b.query('iu', {});
  assert.equal(all.records.filter((r) => r.id === 'a').length, 1); // single row
});
```

> LWW ordering (`isNewer`) is exercised through `importBatch` — the test asserts the applied/skipped outcome, not the function directly, so it is not imported here.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/vector-backend.test.js`
Expected: FAIL — `exportSince`/`importBatch` hit `throw new Error('not implemented')`.

- [ ] **Step 3: Implement `exportSince` + `importBatch`**

Replace the `exportSince` stub:

```typescript
  async exportSince(dataset: string, since?: string): Promise<DataRecord[]> {
    const table = await this.openOrNull(dataset);
    if (!table) return [];
    const rows = await table.query().select(['doc', 'updatedAt']).toArray();
    const recs: DataRecord[] = [];
    for (const r of rows) {
      if (!since || r.updatedAt >= since) recs.push(JSON.parse(r.doc) as DataRecord);
    }
    recs.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
    return recs;
  }
```

Replace the `importBatch` stub:

```typescript
  async importBatch(dataset: string, records: DataRecord[], origin: NodeOrigin): Promise<{ applied: number; skipped: number }> {
    const table = await this.tableFor(dataset);
    let applied = 0, skipped = 0;
    const toWrite: LanceDoc[] = [];
    for (const incoming of records) {
      const local = await this.get(dataset, incoming.id);
      const stamped: DataRecord = { ...incoming, origin };
      if (isNewer(stamped, local)) { toWrite.push(await this.row(stamped)); applied++; }
      else skipped++;
    }
    if (toWrite.length) { await this.upsert(table, toWrite); this.ftsDirty.add(dataset); }
    return { applied, skipped };
  }
```

- [ ] **Step 4: Run the full VectorBackend + cache + query-filter suite**

Run: `cd core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/vector-backend.test.js dist-test/__tests__/data/cache-backend.test.js dist-test/__tests__/data/query-filter.test.js`
Expected: PASS — all green. The VectorBackend now fully implements `StorageBackend` with no remaining `not implemented` stubs.

- [ ] **Step 5: Commit**

```bash
git add core/src/data/backends/vector-backend.ts core/src/__tests__/data/vector-backend.test.ts
git commit -m "feat(data): VectorBackend exportSince + importBatch (LWW, re-embed, origin stamp)"
```

---

### Task 7: Register VectorBackend + `DataService.search`

**Files:**
- Modify: `core/src/data/data-service.ts` (import `SearchSpec`; register `VectorBackend`; add `search` method)
- Test: `core/src/__tests__/data/data-service.test.ts` (add cases + extend the `service()` helper)

**Interfaces:**
- Consumes: `VectorBackend` (Tasks 2–6), `SearchSpec` from `./types`.
- Produces: `DataService.search(ctx: CallCtx, datasetId: string, spec: SearchSpec): Promise<DataResult<Array<DataRecord & { score: number }>>>`. The REST route + MCP tool (Task 8) consume it.

- [ ] **Step 1: Write the failing test**

In `core/src/__tests__/data/data-service.test.ts`, add imports at the top (after the existing imports):

```typescript
import { VectorBackend } from '../../data/backends/vector-backend';
import { fakeEmbed } from './_fake-embed';
```

Add a second service factory + tests (append to the file):

```typescript
function serviceWithVector() {
  const datasets = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ds-reg-')), 'd.json'));
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ds-keys-')));
  const backends = new BackendRegistry();
  backends.register(new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ds-cache-'))));
  backends.register(new VectorBackend({ storeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ds-vec-')), embed: fakeEmbed }));
  const manager = new AccessManager({ datasets, keys, nodeId: 'n1' });
  const svc = new DataService({ datasets, backends, manager });
  (svc as any).enabledOverride = true;
  return { svc, datasets };
}

test('data service: search on a vector dataset returns redacted scored records', async () => {
  const { svc, datasets } = serviceWithVector();
  datasets.create({ id: 'v', backend: 'vector', visibility: 'local-only', config: { kind: 'vector' }, acl: [] });
  const local = { principal: { type: 'local' as const } };
  await svc.put(local, 'v', { id: 'r1', version: 0, fields: { title: 'secret topic', apiKey: 'sk-leak' }, text: 'secret topic about widgets', createdAt: 't', updatedAt: 't' });
  const r = await svc.search(local, 'v', { query: 'widgets topic', limit: 5 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.value.length >= 1);
  assert.equal(r.value[0].id, 'r1');
  assert.equal(typeof r.value[0].score, 'number');
  assert.equal(r.value[0].fields.apiKey, REDACTED); // redaction applies to search results too
});

test('data service: search on a non-search backend (cache) returns NOT_SUPPORTED', async () => {
  const { svc, datasets } = serviceWithVector();
  datasets.create({ id: 'c', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [] });
  const r = await svc.search({ principal: { type: 'local' } }, 'c', { query: 'x' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'NOT_SUPPORTED');
});

test('data service: cloud without key cannot search (auth before backend check)', async () => {
  const { svc, datasets } = serviceWithVector();
  datasets.create({ id: 'v2', backend: 'vector', visibility: 'cross-node-readable',
    config: { kind: 'vector' }, acl: [{ principal: 'cloud', actions: ['search'] }] });
  const denied = await svc.search({ principal: { type: 'cloud', userId: 'u' } }, 'v2', { query: 'x' });
  assert.equal(denied.ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/data-service.test.js`
Expected: FAIL — `svc.search` is not a function / property 'search' does not exist on `DataService`.

- [ ] **Step 3: Register the backend + add `DataService.search`**

In `core/src/data/data-service.ts`:

1. Add `SearchSpec` to the type import from `./types`:

```typescript
import type {
  Principal, DataAction, DataRecord, QuerySpec, SearchSpec, AccessRequest, BackendKind, NodeVisibility, SyncMode,
  PeerClient, NodeInfo,
} from './types';
```

2. Add the VectorBackend import near the `CacheBackend` import:

```typescript
import { VectorBackend } from './backends/vector-backend';
```

3. In `getDataService()`, register it right after the cache backend:

```typescript
    backends.register(new CacheBackend());
    backends.register(new VectorBackend());
```

4. Add the `search` method (place it right after `query`, before `put`):

```typescript
  async search(ctx: CallCtx, datasetId: string, spec: SearchSpec): Promise<DataResult<Array<DataRecord & { score: number }>>> {
    const a = await this.authorize(ctx, datasetId, 'search');
    if (!a.ok) return a;
    const backend = a.value.backend!;
    if (!backend.search) return { ok: false, code: 'NOT_SUPPORTED', reason: `backend "${backend.kind}" does not support search` };
    const results = await backend.search(datasetId, spec);
    return { ok: true, value: results.map((r) => ({ ...redactRecord(r), score: r.score })) };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/data-service.test.js`
Expected: PASS — vector search returns redacted scored records; cache → NOT_SUPPORTED; cloud-no-key denied.

- [ ] **Step 5: Commit**

```bash
git add core/src/data/data-service.ts core/src/__tests__/data/data-service.test.ts
git commit -m "feat(data): register VectorBackend; add DataService.search (authz + redact + NOT_SUPPORTED)"
```

> Only `.ts` sources are committed — compiled tests live under the gitignored `core/dist-test/` and are never added.

---

### Task 8: REST `POST /data/:dataset/search` + `data_search` MCP tool

**Files:**
- Modify: `core/src/routes/core/data.routes.ts` (add the search route after the `/query` route, ~line 133)
- Modify: `core/src/mcp-server/tools/data-tools.ts` (add `data_search` handler + def + handler-map entry)
- Modify: `core/src/__tests__/data/data-tools.test.ts` (expect 7 tools; add a `data_search` NOT_SUPPORTED case)
- Test: `core/src/__tests__/data/data-routes.test.ts` (add a search-route case if the file's harness supports it; otherwise rely on data-tools + data-service coverage — see Step 1)

**Interfaces:**
- Consumes: `DataService.search` (Task 7).
- Produces: `POST /data/:dataset/search` returning `{ results: Array<DataRecord & { score }> }`; MCP tool `data_search`.

- [ ] **Step 1: Write the failing test**

First, update the tool-count assertion in `core/src/__tests__/data/data-tools.test.ts` (line ~15-19) to include `data_search`:

```typescript
test('data tools: the 7 expected tools are defined and mapped', () => {
  const names = DATA_TOOL_DEFS.map((d) => d.name).sort();
  assert.deepEqual(names, ['data_catalog', 'data_delete', 'data_get', 'data_put', 'data_query', 'data_request_access', 'data_search']);
  for (const n of names) assert.equal(typeof DATA_HANDLERS[n], 'function');
});
```

Then append a behavior test (uses a cache dataset so no embedder/model is touched — proves the tool plumbs the service error through; the positive vector path is covered by Task 5 + Task 7 + the live e2e):

```typescript
test('data tools: data_search on a non-search (cache) dataset returns NOT_SUPPORTED', async () => {
  enable();
  const id = `ds_search_${Date.now()}`;
  getDatasetRegistry().create({ id, backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [] });
  const r = await runWithMcpContext({ principal: { type: 'local' } }, () =>
    DATA_HANDLERS.data_search({ dataset: id, query: 'anything' }));
  assert.equal(r.isError, true);
  assert.match(textOf(r), /NOT_SUPPORTED/);
});

test('data tools: data_search requires dataset and query', async () => {
  enable();
  const missing = await runWithMcpContext({ principal: { type: 'local' } }, () =>
    DATA_HANDLERS.data_search({ dataset: 'x' }));
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /query is required/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/data-tools.test.js`
Expected: FAIL — `DATA_HANDLERS.data_search` is undefined; the 7-tool `deepEqual` fails.

- [ ] **Step 3: Add the `data_search` MCP handler + def**

In `core/src/mcp-server/tools/data-tools.ts`:

1. Add `SearchSpec` to the types import:

```typescript
import type { DataRecord, QuerySpec, SearchSpec, AccessRequest } from '../../data/types';
```

2. Add the handler (place after `handleDataQuery`):

```typescript
async function handleDataSearch(args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = ctxFromArgs(args);
  if ('error' in ctx) return err(ctx.error);
  const svc = getDataService();
  if (!svc.isEnabled()) return err('data service is disabled');
  const dataset = String(args.dataset || '');
  if (!dataset) return err('dataset is required');
  const query = typeof args.query === 'string' ? args.query : '';
  if (!query) return err('query is required');
  const spec: SearchSpec = {
    query,
    limit: typeof args.limit === 'number' ? args.limit : undefined,
    filter: Array.isArray(args.filter) ? (args.filter as SearchSpec['filter']) : undefined,
  };
  const r = await svc.search(ctx, dataset, spec);
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  return ok(pretty(r.value));
}
```

3. Add the tool def to `DATA_TOOL_DEFS` (after the `data_query` entry):

```typescript
  {
    name: 'data_search',
    description: 'Semantic + full-text hybrid search over a vector-backed dataset. Returns the best-matching records (redacted) each with a relevance `score`, ranked high to low. Only datasets whose backend is `vector` support this; others return NOT_SUPPORTED. Pass `key` if you have one.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        dataset: STR('Dataset id (must be a vector-backed dataset).'),
        query: STR('Natural-language search query.'),
        limit: { type: 'number' as const, description: 'Max results to return (default 20).' },
        filter: { type: 'array' as const, description: 'Optional QueryFilter[] applied to results: [{ field, op, value }].', items: { type: 'object' as const } },
        key: STR('Access key granting search/read (omit if local).'),
      },
      required: ['dataset', 'query'],
    },
  },
```

4. Add the handler-map entry to `DATA_HANDLERS`:

```typescript
  data_search: handleDataSearch,
```

- [ ] **Step 4: Add the REST route**

In `core/src/routes/core/data.routes.ts`, add immediately after the `POST /data/:dataset/query` route (after line ~133):

```typescript
    // POST /data/:dataset/search — hybrid semantic + FTS search (vector backends only)
    {
      method: 'POST',
      pattern: /^\/data\/(?<dataset>[^/]+)\/search$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const b = req.body || {};
        const query = typeof b.query === 'string' ? b.query : '';
        if (!query) return wrapError('BAD_REQUEST', 'query is required', start);
        const spec = {
          query,
          limit: typeof b.limit === 'number' ? b.limit : undefined,
          filter: Array.isArray(b.filter) ? b.filter : undefined,
        };
        const r = await svc().search(ctxOf(req), req.params.dataset, spec);
        if (!r.ok) return wrapError(r.code, r.reason, start);
        return wrapResponse({ results: r.value }, start);
      },
    },
```

- [ ] **Step 5: Run the full data suite to verify everything passes**

Run: `cd core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/`
Expected: PASS — all data tests green, including the updated 7-tool assertion, the `data_search` NOT_SUPPORTED + validation cases, and every prior M1/M4/M5 test (no regressions).

- [ ] **Step 6: Full build to confirm the production bundle compiles**

Run: `cd /home/ubuntu/lm-assist && ./core.sh build`
Expected: `tsc` completes with no errors (the `data_search` def/handler, route, and backend all compile into `core/dist`).

- [ ] **Step 7: Commit**

```bash
git add core/src/routes/core/data.routes.ts core/src/mcp-server/tools/data-tools.ts core/src/__tests__/data/data-tools.test.ts
git commit -m "feat(data): POST /data/:dataset/search route + data_search MCP tool"
```

---

## Post-Plan: Controller Verification (not a coding task)

After all 8 tasks pass review, the controller (not a subagent) runs a live dev-server smoke test with the REAL embedder, mirroring the M1/M4/M5 e2e pattern:

1. `./core.sh restart` (dev :3200), enable the data service (`dataServiceEnabled` in `~/.lm-assist/project-settings.json`, dev variant), confirm `curl localhost:3200/health`.
2. Create a vector dataset via `POST /data/datasets { id, backend: 'vector', visibility, acl, syncMode }`.
3. `PUT` a few records with real prose `text`; confirm `POST /data/:ds/search { query }` returns them ranked by semantic relevance (real model), with secret-named fields redacted.
4. Confirm `data_search` is live over MCP (local → results; cloud without key → KEY_REQUIRED).
5. Confirm a `vector` dataset with `syncMode: 'full'` replicates to a peer (the M5 sync path is backend-agnostic; `exportSince`/`importBatch` now work for vectors — verify a replica lands and is searchable on the peer after re-embed).
6. Clean up the test dataset; record results + the merge-readiness note in the SDD ledger.

This live step is where the real all-MiniLM-L6-v2 model — deliberately kept out of the unit suite — is exercised end to end. Deploy to 117/123/107 follows the established overlay+restart procedure once the branch review is clean.
```

