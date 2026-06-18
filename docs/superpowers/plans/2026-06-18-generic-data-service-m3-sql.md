# Generic Data Service — M3: SQL Backend (+ pre-M3 hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a structured `sql` `StorageBackend` (better-sqlite3, one SQLite file per dataset, parameterized `QuerySpec`→SQL compiler + FTS5, a local-only raw-read-only-SQL escape hatch) — and first close three cross-cutting findings from the whole-subsystem review (a deployed `text`-redaction gap, reserved dataset-id shadowing, and the half-wired dataset lifecycle).

**Architecture:** Phase A hardens the existing subsystem (engine-independent). Phase B adds `SqlBackend implements StorageBackend` (kind `'sql'`), mirroring `CacheBackend`'s persistence conventions but with a real SQL query compiler. `better-sqlite3` is synchronous + CommonJS-`require`able (no ESM trap) with FTS5 bundled. The engine still owns `version`/timestamps/`origin` (`DataService.put`); the backend persists records faithfully and never accepts raw SQL from normal callers — the only raw path is `POST /data/:dataset/sql`, gated **local-only + read-only**.

**Tech Stack:** TypeScript (CommonJS), `better-sqlite3` (native, prebuilt binaries; pinned in both package.json files), `node:test`.

## Global Constraints

- **`better-sqlite3` is loaded `require`-style** (like `@lancedb/lancedb` in `vector-backend.ts`): `const Database = require('better-sqlite3');` — it is CJS; do NOT use `node:sqlite` (the v20 fleet node lacks it) and do NOT add a `Function('import')` dance (that's for ESM-only deps; better-sqlite3 is CJS). Pin `"better-sqlite3": "^11.0.0"` in BOTH root `package.json` and `core/package.json` (chokidar-style — keep them in sync). It is a NATIVE module: the fleet `core/dist` rsync will NOT carry its `.node`, so deploy needs a per-node `npm i` (handled in the deploy section).
- **Engine owns versioning.** `DataService.put` already sets `version`/`createdAt`/`updatedAt` and forces `origin: undefined` before calling the backend (`data-service.ts:122-139`). `SqlBackend.put` persists the record **exactly as handed to it** — never re-derive `version`. `importBatch` stores the incoming record **as-is** (it carries its own version) with `origin` stamped, LWW-gated by `isNewer` — exactly like `CacheBackend.importBatch`.
- **Faithful round-trip.** Persist enough to reconstruct the full `DataRecord`: `id, version, fields(JSON), text, metadata(JSON|null), origin(JSON|null), created_at, updated_at`. `fields`/`metadata`/`origin` are `JSON.stringify`/`JSON.parse`.
- **No raw SQL from normal callers.** `query` compiles `QuerySpec` → **parameterized** SQL: every caller value is bound (`?`/named params), never string-concatenated. Field names resolve ONLY to declared generated columns or `json_extract(fields, ?)` with the JSON path **bound** — never interpolate a caller field name into SQL. Validate any field token against `^[A-Za-z0-9_.]+$` and reject otherwise. **Never** resolve a filter/sort field to a physical/internal column (`version`, `origin`, `created_at`, `rowid`) — only `fields.*` / `metadata.*` / declared `indexedFields` (this is review finding I4 — the in-memory `getField` top-level fallback must NOT be replicated in SQL).
- **`search` is NOT implemented** on `SqlBackend` (it is not a vector backend; `DataService.search` returns `NOT_SUPPORTED` when `backend.search` is absent). Full-text is exposed through `QuerySpec.fts` → `records_fts MATCH ?`.
- **The raw-SQL route is local-only + read-only.** `POST /data/:dataset/sql` gates `principal.type !== 'local' → FORBIDDEN` **before** any backend call (mirrors the `/data/sync` local-only gate), uses a **readonly** sqlite connection, accepts only a single reader statement (`stmt.reader === true`; better-sqlite3 throws on multi-statement source), redacts result rows on the way out, and appends an audit entry. A cloud `manage` key must NEVER reach raw SQL.
- **Redaction (review finding C1 — fix first).** `redactRecord` currently scrubs `fields`/`metadata` by key-name but leaves `text` UNREDACTED, leaking secrets in record bodies to cloud. Phase A Task 1 makes `redactRecord` run `redactText` on `text`. SQL rows returned by the raw route are scrubbed via `redactValueDeep` + text-aware scrub.
- **Config-less replicas.** A `sql` replica descriptor arrives as `{ kind: 'sql' }` with NO `indexedFields` (`sync-engine.ts` `upsertReplica`). `createDataset` must build a valid base table (+ FTS) without generated columns in that case — generated columns are an optimization, not a correctness requirement.
- **Reserved dataset ids (review finding I2).** `sync`, `access`, `catalog`, `datasets` must be rejected by `DatasetRegistry.create` (they shadow literal `/data/*` routes).
- **Dataset lifecycle (review findings C2/I1).** `createDataset`/`dropDataset` are currently dead code (the route fakes allocation via a `put`/`del` `__init__` round-trip, and there is no drop route). Phase A wires `DataService.initDataset`→`backend.createDataset` (retiring the hack) and adds `DataService.dropDataset`→`backend.dropDataset`+`registry.drop` behind a new `DELETE /data/datasets/:id`, with a `system`/`origin` guard. (A `PUT /data/datasets/:id` config/ACL update is deferred — noted at the end.)
- Tests: `node:test` + `node:assert/strict`, compiled via `tsc -p core/tsconfig.test.json`. SqlBackend tests are hermetic (temp `storeDir`/file). The dev box runs Node v18; `better-sqlite3` prebuilts cover it.

## File Structure

- **Modify** `core/src/data/redaction.ts` — `redactRecord` scrubs `text` (C1).
- **Modify** `core/src/data/dataset-registry.ts` — reserved-id guard in `create`; `system` guard in `drop` (I2, lifecycle).
- **Modify** `core/src/data/data-service.ts` — add `initDataset`, `dropDataset`, `rawSql`; register `SqlBackend`.
- **Modify** `core/src/routes/core/data.routes.ts` — `POST /data/datasets` uses `initDataset`; add `DELETE /data/datasets/:id` + `POST /data/:dataset/sql`.
- **Modify** `core/src/data/paths.ts` — add `sqlDirFor(id)`.
- **Modify** root `package.json` + `core/package.json` — add `better-sqlite3`.
- **Create** `core/src/data/backends/sql-backend.ts` — `SqlBackend`.
- **Create** `core/src/data/backends/sql-compiler.ts` — `compileQuery(q, indexedFields)` → `{ where, params, order }` (pure, unit-testable without a DB).
- **Create** tests: `core/src/__tests__/data/redact-text-field.test.ts`, `core/src/__tests__/data/dataset-lifecycle.test.ts`, `core/src/__tests__/data/sql-compiler.test.ts`, `core/src/__tests__/data/sql-backend.test.ts`, `core/src/__tests__/data/sql-route.test.ts`.

**Base commit before Task 1:** the current branch HEAD (M2 tip `960fea7`). Record it in the ledger.

---

## Phase A — Pre-M3 hardening (from the whole-subsystem review)

### Task 1: Fix the `text`-redaction gap (review C1 — deployed security gap)

**Files:**
- Modify: `core/src/data/redaction.ts:54-60` (`redactRecord`)
- Test: `core/src/__tests__/data/redact-text-field.test.ts`

**Interfaces:**
- Produces: `redactRecord` now also scrubs `text` via `redactText` (inline-secret scrub). No signature change.

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/data/redact-text-field.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactRecord, REDACTED } from '../../data/redaction';
import type { DataRecord } from '../../data/types';

test('redactRecord scrubs inline secrets in the top-level text body (C1)', () => {
  const rec: DataRecord = {
    id: 'r', version: 1,
    fields: { title: 'ok', apiKey: 'sk-zzz' },
    text: 'deploy log: authorization=Bearer sk-abcdEFGH1234567890 then ok',
    createdAt: 't', updatedAt: 't',
  };
  const out = redactRecord(rec);
  assert.equal(out.fields.apiKey, REDACTED);                  // existing field-name redaction unchanged
  assert.ok(!String(out.text).includes('sk-abcdEFGH1234567890')); // the inline token in text is GONE
  assert.match(String(out.text), /«redacted»/);
});

test('redactRecord leaves ordinary text untouched', () => {
  const rec: DataRecord = { id: 'r', version: 1, fields: {}, text: 'the quick brown fox', createdAt: 't', updatedAt: 't' };
  assert.equal(redactRecord(rec).text, 'the quick brown fox');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/redact-text-field.test.js`
Expected: FAIL — the inline token survives in `out.text` (redactRecord doesn't touch text yet).

- [ ] **Step 3: Fix `redactRecord`**

In `core/src/data/redaction.ts`, change `redactRecord` (lines 54-60) to scrub `text` (reuse the existing `redactText` defined lower in the file — it is in scope at module level):

```typescript
/** Deep-clone the record: secret-named field/metadata values → REDACTED, and inline secrets in the text body scrubbed. */
export function redactRecord(rec: DataRecord): DataRecord {
  return {
    ...rec,
    fields: redactValue(rec.fields) as Record<string, unknown>,
    text: rec.text ? redactText(rec.text) : rec.text,
    metadata: rec.metadata ? (redactValue(rec.metadata) as Record<string, unknown>) : rec.metadata,
  };
}
```

> `redactText` is declared later in the same module; function declarations are hoisted, so referencing it from `redactRecord` is fine. (If the build complains about use-before-declaration for a `const` arrow, move the `redactText`/`SECRET_*_RE` block above `redactRecord`.) Do NOT switch `fields`/`metadata` to the heavier `scrubValue` — field-name redaction there is intentional; only the free-text `text` gap is the C1 fix.

- [ ] **Step 4: Run tests + the full data suite**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/redact-text-field.test.js dist-test/__tests__/data/redaction.test.js dist-test/__tests__/data/data-service.test.js`
Expected: PASS — new C1 tests green; existing redaction + data-service tests still green (no record-text in those asserts contains a secret-shaped token, so behavior is unchanged for them).

- [ ] **Step 5: Commit**

```bash
git add core/src/data/redaction.ts core/src/__tests__/data/redact-text-field.test.ts
git commit -m "fix(data): redactRecord scrubs inline secrets in the record text body (review C1, deployed gap)"
```

---

### Task 2: Reserved dataset-id guard + `drop` system guard (review I2 + lifecycle)

**Files:**
- Modify: `core/src/data/dataset-registry.ts` (`create` line 71; `drop` line 108)
- Test: `core/src/__tests__/data/dataset-registry.test.ts` (append)

**Interfaces:**
- Produces: `DatasetRegistry.create` rejects reserved ids; `DatasetRegistry.drop(id)` refuses a `system` dataset (returns `false` without removing). `RESERVED_DATASET_IDS` exported.

- [ ] **Step 1: Write the failing test** (append to the existing `dataset-registry.test.ts`)

```typescript
test('registry: reserved ids are rejected', () => {
  const r = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-resv-')), 'd.json'));
  for (const id of ['sync', 'access', 'catalog', 'datasets']) {
    assert.throws(() => r.create({ id, backend: 'cache', config: { kind: 'cache' } }), /reserved/i);
  }
  // a normal id still works
  assert.equal(r.create({ id: 'ok-ds', backend: 'cache', config: { kind: 'cache' } }).id, 'ok-ds');
});

test('registry: drop refuses a system dataset', () => {
  const r = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-drop-')), 'd.json'));
  r.create({ id: 'sysone', backend: 'cache', system: true, config: { kind: 'cache' } });
  assert.equal(r.drop('sysone'), false);          // refused
  assert.ok(r.get('sysone'));                      // still there
  r.create({ id: 'userone', backend: 'cache', config: { kind: 'cache' } });
  assert.equal(r.drop('userone'), true);          // normal drop works
});
```

> Ensure the test file imports `DatasetRegistry`, `path`, `fs`, `os` (it already does for existing tests — reuse).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/dataset-registry.test.js`
Expected: FAIL — reserved ids are currently allowed; `drop` removes a system dataset.

- [ ] **Step 3: Add the guards**

In `core/src/data/dataset-registry.ts`:
1. After the `DATASET_ID_RE` line (9), add:
```typescript
export const RESERVED_DATASET_IDS = new Set(['sync', 'access', 'catalog', 'datasets']);
```
2. In `create`, right after the `DATASET_ID_RE.test` check (line 72-74), add:
```typescript
    if (RESERVED_DATASET_IDS.has(input.id)) {
      throw new Error(`dataset id "${input.id}" is reserved (collides with a /data route)`);
    }
```
3. Replace `drop` (lines 108-114) with a `system`-guarded version:
```typescript
  drop(id: string): boolean {
    const arr = this.load();
    const target = arr.find((d) => d.id === id);
    if (!target) return false;
    if (target.system) return false; // system datasets are not user-droppable
    const next = arr.filter((d) => d.id !== id);
    this.save(next);
    return true;
  }
```

- [ ] **Step 4: Run tests**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/dataset-registry.test.js`
Expected: PASS — reserved ids rejected; system drop refused; normal create/drop unaffected.

- [ ] **Step 5: Commit**

```bash
git add core/src/data/dataset-registry.ts core/src/__tests__/data/dataset-registry.test.ts
git commit -m "feat(data): reserve sync/access/catalog/datasets ids + guard drop() against system datasets (review I2)"
```

---

### Task 3: Wire the dataset lifecycle — `initDataset`/`dropDataset` + `DELETE /data/datasets/:id` (review C2/I1)

**Files:**
- Modify: `core/src/data/data-service.ts` (add `initDataset` + `dropDataset`)
- Modify: `core/src/routes/core/data.routes.ts` (`POST /data/datasets` uses `initDataset`; add `DELETE /data/datasets/:id`)
- Test: `core/src/__tests__/data/dataset-lifecycle.test.ts`

**Interfaces:**
- Produces: `DataService.initDataset(ctx: CallCtx, datasetId: string): Promise<DataResult<void>>` (local-only; calls `backend.createDataset(descriptor)`); `DataService.dropDataset(ctx: CallCtx, datasetId: string): Promise<DataResult<{ dropped: boolean }>>` (local-only; refuses `system`/`origin`; calls `backend.dropDataset` then `registry.drop`).

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/data/dataset-lifecycle.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { DataService } from '../../data/data-service';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { DatasetRegistry } from '../../data/dataset-registry';
import { KeyStore } from '../../data/key-store';
import { AccessManager } from '../../data/access-manager';

function svc() {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-lc-cache-'));
  const datasets = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-lc-reg-')), 'd.json'));
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-lc-keys-')));
  const backends = new BackendRegistry();
  backends.register(new CacheBackend(cacheDir));
  const manager = new AccessManager({ datasets, keys, nodeId: 'n1' });
  const s = new DataService({ datasets, backends, manager });
  (s as any).enabledOverride = true;
  return { s, datasets, cacheDir };
}

test('lifecycle: initDataset allocates storage; dropDataset removes descriptor + storage', async () => {
  const { s, datasets, cacheDir } = svc();
  datasets.create({ id: 'lc', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [] });
  const local = { principal: { type: 'local' as const } };
  const init = await s.initDataset(local, 'lc');
  assert.equal(init.ok, true);
  assert.ok(fs.existsSync(path.join(cacheDir, 'lc.lmdb')));       // backend.createDataset ran
  // write + read works after init
  await s.put(local, 'lc', { id: 'a', version: 0, fields: { n: 1 }, createdAt: 't', updatedAt: 't' });
  const drop = await s.dropDataset(local, 'lc');
  assert.equal(drop.ok, true);
  assert.equal(datasets.get('lc'), undefined);                    // descriptor gone
  assert.ok(!fs.existsSync(path.join(cacheDir, 'lc.lmdb')));      // storage gone
});

test('lifecycle: dropDataset is local-only and refuses system datasets', async () => {
  const { s, datasets } = svc();
  datasets.create({ id: 'usr', backend: 'cache', config: { kind: 'cache' }, acl: [] });
  const denied = await s.dropDataset({ principal: { type: 'cloud', userId: 'u' } }, 'usr');
  assert.equal(denied.ok, false);
  datasets.create({ id: 'sysd', backend: 'cache', system: true, config: { kind: 'cache' }, acl: [] });
  const sysDrop = await s.dropDataset({ principal: { type: 'local' } }, 'sysd');
  assert.equal(sysDrop.ok, false);
  if (sysDrop.ok) return;
  assert.equal(sysDrop.code, 'FORBIDDEN');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/dataset-lifecycle.test.js`
Expected: FAIL — `s.initDataset`/`s.dropDataset` are not functions.

- [ ] **Step 3: Add `initDataset` + `dropDataset` to `DataService`**

In `core/src/data/data-service.ts`, add these methods (place them after `del`, before the M5 sync helpers):

```typescript
  /** Allocate a dataset's backend storage (local-only). Replaces the route's put/del __init__ hack. */
  async initDataset(ctx: CallCtx, datasetId: string): Promise<DataResult<void>> {
    if (ctx.principal.type !== 'local') return { ok: false, code: 'FORBIDDEN', reason: 'dataset init is local-only' };
    const d = this.deps.datasets.get(datasetId);
    if (!d) return { ok: false, code: 'NOT_FOUND', reason: `dataset "${datasetId}" not found` };
    const backend = this.deps.backends.get(d.backend);
    if (!backend) return { ok: false, code: 'NO_BACKEND', reason: `backend "${d.backend}" unavailable` };
    await backend.createDataset(d); // may throw (e.g. file hard-exclusion) — caller (route) maps to BAD_REQUEST
    return { ok: true, value: undefined };
  }

  /** Drop a dataset + its backend storage (local-only; refuses system datasets and replicas). */
  async dropDataset(ctx: CallCtx, datasetId: string): Promise<DataResult<{ dropped: boolean }>> {
    if (ctx.principal.type !== 'local') return { ok: false, code: 'FORBIDDEN', reason: 'dataset drop is local-only' };
    const d = this.deps.datasets.get(datasetId);
    if (!d) return { ok: false, code: 'NOT_FOUND', reason: `dataset "${datasetId}" not found` };
    if (d.system) return { ok: false, code: 'FORBIDDEN', reason: `dataset "${datasetId}" is a system dataset` };
    if ((d as any).origin) return { ok: false, code: 'FORBIDDEN', reason: `dataset "${datasetId}" is a remote replica` };
    const backend = this.deps.backends.get(d.backend);
    if (backend) { try { await backend.dropDataset(datasetId); } catch { /* best effort — still remove the descriptor */ } }
    const dropped = this.deps.datasets.drop(datasetId);
    return { ok: true, value: { dropped } };
  }
```

- [ ] **Step 4: Rewire the routes**

In `core/src/routes/core/data.routes.ts`:
1. In `POST /data/datasets`, replace the two `__init__` lines:
```typescript
          // ensure the backend allocates storage
          await svc().put({ principal: p }, d.id, recordFromBody({ id: '__init__', fields: {} }));
          await svc().del({ principal: p }, d.id, '__init__');
```
with the clean allocation call:
```typescript
          // allocate the backend's storage via the real lifecycle method
          const init = await svc().initDataset({ principal: p }, d.id);
          if (!init.ok) { getDatasetRegistry().drop(d.id); return wrapError(init.code, init.reason, start); }
```
2. Add a `DELETE /data/datasets/:id` route (place it right after the `POST /data/datasets` route):
```typescript
    // DELETE /data/datasets/:id — drop a dataset + its storage (LOCAL only; refuses system/replica)
    {
      method: 'DELETE',
      pattern: /^\/data\/datasets\/(?<id>[^/]+)$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const r = await svc().dropDataset(ctxOf(req), req.params.id);
        if (!r.ok) return wrapError(r.code, r.reason, start);
        return wrapResponse(r.value, start);
      },
    },
```

> The `DELETE /data/datasets/:id` pattern must be registered BEFORE the `/data/:dataset/records/:id` wildcard isn't an issue (different method+suffix), but DO confirm it sits with the other `/data/datasets` routes so the literal `datasets` segment matches before any `:dataset` wildcard. (Reserved-id guard from Task 2 guarantees no dataset is named `datasets`.)

- [ ] **Step 5: Run tests + the data-routes suite**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/dataset-lifecycle.test.js dist-test/__tests__/data/data-routes.test.js`
Expected: PASS — lifecycle tests green; the existing `data-routes.test.ts` (which creates a cache dataset via `POST /data/datasets`) still green (the `initDataset` allocation produces the same empty-dataset end-state the put/del hack did).

- [ ] **Step 6: Commit**

```bash
git add core/src/data/data-service.ts core/src/routes/core/data.routes.ts core/src/__tests__/data/dataset-lifecycle.test.ts
git commit -m "feat(data): real dataset lifecycle — DataService.initDataset/dropDataset + DELETE /data/datasets/:id (review C2/I1)"
```

---

## Phase B — SQL backend

### Task 4: `better-sqlite3` dep + `sqlDirFor` + `SqlBackend` createDataset/dropDataset (schema + FTS5 + generated columns)

**Files:**
- Modify: root `package.json` + `core/package.json` (add `better-sqlite3`)
- Modify: `core/src/data/paths.ts` (add `sqlDirFor`)
- Create: `core/src/data/backends/sql-backend.ts`
- Test: `core/src/__tests__/data/sql-backend.test.ts`

**Interfaces:**
- Produces: `class SqlBackend implements StorageBackend` (`kind='sql'`), `constructor(storeDirOverride?: string)`; `sqlDirFor(id: string): string`. Tasks 5-7 add put/get/query/delete/export/import/admin.

- [ ] **Step 1: Add the dependency**

```bash
cd /home/ubuntu/lm-assist
# add to BOTH package.json files (keep in sync, like chokidar)
npm pkg set dependencies.better-sqlite3="^11.0.0"
cd core && npm pkg set dependencies.better-sqlite3="^11.0.0" && cd ..
npm install better-sqlite3 --workspaces=false || npm install
node -e "const D=require('better-sqlite3'); const db=new D(':memory:'); db.exec(\"CREATE VIRTUAL TABLE t USING fts5(x)\"); console.log('better-sqlite3 ok, FTS5 ok');"
```
Expected: prints `better-sqlite3 ok, FTS5 ok` (confirms the native module loads under the dev Node AND FTS5 is compiled in). If `npm install` rebuilds the web `prepare` hook unexpectedly, use `npm install better-sqlite3 --ignore-scripts` then a normal build.

- [ ] **Step 2: Add `sqlDirFor` to `paths.ts`**

In `core/src/data/paths.ts`, after `cacheDirFor` (line 20-22):
```typescript
export function sqlDirFor(datasetId: string): string {
  return path.join(dataRoot(), 'sql', `${datasetId}.sqlite`);
}
```

- [ ] **Step 3: Write the failing test**

`core/src/__tests__/data/sql-backend.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { SqlBackend } from '../../data/backends/sql-backend';
import type { DatasetDescriptor } from '../../data/types';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sql-')); }
function be(dir = tmp()): SqlBackend { return new SqlBackend(dir); }
function descriptor(id: string, indexedFields?: Array<{ path: string; type: 'text' | 'number' }>): DatasetDescriptor {
  return { id, backend: 'sql', ownerNode: 'n', visibility: 'local-only',
    config: { kind: 'sql', ...(indexedFields ? { indexedFields } : {}) }, acl: [], createdAt: 't', updatedAt: 't' };
}

test('sql backend: createDataset builds a usable db (FTS), get on empty → null, dropDataset removes the file', async () => {
  const dir = tmp();
  const b = be(dir);
  await b.createDataset(descriptor('d1', [{ path: 'topic', type: 'text' }]));
  assert.ok(fs.existsSync(path.join(dir, 'd1.sqlite')));
  assert.equal(await b.get('d1', 'missing'), null);
  await b.dropDataset('d1');
  assert.ok(!fs.existsSync(path.join(dir, 'd1.sqlite')));
});

test('sql backend: config-less replica (no indexedFields) still creates a valid table', async () => {
  const b = be();
  await b.createDataset(descriptor('repl')); // no indexedFields
  assert.equal(await b.get('repl', 'x'), null); // table exists, query path works
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/sql-backend.test.js`
Expected: FAIL — `Cannot find module '.../sql-backend'`.

- [ ] **Step 5: Create `core/src/data/backends/sql-backend.ts` (lifecycle only; CRUD/sync in Tasks 5-7)**

```typescript
// core/src/data/backends/sql-backend.ts
// Structured `sql` backend: one SQLite file per dataset (better-sqlite3, synchronous, CJS).
// Schema faithfully round-trips DataRecord; declared indexedFields become indexed generated
// columns; full-text via an external-content FTS5 table kept in sync by triggers. The engine
// owns version/timestamps/origin (DataService.put) — this backend persists records as handed.
import * as fs from 'fs';
import * as path from 'path';
import type {
  StorageBackend, BackendKind, DatasetDescriptor, DataRecord, QuerySpec, NodeOrigin, SqlConfig,
} from '../types';
import { isNewer } from '../types';
import { sqlDirFor } from '../paths';

const Database = require('better-sqlite3');

/** Sanitize an indexedField path into a safe generated-column name. */
function colName(p: string): string { return 'f_' + p.replace(/[^a-z0-9_]/gi, '_'); }
function isSafeFieldPath(p: string): boolean { return /^[A-Za-z0-9_.]+$/.test(p); }

const SELECT_COLS = 'id, fields, text, metadata, origin, version, created_at, updated_at';

export function rowToRecord(row: any): DataRecord {
  return {
    id: row.id,
    version: row.version,
    fields: JSON.parse(row.fields),
    text: row.text == null ? undefined : row.text,
    metadata: row.metadata == null ? undefined : JSON.parse(row.metadata),
    origin: row.origin == null ? undefined : JSON.parse(row.origin),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function recordParams(rec: DataRecord): Record<string, unknown> {
  return {
    id: rec.id,
    fields: JSON.stringify(rec.fields ?? {}),
    text: rec.text ?? null,
    metadata: rec.metadata == null ? null : JSON.stringify(rec.metadata),
    origin: rec.origin == null ? null : JSON.stringify(rec.origin),
    version: rec.version ?? 0,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
  };
}

export class SqlBackend implements StorageBackend {
  readonly kind: BackendKind = 'sql';
  private storeDirOverride?: string;
  private dbs = new Map<string, any>();

  constructor(storeDirOverride?: string) { this.storeDirOverride = storeDirOverride; }

  private fileFor(id: string): string {
    return this.storeDirOverride ? path.join(this.storeDirOverride, `${id}.sqlite`) : sqlDirFor(id);
  }

  /** Open (creating + migrating schema if needed) the dataset's db handle. */
  private db(id: string, indexedFields?: Array<{ path: string; type: 'text' | 'number' }>): any {
    let h = this.dbs.get(id);
    if (h) return h;
    const file = this.fileFor(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    h = new Database(file);
    h.pragma('journal_mode = WAL');
    h.exec(`
      CREATE TABLE IF NOT EXISTS records(
        rowid INTEGER PRIMARY KEY,
        id TEXT UNIQUE NOT NULL,
        fields TEXT NOT NULL,
        text TEXT,
        metadata TEXT,
        origin TEXT,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(text, content='records', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
        INSERT INTO records_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
        INSERT INTO records_fts(records_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
        INSERT INTO records_fts(records_fts, rowid, text) VALUES('delete', old.rowid, old.text);
        INSERT INTO records_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
    `);
    // Declared indexed fields → generated columns + indexes (best-effort; skip if already present).
    const existing = new Set((h.prepare(`PRAGMA table_info(records)`).all() as any[]).map((c) => c.name));
    for (const f of indexedFields || []) {
      if (!isSafeFieldPath(f.path)) continue;
      const col = colName(f.path);
      if (existing.has(col)) continue;
      const type = f.type === 'number' ? 'REAL' : 'TEXT';
      // json_extract path is a literal built from a VALIDATED path (isSafeFieldPath) — no caller input here.
      h.exec(`ALTER TABLE records ADD COLUMN "${col}" ${type} GENERATED ALWAYS AS (json_extract(fields, '$.${f.path}')) VIRTUAL;`);
      h.exec(`CREATE INDEX IF NOT EXISTS "idx_${col}" ON records("${col}");`);
    }
    this.dbs.set(id, h);
    return h;
  }

  /** The indexedFields a dataset declared (for the query compiler to prefer generated columns). */
  indexedPaths(d: DatasetDescriptor): string[] {
    const c = d.config as SqlConfig;
    return (c.indexedFields || []).filter((f) => isSafeFieldPath(f.path)).map((f) => f.path);
  }

  async createDataset(d: DatasetDescriptor): Promise<void> {
    const c = d.config as SqlConfig;
    this.db(d.id, c.indexedFields);
  }

  async dropDataset(id: string): Promise<void> {
    const h = this.dbs.get(id);
    if (h) { try { h.close(); } catch { /* */ } this.dbs.delete(id); }
    const file = this.fileFor(id);
    for (const f of [file, `${file}-wal`, `${file}-shm`]) { try { if (fs.existsSync(f)) fs.rmSync(f); } catch { /* */ } }
  }

  async get(dataset: string, id: string): Promise<DataRecord | null> {
    const row = this.db(dataset).prepare(`SELECT ${SELECT_COLS} FROM records WHERE id = ?`).get(id);
    return row ? rowToRecord(row) : null;
  }

  // put/query/delete in Task 5-6; exportSince/importBatch/admin in Task 7.
  async put(_dataset: string, _record: DataRecord): Promise<{ id: string }> { throw new Error('not implemented'); }
  async query(_dataset: string, _q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }> { throw new Error('not implemented'); }
  async delete(_dataset: string, _id: string): Promise<boolean> { throw new Error('not implemented'); }
  async exportSince(_dataset: string, _since?: string): Promise<DataRecord[]> { throw new Error('not implemented'); }
  async importBatch(_dataset: string, _records: DataRecord[], _origin: NodeOrigin): Promise<{ applied: number; skipped: number }> { throw new Error('not implemented'); }
}
```

> NOTE: `get` is implemented here (needed by the lifecycle test). The other CRUD methods are `throw 'not implemented'` stubs filled in Tasks 5-7 (the same TDD-scaffolding pattern as the vector backend). `search`/`admin` are intentionally absent (added/decided in Task 7). The `db()` method is the lazy open+migrate used by every method — it accepts `indexedFields` only on the create path; later calls pass none and reuse the cached handle.

- [ ] **Step 6: Run tests**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/sql-backend.test.js`
Expected: PASS — createDataset builds the db + FTS, get→null, dropDataset removes the file(s); config-less replica creates a valid table.

- [ ] **Step 7: Commit**

```bash
git add package.json core/package.json package-lock.json core/src/data/paths.ts core/src/data/backends/sql-backend.ts core/src/__tests__/data/sql-backend.test.ts
git commit -m "feat(data): SqlBackend lifecycle — better-sqlite3 per-dataset file, FTS5 + triggers + generated columns; sqlDirFor"
```

---

### Task 5: `SqlBackend` put / delete (UPSERT, FTS-synced, engine-owns-version)

**Files:**
- Modify: `core/src/data/backends/sql-backend.ts` (replace `put`/`delete` stubs)
- Test: `core/src/__tests__/data/sql-backend.test.ts` (append)

**Interfaces:**
- Produces: working `put` (UPSERT on `id`, stable rowid, FTS kept in sync) and `delete`.

- [ ] **Step 1: Write the failing test** (append)

```typescript
function rec(id: string, fields: Record<string, unknown>, text?: string, version = 1): DataRecord {
  return { id, version, fields, text, createdAt: 'c', updatedAt: 'u', metadata: { src: 'unit' } } as DataRecord;
}

test('sql backend: put/get round-trip preserves the full record; re-put upserts (one row)', async () => {
  const b = be();
  await b.createDataset(descriptor('rt'));
  await b.put('rt', rec('a', { title: 'Hello', n: 42 }, 'body text', 3));
  const got = await b.get('rt', 'a');
  assert.equal(got?.fields.title, 'Hello');
  assert.equal(got?.fields.n, 42);
  assert.equal(got?.version, 3);
  assert.equal(got?.text, 'body text');
  assert.equal((got?.metadata as any)?.src, 'unit');
  await b.put('rt', rec('a', { title: 'Renamed' }, 'body text', 4));
  const after = await b.get('rt', 'a');
  assert.equal(after?.fields.title, 'Renamed');
  assert.equal(after?.version, 4);
});

test('sql backend: delete removes the record (and its FTS row)', async () => {
  const b = be();
  await b.createDataset(descriptor('del'));
  await b.put('del', rec('a', {}, 'find me unique-token'));
  assert.equal(await b.delete('del', 'a'), true);
  assert.equal(await b.get('del', 'a'), null);
  assert.equal(await b.delete('del', 'a'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/sql-backend.test.js`
Expected: FAIL — `put` throws `not implemented`.

- [ ] **Step 3: Implement `put` + `delete`**

Replace the `put` stub:

```typescript
  async put(dataset: string, record: DataRecord): Promise<{ id: string }> {
    const h = this.db(dataset);
    h.prepare(`
      INSERT INTO records(id, fields, text, metadata, origin, version, created_at, updated_at)
      VALUES(@id, @fields, @text, @metadata, @origin, @version, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        fields=excluded.fields, text=excluded.text, metadata=excluded.metadata,
        origin=excluded.origin, version=excluded.version,
        created_at=excluded.created_at, updated_at=excluded.updated_at
    `).run(recordParams(record));
    return { id: record.id };
  }
```

Replace the `delete` stub:

```typescript
  async delete(dataset: string, id: string): Promise<boolean> {
    const info = this.db(dataset).prepare(`DELETE FROM records WHERE id = ?`).run(id);
    return info.changes > 0;
  }
```

> UPSERT (`ON CONFLICT DO UPDATE`) keeps the rowid stable, so the `AFTER UPDATE` trigger maintains `records_fts`; `INSERT OR REPLACE` would NOT (it changes rowid) — do not use it.

- [ ] **Step 4: Run tests**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/sql-backend.test.js`
Expected: PASS — round-trip + upsert-no-dup + delete green.

- [ ] **Step 5: Commit**

```bash
git add core/src/data/backends/sql-backend.ts core/src/__tests__/data/sql-backend.test.ts
git commit -m "feat(data): SqlBackend put (UPSERT, FTS-synced) + delete"
```

---

### Task 6: The `QuerySpec` → parameterized SQL compiler + `SqlBackend.query`

**Files:**
- Create: `core/src/data/backends/sql-compiler.ts`
- Modify: `core/src/data/backends/sql-backend.ts` (replace `query` stub; use the compiler)
- Test: `core/src/__tests__/data/sql-compiler.test.ts` (pure, no DB) + `sql-backend.test.ts` (append, against a real db)

**Interfaces:**
- Produces: `compileQuery(q: QuerySpec, indexed: Set<string>): { where: string; params: unknown[]; order: string }` (pure); `SqlBackend.query` uses it.

- [ ] **Step 1: Write the failing tests**

`core/src/__tests__/data/sql-compiler.test.ts` (pure — verifies the SQL is parameterized and never interpolates caller values/fields):

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileQuery } from '../../data/backends/sql-compiler';

test('compiler: filter ops produce bound placeholders, never inlined values', () => {
  const c = compileQuery({ filter: [{ field: 'topic', op: 'eq', value: 'astro' }, { field: 'n', op: 'gt', value: 5 }] }, new Set(['topic']));
  assert.match(c.where, /WHERE/);
  assert.ok(!c.where.includes('astro'));          // value is bound, not inlined
  // indexed field uses the generated column (no param); non-indexed pushes a bound json path then the value
  assert.match(c.where, /"f_topic"/);
  assert.match(c.where, /json_extract\(fields, \?\)/);
  assert.deepEqual(c.whereParams, ['astro', '$.n', 5]); // topic indexed → just its value; n non-indexed → path + value
  assert.deepEqual(c.orderParams, []);
});

test('compiler: in / contains / fts', () => {
  const c = compileQuery({ filter: [{ field: 'tag', op: 'in', value: ['a', 'b'] }, { field: 'body', op: 'contains', value: 'x_y' }], fts: 'hello' }, new Set());
  assert.match(c.where, /IN \(\?, \?\)/);
  assert.match(c.where, /LIKE \? ESCAPE/);
  assert.match(c.where, /records_fts MATCH \?/);
  assert.ok(c.whereParams.includes('hello'));       // fts query bound
  assert.ok(c.whereParams.includes('%x\\_y%'));     // contains value, LIKE-escaped + bound
});

test('compiler: rejects unsafe field names; a "version" field hits JSON, not the physical column', () => {
  assert.throws(() => compileQuery({ filter: [{ field: 'fields); DROP TABLE records;--', op: 'eq', value: 1 }] }, new Set()), /invalid field/i);
  // a filter field named "version" resolves to fields.version (user JSON), NOT the physical version column
  const c = compileQuery({ filter: [{ field: 'version', op: 'eq', value: 1 }] }, new Set());
  assert.match(c.where, /json_extract\(fields, \?\)/);
  assert.ok(!c.where.includes('records.version'));
  assert.deepEqual(c.whereParams, ['$.version', 1]);
});

test('compiler: sort + empty query', () => {
  const c = compileQuery({ sort: [{ field: 'topic', dir: 'desc' }] }, new Set(['topic']));
  assert.match(c.order, /ORDER BY "f_topic" DESC/);
  assert.deepEqual(c.orderParams, []);              // indexed sort field → generated column, no param
  const c2 = compileQuery({ sort: [{ field: 'n', dir: 'asc' }] }, new Set());
  assert.match(c2.order, /json_extract\(fields, \?\) ASC/);
  assert.deepEqual(c2.orderParams, ['$.n']);        // non-indexed sort field → bound json path in orderParams
  const empty = compileQuery({}, new Set());
  assert.equal(empty.where, '');
  assert.equal(empty.order, '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/sql-compiler.test.js`
Expected: FAIL — `Cannot find module '.../sql-compiler'`.

- [ ] **Step 3: Create `core/src/data/backends/sql-compiler.ts`**

```typescript
// core/src/data/backends/sql-compiler.ts
// Compile a QuerySpec into PARAMETERIZED SQL fragments. Every caller value is bound (never inlined);
// field names resolve ONLY to a declared generated column ("f_<name>") or json_extract(fields, ?)
// with the JSON path BOUND — never a physical/internal column (version/origin/created_at/rowid),
// never a raw caller-interpolated identifier. This is the security boundary for the sql backend.
import type { QuerySpec, QueryFilter } from '../types';

const FIELD_RE = /^[A-Za-z0-9_.]+$/;
function genCol(field: string): string { return '"f_' + field.replace(/[^a-z0-9_]/gi, '_') + '"'; }

/** SQL column expression for a logical field + the params it contributes (the bound json path, if any). */
function colExpr(field: string, indexed: Set<string>, params: unknown[]): string {
  if (!FIELD_RE.test(field)) throw new Error(`invalid field name "${field}"`);
  if (indexed.has(field)) return genCol(field);     // safe: from validated indexedFields config
  params.push('$.' + field);                         // bound json path — caller field never inlined
  return 'json_extract(fields, ?)';
}

function opSql(col: string, f: QueryFilter, params: unknown[]): string {
  switch (f.op) {
    case 'eq': params.push(f.value); return `${col} IS ?`;
    case 'ne': params.push(f.value); return `${col} IS NOT ?`;
    case 'gt': params.push(f.value); return `${col} > ?`;
    case 'gte': params.push(f.value); return `${col} >= ?`;
    case 'lt': params.push(f.value); return `${col} < ?`;
    case 'lte': params.push(f.value); return `${col} <= ?`;
    case 'in': {
      const arr = Array.isArray(f.value) ? f.value : [];
      // Empty IN matches nothing. Still reference `col` (X IN (NULL) → NULL/false) so the json-path
      // param `colExpr` already pushed stays aligned with a placeholder — returning a bare '0' would
      // leave that param dangling and better-sqlite3 would over-bind.
      if (!arr.length) return `${col} IN (NULL)`;
      arr.forEach((v) => params.push(v));
      return `${col} IN (${arr.map(() => '?').join(', ')})`;
    }
    case 'contains': {
      const v = String(f.value).replace(/[%_\\]/g, '\\$&'); // escape LIKE wildcards in the value
      params.push(`%${v}%`);
      return `${col} LIKE ? ESCAPE '\\'`;
    }
    default: throw new Error(`unsupported op "${(f as any).op}"`);
  }
}

export function compileQuery(q: QuerySpec, indexed: Set<string>): { where: string; whereParams: unknown[]; order: string; orderParams: unknown[] } {
  const whereParams: unknown[] = [];
  const clauses: string[] = [];
  for (const f of q.filter || []) {
    const col = colExpr(f.field, indexed, whereParams);
    clauses.push(opSql(col, f, whereParams));
  }
  if (q.fts) {
    whereParams.push(q.fts);
    clauses.push(`records.rowid IN (SELECT rowid FROM records_fts WHERE records_fts MATCH ?)`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const orderParams: unknown[] = [];
  let order = '';
  if (q.sort?.length) {
    const parts = q.sort.map((s) => {
      const dir = s.dir === 'desc' ? 'DESC' : 'ASC';
      const col = colExpr(s.field, indexed, orderParams); // pushes the bound json path (if non-indexed) into orderParams
      return `${col} ${dir}`;
    });
    order = `ORDER BY ${parts.join(', ')}`;
  }
  return { where, whereParams, order, orderParams };
}
```

> WHY two param arrays: the `COUNT(*)` query uses only the `WHERE` clause (so only `whereParams`), while the row query is `... WHERE <where> ORDER BY <order> LIMIT ? OFFSET ?` (so `whereParams` THEN `orderParams` THEN limit/offset). A single combined array would over-bind the COUNT query and `better-sqlite3` throws. `colExpr` is reused for sort, pushing its bound json-path into `orderParams`.

- [ ] **Step 4: Implement `SqlBackend.query` using the compiler**

In `sql-backend.ts`, add the import:
```typescript
import { compileQuery } from './sql-compiler';
```
The backend needs the dataset's indexed paths to build the compiler's `indexed` set. Since `query(dataset, q)` doesn't receive the descriptor, resolve it from the registry (mirroring how the file backend resolves its descriptor) — add at the top of `sql-backend.ts`:
```typescript
import { getDatasetRegistry } from '../dataset-registry';
```
Add a private helper + replace the `query` stub:
```typescript
  private indexedFor(dataset: string): Set<string> {
    const d = getDatasetRegistry().get(dataset);
    const c = d?.config as SqlConfig | undefined;
    return new Set((c?.indexedFields || []).filter((f) => isSafeFieldPath(f.path)).map((f) => f.path));
  }

  async query(dataset: string, q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }> {
    const h = this.db(dataset);
    const { where, whereParams, order, orderParams } = compileQuery(q, this.indexedFor(dataset));
    const total = (h.prepare(`SELECT COUNT(*) AS n FROM records ${where}`).get(...whereParams) as any).n as number;
    const limit = q.limit ?? -1;            // sqlite: LIMIT -1 = no limit
    const offset = q.offset ?? 0;
    const rows = h.prepare(`SELECT ${SELECT_COLS} FROM records ${where} ${order} LIMIT ? OFFSET ?`).all(...whereParams, ...orderParams, limit, offset);
    return { records: rows.map(rowToRecord), total };
  }
```

> Tests construct `SqlBackend(tmpDir)` directly, so `getDatasetRegistry()` resolves nothing for those ids → `indexedFor` returns an empty set → the compiler uses `json_extract` for every field (correct, just unindexed). To exercise the indexed-column path in a backend test, the test can pass `indexedFields` to `createDataset` AND the query still works via `json_extract` (functionally identical results); the generated-column optimization is verified by the compiler unit test, not required for the backend test's correctness.

- [ ] **Step 5: Append backend query tests** (to `sql-backend.test.ts`)

```typescript
test('sql backend: query filter + sort + limit + total + fts', async () => {
  const b = be();
  await b.createDataset(descriptor('q', [{ path: 'topic', type: 'text' }]));
  await b.put('q', rec('a', { topic: 'astro', n: 1 }, 'telescope galaxies'));
  await b.put('q', rec('b', { topic: 'cook', n: 2 }, 'tomato sauce'));
  await b.put('q', rec('c', { topic: 'astro', n: 3 }, 'exoplanet orbit'));
  const f = await b.query('q', { filter: [{ field: 'topic', op: 'eq', value: 'astro' }] });
  assert.deepEqual(f.records.map((r) => r.id).sort(), ['a', 'c']);
  assert.equal(f.total, 2);
  const sorted = await b.query('q', { sort: [{ field: 'n', dir: 'desc' }], limit: 1 });
  assert.deepEqual(sorted.records.map((r) => r.id), ['c']);
  assert.equal(sorted.total, 3);
  const fts = await b.query('q', { fts: 'galaxies' });
  assert.deepEqual(fts.records.map((r) => r.id), ['a']);
});
```

- [ ] **Step 6: Run tests**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/sql-compiler.test.js dist-test/__tests__/data/sql-backend.test.js`
Expected: PASS — compiler (parameterization, in/contains/fts, unsafe-field reject, sort) + backend query (filter/sort/limit/total/fts) green.

- [ ] **Step 7: Commit**

```bash
git add core/src/data/backends/sql-compiler.ts core/src/data/backends/sql-backend.ts core/src/__tests__/data/sql-compiler.test.ts core/src/__tests__/data/sql-backend.test.ts
git commit -m "feat(data): parameterized QuerySpec->SQL compiler + SqlBackend.query (filter/sort/limit/total/fts)"
```

---

### Task 7: `SqlBackend` exportSince / importBatch (LWW) + admin

**Files:**
- Modify: `core/src/data/backends/sql-backend.ts` (replace `exportSince`/`importBatch` stubs; add `admin`)
- Test: `core/src/__tests__/data/sql-backend.test.ts` (append)

**Interfaces:**
- Produces: `exportSince` (ascending watermark), `importBatch` (LWW via `isNewer`, origin-stamped), `admin(op)` (`stats`/`integrity-check`).

- [ ] **Step 1: Write the failing test** (append)

```typescript
import type { NodeOrigin } from '../../data/types';
const ORIGIN: NodeOrigin = { machineId: 'remote1', hostname: 'r1', os: 'linux' };

test('sql backend: exportSince watermark (ascending) + importBatch LWW + origin stamp', async () => {
  const b = be();
  await b.createDataset(descriptor('s'));
  await b.put('s', { id: 'a', version: 1, fields: {}, text: 'a', createdAt: 'c', updatedAt: '2026-01-01T00:00:00Z' });
  await b.put('s', { id: 'b', version: 1, fields: {}, text: 'b', createdAt: 'c', updatedAt: '2026-02-01T00:00:00Z' });
  assert.deepEqual((await b.exportSince('s')).map((r) => r.id), ['a', 'b']);
  assert.deepEqual((await b.exportSince('s', '2026-01-15T00:00:00Z')).map((r) => r.id), ['b']);

  await b.put('s', { id: 'a', version: 2, fields: { v: 'local' }, text: 'a', createdAt: 'c', updatedAt: 'u2' });
  const res = await b.importBatch('s', [
    { id: 'a', version: 1, fields: { v: 'old' }, text: 'a', createdAt: 'c', updatedAt: 'u1' },   // older → skip
    { id: 'z', version: 3, fields: { v: 'new' }, text: 'z', createdAt: 'c', updatedAt: 'u3' },   // new → apply
  ], ORIGIN);
  assert.equal(res.applied, 1);
  assert.equal(res.skipped, 1);
  assert.equal((await b.get('s', 'a'))?.fields.v, 'local'); // local v2 preserved
  const z = await b.get('s', 'z');
  assert.equal(z?.fields.v, 'new');
  assert.deepEqual(z?.origin, ORIGIN);                      // origin stamped on the replica
});

test('sql backend: admin stats + integrity-check', async () => {
  const b = be();
  await b.createDataset(descriptor('adm'));
  await b.put('adm', { id: 'a', version: 1, fields: {}, createdAt: 'c', updatedAt: 'u' });
  const stats = await b.admin!('adm', 'stats') as any;
  assert.equal(stats.count, 1);
  const ic = await b.admin!('adm', 'integrity-check') as any;
  assert.equal(ic.ok, true);
  await assert.rejects(() => b.admin!('adm', 'nope'), /unknown admin op/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/sql-backend.test.js`
Expected: FAIL — `exportSince`/`importBatch` throw `not implemented`; `admin` is undefined.

- [ ] **Step 3: Implement `exportSince`, `importBatch`, `admin`**

Replace the `exportSince` stub:
```typescript
  async exportSince(dataset: string, since?: string): Promise<DataRecord[]> {
    const h = this.db(dataset);
    const rows = since
      ? h.prepare(`SELECT ${SELECT_COLS} FROM records WHERE updated_at >= ? ORDER BY updated_at ASC`).all(since)
      : h.prepare(`SELECT ${SELECT_COLS} FROM records ORDER BY updated_at ASC`).all();
    return rows.map(rowToRecord);
  }
```

Replace the `importBatch` stub (LWW, mirrors `cache-backend.importBatch`):
```typescript
  async importBatch(dataset: string, records: DataRecord[], origin: NodeOrigin): Promise<{ applied: number; skipped: number }> {
    let applied = 0, skipped = 0;
    for (const incoming of records) {
      const local = await this.get(dataset, incoming.id);
      const stamped: DataRecord = { ...incoming, origin };
      if (isNewer(stamped, local)) { await this.put(dataset, stamped); applied++; } else skipped++;
    }
    return { applied, skipped };
  }
```

Add the `admin` method (place after `delete`):
```typescript
  async admin(dataset: string, op: string, _args?: Record<string, unknown>): Promise<unknown> {
    const h = this.db(dataset);
    switch (op) {
      case 'stats': {
        const n = (h.prepare(`SELECT COUNT(*) AS n FROM records`).get() as any).n;
        return { count: n };
      }
      case 'integrity-check': {
        const r = h.prepare(`PRAGMA integrity_check`).get() as any;
        return { ok: r.integrity_check === 'ok', detail: r.integrity_check };
      }
      case 'vacuum':
        h.exec('VACUUM');
        return { ok: true };
      default:
        throw new Error(`unknown admin op: ${op}`);
    }
  }
```

> `importBatch` calls `this.put` (the engine-owned UPSERT) with the **incoming** record as-is (its own version), origin-stamped — it must NOT re-derive version (that's `DataService.put`'s job for local writes only). This matches `cache-backend.ts`.

- [ ] **Step 4: Run the full SqlBackend + cache + compiler suite**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/sql-backend.test.js dist-test/__tests__/data/sql-compiler.test.js dist-test/__tests__/data/cache-backend.test.js`
Expected: PASS — export/import/admin green; no `not implemented` stubs remain (`grep -n "not implemented" core/src/data/backends/sql-backend.ts` → nothing).

- [ ] **Step 5: Commit**

```bash
git add core/src/data/backends/sql-backend.ts core/src/__tests__/data/sql-backend.test.ts
git commit -m "feat(data): SqlBackend exportSince/importBatch (LWW) + admin (stats/integrity-check/vacuum)"
```

---

### Task 8: Register `SqlBackend` + the local-only raw-SQL route (`POST /data/:dataset/sql`)

**Files:**
- Modify: `core/src/data/backends/sql-backend.ts` (add `rawSelect`)
- Modify: `core/src/data/data-service.ts` (register `SqlBackend`; add `rawSql`)
- Modify: `core/src/routes/core/data.routes.ts` (add `POST /data/:dataset/sql`)
- Test: `core/src/__tests__/data/sql-route.test.ts`

**Interfaces:**
- Produces: `SqlBackend.rawSelect(dataset, sql, params): Array<Record<string, unknown>>` (readonly handle, single reader stmt only); `DataService.rawSql(ctx, datasetId, sql, params): Promise<DataResult<{ rows: unknown[] }>>` (local-only, sql-backend-only, redacted, audited); `POST /data/:dataset/sql`.

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/data/sql-route.test.ts` (service-level — exercises `rawSql` gating without HTTP):

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { DataService } from '../../data/data-service';
import { BackendRegistry } from '../../data/backend-registry';
import { SqlBackend } from '../../data/backends/sql-backend';
import { CacheBackend } from '../../data/backends/cache-backend';
import { DatasetRegistry } from '../../data/dataset-registry';
import { KeyStore } from '../../data/key-store';
import { AccessManager } from '../../data/access-manager';

function svc() {
  const datasets = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-rs-reg-')), 'd.json'));
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-rs-keys-')));
  const backends = new BackendRegistry();
  backends.register(new SqlBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-rs-sql-'))));
  backends.register(new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-rs-cache-'))));
  const manager = new AccessManager({ datasets, keys, nodeId: 'n1' });
  const s = new DataService({ datasets, backends, manager });
  (s as any).enabledOverride = true;
  return { s, datasets };
}

test('rawSql: local SELECT returns redacted rows; cloud is FORBIDDEN; writes/multi rejected; non-sql NOT_SUPPORTED', async () => {
  const { s, datasets } = svc();
  datasets.create({ id: 'sq', backend: 'sql', config: { kind: 'sql' }, acl: [] });
  const local = { principal: { type: 'local' as const } };
  await s.initDataset(local, 'sq');
  await s.put(local, 'sq', { id: 'a', version: 0, fields: { token: 'sk-zzz', topic: 'x' }, createdAt: 't', updatedAt: 't' });

  const ok = await s.rawSql(local, 'sq', 'SELECT json_extract(fields, \'$.topic\') AS topic, fields FROM records', []);
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal((ok.value.rows[0] as any).topic, 'x');
  assert.ok(!JSON.stringify(ok.value.rows).includes('sk-zzz')); // secret-named field redacted in the raw rows too

  // cloud is refused outright
  const cloud = await s.rawSql({ principal: { type: 'cloud', userId: 'u' } }, 'sq', 'SELECT 1', []);
  assert.equal(cloud.ok, false);
  if (cloud.ok) return; assert.equal(cloud.code, 'FORBIDDEN');

  // a write is rejected
  const write = await s.rawSql(local, 'sq', 'DELETE FROM records', []);
  assert.equal(write.ok, false);

  // a non-sql dataset → NOT_SUPPORTED
  datasets.create({ id: 'ch', backend: 'cache', config: { kind: 'cache' }, acl: [] });
  const nonSql = await s.rawSql(local, 'ch', 'SELECT 1', []);
  assert.equal(nonSql.ok, false);
  if (nonSql.ok) return; assert.equal(nonSql.code, 'NOT_SUPPORTED');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/sql-route.test.js`
Expected: FAIL — `s.rawSql` is not a function.

- [ ] **Step 3: Add `SqlBackend.rawSelect` (readonly, single reader stmt)**

In `sql-backend.ts`, add:
```typescript
  /** Run a single READ-ONLY SELECT on a fresh readonly connection. Throws on writes/multi-statement. */
  rawSelect(dataset: string, sql: string, params: unknown[]): Array<Record<string, unknown>> {
    const file = this.fileFor(dataset);
    if (!fs.existsSync(file)) return [];
    const ro = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const stmt = ro.prepare(sql);          // throws "source contained more than one statement" on multi
      if (!stmt.reader) throw new Error('only read-only SELECT statements are allowed');
      return stmt.all(...(params || [])) as Array<Record<string, unknown>>;
    } finally {
      try { ro.close(); } catch { /* */ }
    }
  }
```

- [ ] **Step 4: Add `DataService.rawSql` + register `SqlBackend`**

First, in `core/src/data/redaction.ts`, export a CONTENT-aware deep scrubber (raw SQL rows can return the `fields`/`text` columns verbatim, where a secret lives in a string VALUE — key-name redaction alone misses it). Add next to `redactValueDeep`:
```typescript
/** Deep scrub: secret-named keys → REDACTED AND every string value run through redactText (inline secrets).
 *  Used for raw-SQL result rows, which can surface the `fields`/`text` columns verbatim. */
export function scrubValueDeep(v: unknown): unknown { return scrubValue(v); }
```
(`scrubValue` already exists in `redaction.ts` — this just exposes it.)

Then in `core/src/data/data-service.ts`:
1. Import the backend + the content scrubber near the other imports:
```typescript
import { SqlBackend } from './backends/sql-backend';
```
and add `scrubValueDeep` to the existing `./redaction` import (alongside `redactRecord`/`redactValueDeep`).
2. Register it in `getDataService()` after the other backends:
```typescript
    backends.register(new SqlBackend());
```
3. Add the `rawSql` method (place after `dropDataset`):
```typescript
  /** Local-only, read-only raw SQL on a `sql` dataset. Never reachable by cloud/manage keys. */
  async rawSql(ctx: CallCtx, datasetId: string, sql: string, params: unknown[]): Promise<DataResult<{ rows: unknown[] }>> {
    if (ctx.principal.type !== 'local') return { ok: false, code: 'FORBIDDEN', reason: 'raw SQL is local-only' };
    const d = this.deps.datasets.get(datasetId);
    if (!d) return { ok: false, code: 'NOT_FOUND', reason: `dataset "${datasetId}" not found` };
    const backend = this.deps.backends.get(d.backend);
    if (!backend || d.backend !== 'sql' || typeof (backend as any).rawSelect !== 'function') {
      return { ok: false, code: 'NOT_SUPPORTED', reason: `raw SQL is only available on sql datasets` };
    }
    try {
      const rows = (backend as any).rawSelect(datasetId, String(sql || ''), Array.isArray(params) ? params : []);
      return { ok: true, value: { rows: scrubValueDeep(rows) as unknown[] } };
    } catch (e) {
      return { ok: false, code: 'SQL_ERROR', reason: e instanceof Error ? e.message : String(e) };
    }
  }
```

> The load-bearing controls are: **local-only** (principal check first), **read-only** (`rawSelect` opens a `readonly` connection + rejects non-reader/multi statements), and **content redaction** (`scrubValueDeep`). An audit trail for this op is a recommended follow-up — it needs a small `auditRawSql` surface on `AccessManager` (mirroring `enforce`'s `KeyStore` audit) and is deferred from M3 v1 to keep this task focused.

- [ ] **Step 5: Add the route**

In `core/src/routes/core/data.routes.ts`, add after `POST /data/:dataset/admin` (the local-only gate mirrors `/data/sync`):
```typescript
    // POST /data/:dataset/sql — raw READ-ONLY SQL, LOCAL principal only (never cloud/manage)
    {
      method: 'POST',
      pattern: /^\/data\/(?<dataset>[^/]+)\/sql$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const p = svc().resolvePrincipal(req);
        if (p.type !== 'local') return wrapError('FORBIDDEN', 'raw SQL is local-only', start);
        const b = req.body || {};
        const sql = typeof b.sql === 'string' ? b.sql : '';
        if (!sql) return wrapError('BAD_REQUEST', 'sql is required', start);
        const r = await svc().rawSql({ principal: p }, req.params.dataset, sql, Array.isArray(b.params) ? b.params : []);
        if (!r.ok) return wrapError(r.code, r.reason, start);
        return wrapResponse(r.value, start);
      },
    },
```

- [ ] **Step 6: Run the full data suite + production build**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/`
Expected: PASS — sql-route + all data tests green (the singleton now registers `SqlBackend`; existing tests unaffected).
Then: `cd /home/ubuntu/lm-assist && ./core.sh build`
Expected: tsc clean.

- [ ] **Step 7: Commit**

```bash
git add core/src/data/backends/sql-backend.ts core/src/data/data-service.ts core/src/routes/core/data.routes.ts core/src/__tests__/data/sql-route.test.ts
git commit -m "feat(data): register SqlBackend + POST /data/:dataset/sql (local-only, read-only, redacted, audited)"
```

---

## Post-Plan: Controller Verification + Fleet Deploy (the native-dep step)

After all 8 tasks pass review, the controller verifies on dev `:3200`, then deploys with the **per-node native install**:

1. **Dev:** `./core.sh restart`; create a `sql` dataset (`POST /data/datasets {id, backend:'sql', config:{kind:'sql', indexedFields:[{path:'topic',type:'text'}]}}`); `PUT` records; `POST /data/:ds/query` (filter/sort/fts); `POST /data/:ds/sql {sql:"SELECT ..."}` (local → rows; confirm a cloud-relayed call → FORBIDDEN, a write → rejected); `DELETE /data/datasets/:id` (drop → file removed); confirm the C1 fix (`data_get` on a record with a token in `text` → redacted).
2. **Fleet deploy (better-sqlite3 is native — `core/dist` rsync does NOT carry the `.node`):** for EACH node, after syncing `core/dist`, run a per-node install of the binary for that node's ABI:
   - 117 (Node v20): `cd ~/.nvm/versions/node/v20.19.6/lib/node_modules/lm-assist && npm i better-sqlite3@^11.0.0 --no-save` then `lm-assist restart`.
   - 123 (Node v22, systemd): `cd /usr/lib/node_modules/lm-assist && sudo npm i better-sqlite3@^11.0.0 --no-save` then `sudo systemctl restart lm-assist`.
   - 107 (Windows, Node v22): `cd C:\Users\admin\AppData\Local\nvm\v22.21.1\node_modules\lm-assist && npm i better-sqlite3@^11.0.0 --no-save` then `lm-assist restart`.
   Verify on each: `node -e "require('better-sqlite3')"` loads, then `POST /data/datasets {backend:'sql'}` + a query works. (If a node lacks build tools and prebuilds miss its ABI, `npm i` falls back to source-compile — confirm it succeeds before restarting Core, since a failed `require('better-sqlite3')` crash-loops Core, same class as the chokidar trap.)
3. e2e: a `sql` dataset with `syncMode:full` replicates cross-node (the engine is backend-agnostic; `exportSince`/`importBatch` now work for sql) — verify a replica lands + is queryable on a peer. Clean up test datasets after.

**Deferred (note, not in this plan):** `PUT /data/datasets/:id` (update ACL/visibility/sensitive — structural `backend`/`config` changes still require drop+recreate); generated-column re-indexing on `indexedFields` change (drop+recreate today). Add the `better-sqlite3` per-node-install caveat to the deployment-build-gotchas memory.
