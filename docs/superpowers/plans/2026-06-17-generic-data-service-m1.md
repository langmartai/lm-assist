# Generic Data Service — M1 (Control Plane + Cache Backend + Sensitivity Guard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working, testable slice of the generic data service — a cache (LMDB) backend, a dataset registry, an access-key manager (request → ACL-gated grant → scoped key → enforce), and an always-on sensitivity guard — exposed over REST, end-to-end on the simplest engine.

**Architecture:** A new `core/src/data/` module. A `StorageBackend` interface with one concrete implementation in M1 (`CacheBackend`, an LMDB-per-dataset compressed object store). A `DatasetRegistry` (JSON file) holds dataset descriptors + per-dataset ACL/visibility/flags. An `AccessManager` resolves the caller's principal (local vs hub-relayed cloud), mints opaque scoped keys into an LMDB `KeyStore` (+ audit), and enforces every data-plane call. A `DataService` facade wires these together and applies redaction on every record that leaves. `data.routes.ts` exposes it. The existing knowledge/vector code is **not touched** in M1.

**Tech Stack:** TypeScript (CommonJS target), `lmdb@^3.5.1` (already a dependency), Node built-in `crypto`, Node built-in `node:test` + `node:assert/strict`. **No new dependencies.**

## Global Constraints

- **Module system is CommonJS** (`core/tsconfig.json` → `"module": "commonjs"`). Use `import x from 'pkg'` / `import * as x from 'pkg'` only for CJS or built-in modules. Do **not** add any ESM-only dependency or use `await import()` of an ESM-only package — tsc downlevels it to `require()` and it throws `ERR_REQUIRE_ESM` at runtime.
- **No new npm dependencies in M1.** Only `lmdb` (already present) and Node built-ins (`crypto`, `fs`, `path`, `os`).
- **Do not modify** `core/src/knowledge/**`, `core/src/vector/**`, or any existing route file except the two explicit edits called out (`core/src/routes/index.ts`, `core/src/routes/core/index.ts`, `core/src/rest-server.ts`, `core/src/project-settings.ts`).
- **Data dir:** all on-disk state lives under `dataRoot()` = `getDataDir()/data${DEV_SUFFIX}` where `DEV_SUFFIX = '-dev'` in the repo and `''` in the npm install (mirror the existing hub-config pattern). Dev and prod must not collide.
- **Tests** live in `core/src/__tests__/data/*.test.ts`, import source via relative paths, use `node:test` + `node:assert/strict`, and write to a `fs.mkdtempSync` temp dir (never the real data dir).
- **Build before test:** `cd core && npm run build:test` compiles `src/**` → `dist-test/`. Run a single suite with `node --test --test-reporter=spec dist-test/__tests__/data/<file>.test.js`.
- **Sensitivity is non-negotiable:** secret-bearing paths are never registrable; secret-named fields are always redacted before leaving the data plane. See Task 1.

---

## File Structure

**Create (all new, under `core/src/data/`):**
- `core/src/data/types.ts` — all shared types + the `StorageBackend` interface (the contract every later task imports).
- `core/src/data/paths.ts` — data-dir resolution with dev/prod suffix + per-artifact path helpers + `thisNodeId()`.
- `core/src/data/redaction.ts` — sensitivity guard: hard-exclusion path check + recursive field redaction.
- `core/src/data/backends/cache-backend.ts` — `CacheBackend implements StorageBackend` over LMDB.
- `core/src/data/dataset-registry.ts` — descriptor CRUD persisted to `datasets.json`.
- `core/src/data/key-store.ts` — LMDB-backed `AccessKey` persistence + append-only audit.
- `core/src/data/access-manager.ts` — principal resolution, grant evaluation, key issuance, enforcement.
- `core/src/data/data-service.ts` — facade wiring registry + backends + manager; applies redaction; kill-switch.
- `core/src/data/backend-registry.ts` — `BackendKind → StorageBackend` map.
- `core/src/routes/core/data.routes.ts` — REST surface.
- `core/src/__tests__/data/*.test.ts` — one test file per task.

**Modify (surgical, additive):**
- `core/src/routes/index.ts` — add optional `headers` to `ParsedRequest` (Task 5).
- `core/src/rest-server.ts` — populate `headers` in `parseRequest()` (Task 7).
- `core/src/routes/core/index.ts` — register `createDataRoutes` (Task 7).
- `core/src/project-settings.ts` — add `dataServiceEnabled` flag (Task 6).

---

## Task 1: Types, paths, and the sensitivity guard

**Files:**
- Create: `core/src/data/types.ts`
- Create: `core/src/data/paths.ts`
- Create: `core/src/data/redaction.ts`
- Test: `core/src/__tests__/data/redaction.test.ts`

**Interfaces:**
- Produces (consumed by every later task):
  - Types in `types.ts`: `BackendKind`, `DataAction`, `NodeVisibility`, `PrincipalType`, `Principal`, `NodeOrigin`, `AclRule`, `BackendConfig`, `DatasetDescriptor`, `DataRecord`, `QueryFilter`, `QuerySpec`, `SearchSpec`, `Grant`, `AccessKey`, `AccessRequest`, and `interface StorageBackend`.
  - `paths.ts`: `dataRoot(): string`, `datasetsFile(): string`, `keysDir(): string`, `cacheDirFor(id: string): string`, `thisNodeId(): string`.
  - `redaction.ts`: `isHardExcludedPath(p: string): boolean`, `redactRecord(rec: DataRecord): DataRecord`, `REDACTED: string`.

- [ ] **Step 1: Write `core/src/data/types.ts`** (pure declarations — no test of its own; it is the shared contract)

```typescript
// core/src/data/types.ts
// Shared contracts for the generic data service. CommonJS-safe (types only).

export type BackendKind = 'vector' | 'sql' | 'cache';
export type DataAction = 'read' | 'query' | 'search' | 'write' | 'delete' | 'manage';
export type NodeVisibility = 'local-only' | 'synced' | 'cross-node-readable';
export type PrincipalType = 'local' | 'cloud';

export interface Principal {
  type: PrincipalType;
  userId?: string; // present for cloud principals when the hub supplies one
}

export interface NodeOrigin {
  machineId: string;
  hostname: string;
  os: string;
}

export interface AclRule {
  // a principal class, a specific cloud user, or any authed caller
  principal: PrincipalType | { userId: string } | '*';
  actions: DataAction[];
}

export interface CacheConfig { kind: 'cache'; }
export interface VectorConfig { kind: 'vector'; } // v1 placeholder (M2)
export interface SqlConfig {
  kind: 'sql';
  indexedFields?: Array<{ path: string; type: 'text' | 'number' }>; // M3
}
export type BackendConfig = CacheConfig | VectorConfig | SqlConfig;

export interface DatasetDescriptor {
  id: string;                 // ^[a-z0-9][a-z0-9_-]{0,63}$
  backend: BackendKind;
  title?: string;
  ownerNode: string;          // machineId that owns it
  visibility: NodeVisibility; // governs CLOUD principals
  system?: boolean;           // reserved datasets (M2) — not user-deletable
  readOnly?: boolean;         // HARD cap to read/query/search for EVERY principal
  sensitive?: boolean;        // never exposed to cloud; never synced
  config: BackendConfig;
  acl: AclRule[];
  createdAt: string;
  updatedAt: string;
}

export interface DataRecord {
  id: string;
  fields: Record<string, unknown>;
  text?: string;
  metadata?: Record<string, unknown>;
  origin?: NodeOrigin;        // stamped on sync landing (M5); absent = local
  createdAt: string;
  updatedAt: string;
}

export interface QueryFilter {
  field: string;
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';
  value: unknown;
}
export interface QuerySpec {
  filter?: QueryFilter[];
  fts?: string;
  sort?: Array<{ field: string; dir: 'asc' | 'desc' }>;
  limit?: number;
  offset?: number;
}
export interface SearchSpec { query: string; limit?: number; filter?: QueryFilter[]; }

export interface Grant { dataset: string; actions: DataAction[]; }

export interface AccessKey {
  keyId: string;
  secretHash: string;         // sha256 hex of the secret; secret itself is never stored
  principalType: PrincipalType;
  principalId?: string;
  node: string;               // machineId this key is valid on
  grants: Grant[];
  label?: string;             // requester's stated intent (audited)
  issuedAt: string;
  expiresAt: string;
  revoked?: boolean;
}

export interface AccessRequest {
  intent?: string;
  grants: Array<{ dataset: string; actions: DataAction[] }>;
  ttlSeconds?: number;
}

// M1 backend contract. Sync hooks (exportSince/importBatch) are added in M5.
export interface StorageBackend {
  readonly kind: BackendKind;
  createDataset(d: DatasetDescriptor): Promise<void>;
  dropDataset(id: string): Promise<void>;
  put(dataset: string, record: DataRecord): Promise<{ id: string }>;
  get(dataset: string, id: string): Promise<DataRecord | null>;
  query(dataset: string, q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }>;
  search?(dataset: string, s: SearchSpec): Promise<Array<DataRecord & { score: number }>>;
  delete(dataset: string, id: string): Promise<boolean>;
}
```

- [ ] **Step 2: Write `core/src/data/paths.ts`**

```typescript
// core/src/data/paths.ts
import * as os from 'os';
import * as path from 'path';
import { getDataDir } from '../utils/path-utils';

// Mirror the hub-config dev/prod split so dev (repo) and prod (npm) never collide.
const IS_DEV_REPO = process.env.LM_ASSIST_PROD === 'true' ? false : !__dirname.includes('node_modules');
const DEV_SUFFIX = IS_DEV_REPO ? '-dev' : '';

export function dataRoot(): string {
  return path.join(getDataDir(), `data${DEV_SUFFIX}`);
}
export function datasetsFile(): string {
  return path.join(dataRoot(), 'datasets.json');
}
export function keysDir(): string {
  return path.join(dataRoot(), 'keys.lmdb');
}
export function cacheDirFor(datasetId: string): string {
  return path.join(dataRoot(), 'cache', `${datasetId}.lmdb`);
}
// M1 node identity: stable per host. M5 will unify this with the canonical machineId
// used by the knowledge/vector remote-sync layer.
export function thisNodeId(): string {
  return os.hostname() || 'local';
}
```

- [ ] **Step 3: Write the failing test** `core/src/__tests__/data/redaction.test.ts`

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import { isHardExcludedPath, redactRecord, REDACTED } from '../../data/redaction';
import type { DataRecord } from '../../data/types';

test('isHardExcludedPath: blocks credential + secret-bearing paths', () => {
  const home = os.homedir();
  assert.equal(isHardExcludedPath(path.join(home, '.claude', '.credentials.json')), true);
  assert.equal(isHardExcludedPath(path.join(home, '.lm-assist', 'hub.json')), true);
  assert.equal(isHardExcludedPath(path.join(home, '.lm-assist', 'hub-dev.json')), true);
  assert.equal(isHardExcludedPath(path.join(home, '.claude', 'claudeai-session.json')), true);
  assert.equal(isHardExcludedPath(path.join(home, 'project', '.env')), true);
  assert.equal(isHardExcludedPath(path.join(home, '.lm-assist', 'api-token')), true);
});

test('isHardExcludedPath: allows ordinary paths', () => {
  const home = os.homedir();
  assert.equal(isHardExcludedPath(path.join(home, 'notes', 'todo.md')), false);
  assert.equal(isHardExcludedPath(path.join(home, '.lm-assist', 'data', 'cache', 'x.lmdb')), false);
});

test('redactRecord: scrubs secret-named fields recursively, leaves others', () => {
  const rec: DataRecord = {
    id: 'r1',
    fields: {
      name: 'ok',
      apiKey: 'sk-123',
      nested: { password: 'p', authorization: 'Bearer z', keep: 'visible' },
      list: [{ token: 't1' }, { plain: 'p1' }],
    },
    metadata: { cookie: 'c=1', note: 'fine' },
    createdAt: 't', updatedAt: 't',
  };
  const out = redactRecord(rec);
  assert.equal(out.fields.name, 'ok');
  assert.equal(out.fields.apiKey, REDACTED);
  assert.equal((out.fields.nested as any).password, REDACTED);
  assert.equal((out.fields.nested as any).authorization, REDACTED);
  assert.equal((out.fields.nested as any).keep, 'visible');
  assert.equal((out.fields.list as any)[0].token, REDACTED);
  assert.equal((out.fields.list as any)[1].plain, 'p1');
  assert.equal((out.metadata as any).cookie, REDACTED);
  assert.equal((out.metadata as any).note, 'fine');
  // input is not mutated
  assert.equal(rec.fields.apiKey, 'sk-123');
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd core && npm run build:test`
Expected: build FAILS (`Cannot find module '../../data/redaction'`) — that confirms the test targets unwritten code.

- [ ] **Step 5: Write `core/src/data/redaction.ts`**

```typescript
// core/src/data/redaction.ts
import * as os from 'os';
import * as path from 'path';
import type { DataRecord } from './types';

export const REDACTED = '«redacted»';

const SECRET_KEY_RE = /(token|secret|password|api[-_]?key|cookie|credential|authorization|private[-_]?key)/i;

const home = os.homedir();
const HARD_EXCLUDED = new Set(
  [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.lm-assist', 'hub.json'),
    path.join(home, '.lm-assist', 'hub-dev.json'),
    path.join(home, '.claude', 'claudeai-session.json'),
  ].map((p) => path.resolve(p)),
);

/** A path that holds secrets and must never be registered or tracked as a dataset. */
export function isHardExcludedPath(p: string): boolean {
  const norm = path.resolve(p);
  if (HARD_EXCLUDED.has(norm)) return true;
  const base = path.basename(norm);
  if (base === '.env' || base === 'api-token') return true;
  // the access-key store itself
  if (base.startsWith('keys.lmdb')) return true;
  return false;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redactValue(v);
    }
    return out;
  }
  return value;
}

/** Deep-clone the record with any secret-named field values replaced by REDACTED. */
export function redactRecord(rec: DataRecord): DataRecord {
  return {
    ...rec,
    fields: redactValue(rec.fields) as Record<string, unknown>,
    metadata: rec.metadata ? (redactValue(rec.metadata) as Record<string, unknown>) : rec.metadata,
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/data/redaction.test.js`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add core/src/data/types.ts core/src/data/paths.ts core/src/data/redaction.ts core/src/__tests__/data/redaction.test.ts
git commit -m "feat(data): M1 types, path helpers, and sensitivity-guard (redaction + hard-exclusion)"
```

---

## Task 2: Cache backend (LMDB, compressed)

**Files:**
- Create: `core/src/data/backends/cache-backend.ts`
- Test: `core/src/__tests__/data/cache-backend.test.ts`

**Interfaces:**
- Consumes: `StorageBackend`, `DatasetDescriptor`, `DataRecord`, `QuerySpec`, `QueryFilter` from `../types`; `cacheDirFor` from `../paths`.
- Produces: `class CacheBackend implements StorageBackend` with `constructor(baseDirOverride?: string)`; `readonly kind = 'cache'`. Used by the backend registry (Task 6).

- [ ] **Step 1: Write the failing test** `core/src/__tests__/data/cache-backend.test.ts`

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { CacheBackend } from '../../data/backends/cache-backend';
import type { DatasetDescriptor, DataRecord } from '../../data/types';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'lm-cache-')); }
function descriptor(id: string): DatasetDescriptor {
  return { id, backend: 'cache', ownerNode: 'n', visibility: 'local-only',
    config: { kind: 'cache' }, acl: [], createdAt: 't', updatedAt: 't' };
}
function rec(id: string, fields: Record<string, unknown>, text?: string): DataRecord {
  return { id, fields, text, createdAt: 't', updatedAt: 't' };
}

test('cache backend: put/get round-trip', async () => {
  const be = new CacheBackend(tmp());
  await be.createDataset(descriptor('d1'));
  await be.put('d1', rec('a', { n: 1, name: 'alice' }));
  const got = await be.get('d1', 'a');
  assert.equal(got?.id, 'a');
  assert.equal(got?.fields.name, 'alice');
  assert.equal(await be.get('d1', 'missing'), null);
});

test('cache backend: query filter + limit', async () => {
  const be = new CacheBackend(tmp());
  await be.createDataset(descriptor('d2'));
  await be.put('d2', rec('a', { tag: 'x', n: 1 }));
  await be.put('d2', rec('b', { tag: 'y', n: 2 }));
  await be.put('d2', rec('c', { tag: 'x', n: 3 }));
  const r = await be.query('d2', { filter: [{ field: 'tag', op: 'eq', value: 'x' }] });
  assert.deepEqual(r.records.map((x) => x.id).sort(), ['a', 'c']);
  const lim = await be.query('d2', { limit: 2 });
  assert.equal(lim.records.length, 2);
});

test('cache backend: delete', async () => {
  const be = new CacheBackend(tmp());
  await be.createDataset(descriptor('d3'));
  await be.put('d3', rec('a', {}));
  assert.equal(await be.delete('d3', 'a'), true);
  assert.equal(await be.get('d3', 'a'), null);
  assert.equal(await be.delete('d3', 'a'), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd core && npm run build:test`
Expected: build FAILS (`Cannot find module '../../data/backends/cache-backend'`).

- [ ] **Step 3: Write `core/src/data/backends/cache-backend.ts`**

```typescript
// core/src/data/backends/cache-backend.ts
import { open, RootDatabase, Database } from 'lmdb';
import * as fs from 'fs';
import * as path from 'path';
import type {
  StorageBackend, BackendKind, DatasetDescriptor, DataRecord, QuerySpec, QueryFilter,
} from '../types';
import { cacheDirFor } from '../paths';

interface Env { root: RootDatabase; db: Database<DataRecord, string>; }

function getField(rec: DataRecord, field: string): unknown {
  if (field in rec.fields) return rec.fields[field];
  if (rec.metadata && field in rec.metadata) return rec.metadata[field];
  return (rec as unknown as Record<string, unknown>)[field];
}

function matches(rec: DataRecord, f: QueryFilter): boolean {
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

export class CacheBackend implements StorageBackend {
  readonly kind: BackendKind = 'cache';
  private envs = new Map<string, Env>();
  private baseDirOverride?: string;

  constructor(baseDirOverride?: string) { this.baseDirOverride = baseDirOverride; }

  private dirFor(id: string): string {
    return this.baseDirOverride ? path.join(this.baseDirOverride, `${id}.lmdb`) : cacheDirFor(id);
  }

  private envFor(id: string): Env {
    let e = this.envs.get(id);
    if (e) return e;
    const dir = this.dirFor(id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const root = open({ path: dir, compression: true, maxDbs: 1, mapSize: 512 * 1024 * 1024 });
    const db = root.openDB('records', { encoding: 'msgpack' }) as Database<DataRecord, string>;
    e = { root, db };
    this.envs.set(id, e);
    return e;
  }

  async createDataset(d: DatasetDescriptor): Promise<void> { this.envFor(d.id); }

  async dropDataset(id: string): Promise<void> {
    const e = this.envs.get(id);
    if (e) { e.root.close(); this.envs.delete(id); }
    const dir = this.dirFor(id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }

  async put(dataset: string, record: DataRecord): Promise<{ id: string }> {
    await this.envFor(dataset).db.put(record.id, record);
    return { id: record.id };
  }

  async get(dataset: string, id: string): Promise<DataRecord | null> {
    return this.envFor(dataset).db.get(id) ?? null;
  }

  async query(dataset: string, q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }> {
    const { db } = this.envFor(dataset);
    let rows: DataRecord[] = [];
    for (const { value } of db.getRange()) rows.push(value as DataRecord);
    if (q.filter?.length) rows = rows.filter((r) => q.filter!.every((f) => matches(r, f)));
    if (q.sort?.length) {
      const s = q.sort;
      rows.sort((a, b) => {
        for (const { field, dir } of s) {
          const av = getField(a, field) as any, bv = getField(b, field) as any;
          if (av < bv) return dir === 'asc' ? -1 : 1;
          if (av > bv) return dir === 'asc' ? 1 : -1;
        }
        return 0;
      });
    }
    const total = rows.length;
    const offset = q.offset ?? 0;
    const limit = q.limit ?? rows.length;
    return { records: rows.slice(offset, offset + limit), total };
  }

  async delete(dataset: string, id: string): Promise<boolean> {
    const { db } = this.envFor(dataset);
    if (db.get(id) === undefined) return false;
    await db.remove(id);
    return true;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/data/cache-backend.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/data/backends/cache-backend.ts core/src/__tests__/data/cache-backend.test.ts
git commit -m "feat(data): LMDB compressed cache backend (put/get/query/delete)"
```

---

## Task 3: Dataset registry

**Files:**
- Create: `core/src/data/dataset-registry.ts`
- Test: `core/src/__tests__/data/dataset-registry.test.ts`

**Interfaces:**
- Consumes: `DatasetDescriptor`, `BackendKind`, `BackendConfig`, `AclRule`, `NodeVisibility` from `../types`; `datasetsFile` from `../paths`; `thisNodeId` from `../paths`.
- Produces:
  - `class DatasetRegistry` with `constructor(fileOverride?: string)`, methods `list(): DatasetDescriptor[]`, `get(id: string): DatasetDescriptor | undefined`, `create(input: CreateDatasetInput): DatasetDescriptor`, `update(id: string, patch: Partial<Pick<DatasetDescriptor,'title'|'visibility'|'readOnly'|'sensitive'|'acl'>>): DatasetDescriptor`, `drop(id: string): boolean`.
  - `interface CreateDatasetInput { id: string; backend: BackendKind; title?: string; visibility?: NodeVisibility; readOnly?: boolean; sensitive?: boolean; config: BackendConfig; acl?: AclRule[]; system?: boolean; }`
  - `getDatasetRegistry(): DatasetRegistry` singleton.
  - `const DATASET_ID_RE: RegExp`.

- [ ] **Step 1: Write the failing test** `core/src/__tests__/data/dataset-registry.test.ts`

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { DatasetRegistry } from '../../data/dataset-registry';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-reg-'));
  return path.join(dir, 'datasets.json');
}

test('registry: create, get, list, persists across instances', () => {
  const file = tmpFile();
  const r = new DatasetRegistry(file);
  const d = r.create({ id: 'tickets', backend: 'cache', config: { kind: 'cache' } });
  assert.equal(d.id, 'tickets');
  assert.equal(d.visibility, 'local-only'); // default
  assert.equal(d.ownerNode.length > 0, true);
  assert.equal(r.get('tickets')?.backend, 'cache');
  // a fresh instance reads the same file
  const r2 = new DatasetRegistry(file);
  assert.equal(r2.list().length, 1);
  assert.equal(r2.get('tickets')?.id, 'tickets');
});

test('registry: rejects bad ids and duplicates', () => {
  const r = new DatasetRegistry(tmpFile());
  assert.throws(() => r.create({ id: 'Bad Id', backend: 'cache', config: { kind: 'cache' } }), /id/i);
  assert.throws(() => r.create({ id: '../escape', backend: 'cache', config: { kind: 'cache' } }), /id/i);
  r.create({ id: 'ok', backend: 'cache', config: { kind: 'cache' } });
  assert.throws(() => r.create({ id: 'ok', backend: 'cache', config: { kind: 'cache' } }), /exists/i);
});

test('registry: update and drop', () => {
  const r = new DatasetRegistry(tmpFile());
  r.create({ id: 'd', backend: 'cache', config: { kind: 'cache' } });
  const u = r.update('d', { visibility: 'synced', readOnly: true });
  assert.equal(u.visibility, 'synced');
  assert.equal(u.readOnly, true);
  assert.equal(r.drop('d'), true);
  assert.equal(r.get('d'), undefined);
  assert.equal(r.drop('d'), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd core && npm run build:test`
Expected: build FAILS (`Cannot find module '../../data/dataset-registry'`).

- [ ] **Step 3: Write `core/src/data/dataset-registry.ts`**

```typescript
// core/src/data/dataset-registry.ts
import * as fs from 'fs';
import * as path from 'path';
import type {
  DatasetDescriptor, BackendKind, BackendConfig, AclRule, NodeVisibility,
} from './types';
import { datasetsFile, thisNodeId } from './paths';

export const DATASET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface CreateDatasetInput {
  id: string;
  backend: BackendKind;
  title?: string;
  visibility?: NodeVisibility;
  readOnly?: boolean;
  sensitive?: boolean;
  config: BackendConfig;
  acl?: AclRule[];
  system?: boolean;
}

export class DatasetRegistry {
  private file: string;
  private cache: DatasetDescriptor[] | null = null;
  private mtime = 0;

  constructor(fileOverride?: string) { this.file = fileOverride || datasetsFile(); }

  private load(): DatasetDescriptor[] {
    try {
      if (!fs.existsSync(this.file)) return [];
      const stat = fs.statSync(this.file);
      if (this.cache && stat.mtimeMs === this.mtime) return this.cache;
      const data = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      const arr: DatasetDescriptor[] = Array.isArray(data) ? data : [];
      this.cache = arr;
      this.mtime = stat.mtimeMs;
      return arr;
    } catch {
      return this.cache ?? [];
    }
  }

  private save(arr: DatasetDescriptor[]): void {
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(arr, null, 2));
    this.cache = arr;
    this.mtime = fs.statSync(this.file).mtimeMs;
  }

  list(): DatasetDescriptor[] { return this.load().map((d) => ({ ...d })); }

  get(id: string): DatasetDescriptor | undefined {
    const d = this.load().find((x) => x.id === id);
    return d ? { ...d } : undefined;
  }

  create(input: CreateDatasetInput): DatasetDescriptor {
    if (!DATASET_ID_RE.test(input.id)) {
      throw new Error(`invalid dataset id "${input.id}" (must match ${DATASET_ID_RE})`);
    }
    const arr = this.load();
    if (arr.some((d) => d.id === input.id)) throw new Error(`dataset "${input.id}" already exists`);
    const now = new Date().toISOString();
    const d: DatasetDescriptor = {
      id: input.id,
      backend: input.backend,
      title: input.title,
      ownerNode: thisNodeId(),
      visibility: input.visibility ?? 'local-only',
      system: input.system,
      readOnly: input.readOnly,
      sensitive: input.sensitive,
      config: input.config,
      acl: input.acl ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.save([...arr, d]);
    return { ...d };
  }

  update(id: string, patch: Partial<Pick<DatasetDescriptor, 'title' | 'visibility' | 'readOnly' | 'sensitive' | 'acl'>>): DatasetDescriptor {
    const arr = this.load();
    const idx = arr.findIndex((d) => d.id === id);
    if (idx < 0) throw new Error(`dataset "${id}" not found`);
    const updated: DatasetDescriptor = { ...arr[idx], ...patch, updatedAt: new Date().toISOString() };
    const next = [...arr];
    next[idx] = updated;
    this.save(next);
    return { ...updated };
  }

  drop(id: string): boolean {
    const arr = this.load();
    const next = arr.filter((d) => d.id !== id);
    if (next.length === arr.length) return false;
    this.save(next);
    return true;
  }
}

let instance: DatasetRegistry | null = null;
export function getDatasetRegistry(): DatasetRegistry {
  if (!instance) instance = new DatasetRegistry();
  return instance;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/data/dataset-registry.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/data/dataset-registry.ts core/src/__tests__/data/dataset-registry.test.ts
git commit -m "feat(data): dataset registry (descriptor CRUD, id validation, persistence)"
```

---

## Task 4: Key store (LMDB, with audit)

**Files:**
- Create: `core/src/data/key-store.ts`
- Test: `core/src/__tests__/data/key-store.test.ts`

**Interfaces:**
- Consumes: `AccessKey`, `PrincipalType`, `DataAction` from `./types`; `keysDir` from `./paths`.
- Produces:
  - `interface AuditEntry { at: string; event: 'issue' | 'use' | 'revoke' | 'deny'; keyId?: string; principalType: PrincipalType; principalId?: string; dataset?: string; action?: DataAction; detail?: string; }`
  - `class KeyStore` with `constructor(dirOverride?: string)`, `put(key: AccessKey): Promise<void>`, `get(keyId: string): AccessKey | undefined`, `revoke(keyId: string): Promise<boolean>`, `appendAudit(e: AuditEntry): Promise<void>`, `listAudit(): AuditEntry[]`, `close(): void`.
  - `getKeyStore(): KeyStore` singleton.

- [ ] **Step 1: Write the failing test** `core/src/__tests__/data/key-store.test.ts`

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { KeyStore } from '../../data/key-store';
import type { AccessKey } from '../../data/types';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'lm-keys-')); }
function key(id: string): AccessKey {
  return { keyId: id, secretHash: 'h', principalType: 'cloud', node: 'n',
    grants: [{ dataset: 'd', actions: ['read'] }], issuedAt: 't', expiresAt: 't' };
}

test('key store: put/get/revoke', async () => {
  const ks = new KeyStore(tmp());
  await ks.put(key('k1'));
  assert.equal(ks.get('k1')?.keyId, 'k1');
  assert.equal(ks.get('nope'), undefined);
  assert.equal(await ks.revoke('k1'), true);
  assert.equal(ks.get('k1')?.revoked, true);
  assert.equal(await ks.revoke('nope'), false);
});

test('key store: audit append + list', async () => {
  const ks = new KeyStore(tmp());
  await ks.appendAudit({ at: '2026-01-01T00:00:00Z', event: 'issue', keyId: 'k1', principalType: 'local' });
  await ks.appendAudit({ at: '2026-01-01T00:00:01Z', event: 'deny', principalType: 'cloud', dataset: 'd', action: 'write' });
  const log = ks.listAudit();
  assert.equal(log.length, 2);
  assert.equal(log[0].event, 'issue');
  assert.equal(log[1].action, 'write');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd core && npm run build:test`
Expected: build FAILS (`Cannot find module '../../data/key-store'`).

- [ ] **Step 3: Write `core/src/data/key-store.ts`**

```typescript
// core/src/data/key-store.ts
import { open, RootDatabase, Database } from 'lmdb';
import * as crypto from 'crypto';
import * as fs from 'fs';
import type { AccessKey, PrincipalType, DataAction } from './types';
import { keysDir } from './paths';

export interface AuditEntry {
  at: string;
  event: 'issue' | 'use' | 'revoke' | 'deny';
  keyId?: string;
  principalType: PrincipalType;
  principalId?: string;
  dataset?: string;
  action?: DataAction;
  detail?: string;
}

export class KeyStore {
  private env: RootDatabase;
  private keys: Database<AccessKey, string>;
  private audit: Database<AuditEntry, string>;
  private _closed = false;

  constructor(dirOverride?: string) {
    const dir = dirOverride || keysDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.env = open({ path: dir, compression: true, maxDbs: 2, mapSize: 256 * 1024 * 1024 });
    this.keys = this.env.openDB('keys', { encoding: 'msgpack' }) as Database<AccessKey, string>;
    this.audit = this.env.openDB('audit', { encoding: 'msgpack' }) as Database<AuditEntry, string>;
  }

  async put(key: AccessKey): Promise<void> { await this.keys.put(key.keyId, key); }

  get(keyId: string): AccessKey | undefined { return this.keys.get(keyId); }

  async revoke(keyId: string): Promise<boolean> {
    const k = this.keys.get(keyId);
    if (!k) return false;
    await this.keys.put(keyId, { ...k, revoked: true });
    return true;
  }

  async appendAudit(e: AuditEntry): Promise<void> {
    // monotonic-ish key: timestamp + random suffix avoids collisions within the same ms
    await this.audit.put(`${e.at}-${crypto.randomUUID()}`, e);
  }

  listAudit(): AuditEntry[] {
    const out: AuditEntry[] = [];
    for (const { value } of this.audit.getRange()) out.push(value as AuditEntry);
    return out;
  }

  close(): void { if (!this._closed) { this._closed = true; this.env.close(); } }
}

let instance: KeyStore | null = null;
export function getKeyStore(): KeyStore {
  if (!instance) instance = new KeyStore();
  return instance;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/data/key-store.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/data/key-store.ts core/src/__tests__/data/key-store.test.ts
git commit -m "feat(data): LMDB key store with audit log"
```

---

## Task 5: Access manager (principal, grants, issue, enforce)

**Files:**
- Modify: `core/src/routes/index.ts` (add optional `headers` to `ParsedRequest`)
- Create: `core/src/data/access-manager.ts`
- Test: `core/src/__tests__/data/access-manager.test.ts`

**Interfaces:**
- Consumes: `DatasetRegistry` (Task 3), `KeyStore` (Task 4), all types from `./types`, `ParsedRequest` from `../routes/index`.
- Produces:
  - `type IssueResult = { ok: true; key: string; keyId: string; grants: Grant[]; expiresAt: string } | { ok: false; reason: string };`
  - `type EnforceResult = { ok: true; principal: Principal } | { ok: false; code: string; status: number; reason: string };`
  - `class AccessManager` with `constructor(deps: { datasets: DatasetRegistry; keys: KeyStore; nodeId: string })` and methods:
    - `resolvePrincipal(req: ParsedRequest): Principal`
    - `evaluateGrants(p: Principal, d: DatasetDescriptor, requested: DataAction[]): DataAction[]`
    - `requestAccess(p: Principal, req: AccessRequest): Promise<IssueResult>`
    - `enforce(p: Principal, keyHeader: string | undefined, d: DatasetDescriptor, action: DataAction): Promise<EnforceResult>`

- [ ] **Step 1: Add `headers` to `ParsedRequest`**

In `core/src/routes/index.ts`, modify the `ParsedRequest` interface to add the optional `headers` field (additive — existing handlers unaffected):

```typescript
export interface ParsedRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: any;
  /** Lower-cased HTTP headers (populated by the server). */
  headers?: Record<string, string | string[] | undefined>;
  /** Client IP address from the TCP connection */
  clientIp?: string;
  raw?: {
    req: any;
    res: any;
  };
}
```

- [ ] **Step 2: Write the failing test** `core/src/__tests__/data/access-manager.test.ts`

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AccessManager } from '../../data/access-manager';
import { DatasetRegistry } from '../../data/dataset-registry';
import { KeyStore } from '../../data/key-store';
import type { ParsedRequest } from '../../routes/index';
import type { DatasetDescriptor } from '../../data/types';

function deps() {
  const regFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-am-reg-')), 'd.json');
  const keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-am-keys-'));
  const datasets = new DatasetRegistry(regFile);
  const keys = new KeyStore(keysDir);
  return { mgr: new AccessManager({ datasets, keys, nodeId: 'n1' }), datasets, keys };
}
function req(headers: Record<string, string>): ParsedRequest {
  return { method: 'GET', path: '/', params: {}, query: {}, body: undefined, headers };
}

test('resolvePrincipal: relayed = cloud, direct = local', () => {
  const { mgr } = deps();
  assert.equal(mgr.resolvePrincipal(req({ 'x-relay-source': 'hub' })).type, 'cloud');
  assert.equal(mgr.resolvePrincipal(req({})).type, 'local');
  const p = mgr.resolvePrincipal(req({ 'x-relay-source': 'hub', 'x-lm-user-id': 'u9' }));
  assert.equal(p.userId, 'u9');
});

test('evaluateGrants: local root vs cloud ACL/visibility/readOnly/sensitive', () => {
  const { mgr } = deps();
  const base: DatasetDescriptor = {
    id: 'd', backend: 'cache', ownerNode: 'n1', visibility: 'cross-node-readable',
    config: { kind: 'cache' }, acl: [{ principal: 'cloud', actions: ['read', 'query'] }],
    createdAt: 't', updatedAt: 't',
  };
  // local is root: gets whatever it asks
  assert.deepEqual(mgr.evaluateGrants({ type: 'local' }, base, ['read', 'write', 'delete']).sort(),
    ['delete', 'read', 'write']);
  // cloud limited by ACL
  assert.deepEqual(mgr.evaluateGrants({ type: 'cloud' }, base, ['read', 'write']).sort(), ['read']);
  // cloud blocked entirely when local-only
  assert.deepEqual(mgr.evaluateGrants({ type: 'cloud' }, { ...base, visibility: 'local-only' }, ['read']), []);
  // readOnly hard-caps even local root
  assert.deepEqual(mgr.evaluateGrants({ type: 'local' }, { ...base, readOnly: true }, ['read', 'write']), ['read']);
  // sensitive blocks cloud, allows local
  assert.deepEqual(mgr.evaluateGrants({ type: 'cloud' }, { ...base, sensitive: true }, ['read']), []);
  assert.deepEqual(mgr.evaluateGrants({ type: 'local' }, { ...base, sensitive: true }, ['read']), ['read']);
});

test('requestAccess: mints a usable key; enforce accepts it', async () => {
  const { mgr, datasets } = deps();
  datasets.create({ id: 'tickets', backend: 'cache', visibility: 'cross-node-readable',
    config: { kind: 'cache' }, acl: [{ principal: 'cloud', actions: ['read', 'query'] }] });
  const cloud = { type: 'cloud' as const, userId: 'u1' };
  const issued = await mgr.requestAccess(cloud, { intent: 'read tickets', grants: [{ dataset: 'tickets', actions: ['read', 'write'] }] });
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  assert.deepEqual(issued.grants[0].actions.sort(), ['read']); // write dropped by ACL
  const d = datasets.get('tickets')!;
  assert.equal((await mgr.enforce(cloud, issued.key, d, 'read')).ok, true);
  assert.equal((await mgr.enforce(cloud, issued.key, d, 'write')).ok, false); // not granted
});

test('requestAccess: empty grant set is denied', async () => {
  const { mgr, datasets } = deps();
  datasets.create({ id: 'priv', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [] });
  const res = await mgr.requestAccess({ type: 'cloud', userId: 'u1' }, { grants: [{ dataset: 'priv', actions: ['read'] }] });
  assert.equal(res.ok, false);
});

test('enforce: local fast-path (no key) allowed; cloud needs key', async () => {
  const { mgr, datasets } = deps();
  datasets.create({ id: 'd', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [] });
  const d = datasets.get('d')!;
  assert.equal((await mgr.enforce({ type: 'local' }, undefined, d, 'write')).ok, true);
  const denied = await mgr.enforce({ type: 'cloud', userId: 'u' }, undefined, d, 'read');
  assert.equal(denied.ok, false);
});

test('enforce: expired and revoked keys rejected', async () => {
  const { mgr, datasets, keys } = deps();
  datasets.create({ id: 'd', backend: 'cache', visibility: 'cross-node-readable',
    config: { kind: 'cache' }, acl: [{ principal: 'cloud', actions: ['read'] }] });
  const d = datasets.get('d')!;
  // craft an already-expired key directly
  const crypto = require('crypto');
  const secret = 'abc';
  const keyId = 'kx';
  await keys.put({ keyId, secretHash: crypto.createHash('sha256').update(secret).digest('hex'),
    principalType: 'cloud', principalId: 'u', node: 'n1', grants: [{ dataset: 'd', actions: ['read'] }],
    issuedAt: '2000-01-01T00:00:00Z', expiresAt: '2000-01-01T00:00:00Z' });
  const expired = await mgr.enforce({ type: 'cloud', userId: 'u' }, `${keyId}.${secret}`, d, 'read');
  assert.equal(expired.ok, false);
  assert.equal(expired.ok ? '' : expired.code, 'KEY_EXPIRED');
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd core && npm run build:test`
Expected: build FAILS (`Cannot find module '../../data/access-manager'`).

- [ ] **Step 4: Write `core/src/data/access-manager.ts`**

```typescript
// core/src/data/access-manager.ts
import * as crypto from 'crypto';
import type {
  Principal, DatasetDescriptor, DataAction, AccessKey, AccessRequest, Grant, AclRule,
} from './types';
import type { DatasetRegistry } from './dataset-registry';
import type { KeyStore } from './key-store';
import type { ParsedRequest } from '../routes/index';

const READ_ONLY_ACTIONS: DataAction[] = ['read', 'query', 'search'];
const TTL_DEFAULT = 3600;       // 1h
const TTL_MAX = 24 * 3600;      // 24h
const TTL_MIN = 60;

export type IssueResult =
  | { ok: true; key: string; keyId: string; grants: Grant[]; expiresAt: string }
  | { ok: false; reason: string };

export type EnforceResult =
  | { ok: true; principal: Principal }
  | { ok: false; code: string; status: number; reason: string };

function header(req: ParsedRequest, name: string): string | undefined {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

function principalMatches(rule: AclRule['principal'], p: Principal): boolean {
  if (rule === '*') return true;
  if (typeof rule === 'string') return rule === p.type;
  return p.type === 'cloud' && p.userId === rule.userId;
}

export class AccessManager {
  constructor(private deps: { datasets: DatasetRegistry; keys: KeyStore; nodeId: string }) {}

  resolvePrincipal(req: ParsedRequest): Principal {
    // The hub relay marks every relayed call with `x-relay-source: hub` (see api-relay-handler).
    if (header(req, 'x-relay-source') === 'hub') {
      return { type: 'cloud', userId: header(req, 'x-lm-user-id') };
    }
    return { type: 'local' };
  }

  evaluateGrants(p: Principal, d: DatasetDescriptor, requested: DataAction[]): DataAction[] {
    let allowed = new Set<DataAction>(requested);
    if (p.type === 'cloud') {
      // ACL intersection
      const aclActions = new Set<DataAction>();
      for (const rule of d.acl) {
        if (principalMatches(rule.principal, p)) rule.actions.forEach((a) => aclActions.add(a));
      }
      allowed = new Set([...allowed].filter((a) => aclActions.has(a)));
      // visibility
      if (d.visibility !== 'synced' && d.visibility !== 'cross-node-readable') return [];
      // sensitivity
      if (d.sensitive) return [];
    }
    // readOnly is a HARD cap for everyone, incl. local root
    if (d.readOnly) allowed = new Set([...allowed].filter((a) => READ_ONLY_ACTIONS.includes(a)));
    return [...allowed];
  }

  async requestAccess(p: Principal, req: AccessRequest): Promise<IssueResult> {
    const grants: Grant[] = [];
    for (const g of req.grants) {
      const d = this.deps.datasets.get(g.dataset);
      if (!d) continue;
      const actions = this.evaluateGrants(p, d, g.actions);
      if (actions.length) grants.push({ dataset: g.dataset, actions });
    }
    if (!grants.length) {
      await this.deps.keys.appendAudit({ at: new Date().toISOString(), event: 'deny',
        principalType: p.type, principalId: p.userId, detail: 'no grantable scope' });
      return { ok: false, reason: 'no grantable scope for the requested datasets/actions' };
    }
    const ttl = Math.min(TTL_MAX, Math.max(TTL_MIN, req.ttlSeconds ?? TTL_DEFAULT));
    const keyId = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const key: AccessKey = {
      keyId,
      secretHash: crypto.createHash('sha256').update(secret).digest('hex'),
      principalType: p.type,
      principalId: p.userId,
      node: this.deps.nodeId,
      grants,
      label: req.intent,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl * 1000).toISOString(),
    };
    await this.deps.keys.put(key);
    await this.deps.keys.appendAudit({ at: key.issuedAt, event: 'issue', keyId,
      principalType: p.type, principalId: p.userId, detail: req.intent });
    return { ok: true, key: `${keyId}.${secret}`, keyId, grants, expiresAt: key.expiresAt };
  }

  async enforce(p: Principal, keyHeader: string | undefined, d: DatasetDescriptor, action: DataAction): Promise<EnforceResult> {
    // Hard caps first (apply to everyone, incl. local root).
    if (d.readOnly && !READ_ONLY_ACTIONS.includes(action)) {
      return { ok: false, code: 'READ_ONLY', status: 403, reason: `dataset "${d.id}" is read-only` };
    }
    if (d.sensitive && p.type === 'cloud') {
      return { ok: false, code: 'SENSITIVE', status: 403, reason: `dataset "${d.id}" is not available to cloud callers` };
    }

    if (keyHeader) {
      const dot = keyHeader.indexOf('.');
      const keyId = dot >= 0 ? keyHeader.slice(0, dot) : keyHeader;
      const secret = dot >= 0 ? keyHeader.slice(dot + 1) : '';
      const key = this.deps.keys.get(keyId);
      if (!key) return { ok: false, code: 'KEY_INVALID', status: 403, reason: 'unknown access key' };
      if (key.revoked) return { ok: false, code: 'KEY_REVOKED', status: 403, reason: 'access key revoked' };
      if (Date.parse(key.expiresAt) <= Date.now()) return { ok: false, code: 'KEY_EXPIRED', status: 403, reason: 'access key expired' };
      if (key.node !== this.deps.nodeId) return { ok: false, code: 'KEY_WRONG_NODE', status: 403, reason: 'access key not valid on this node' };
      const expected = Buffer.from(key.secretHash, 'hex');
      const got = crypto.createHash('sha256').update(secret).digest();
      if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
        return { ok: false, code: 'KEY_INVALID', status: 403, reason: 'bad access key secret' };
      }
      const grant = key.grants.find((g) => g.dataset === d.id);
      if (!grant || !grant.actions.includes(action)) {
        return { ok: false, code: 'NOT_GRANTED', status: 403, reason: `key does not grant "${action}" on "${d.id}"` };
      }
      await this.deps.keys.appendAudit({ at: new Date().toISOString(), event: 'use', keyId,
        principalType: p.type, principalId: p.userId, dataset: d.id, action });
      return { ok: true, principal: p };
    }

    // No key: local fast-path (root on local data). Cloud must present a key.
    if (p.type === 'local') return { ok: true, principal: p };
    return { ok: false, code: 'KEY_REQUIRED', status: 403, reason: 'cloud callers must present an access key' };
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/data/access-manager.test.js`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add core/src/routes/index.ts core/src/data/access-manager.ts core/src/__tests__/data/access-manager.test.ts
git commit -m "feat(data): access manager — principal resolution, grant eval, key issue + enforce"
```

---

## Task 6: Backend registry, DataService facade, and the kill-switch

**Files:**
- Modify: `core/src/project-settings.ts` (add `dataServiceEnabled`)
- Create: `core/src/data/backend-registry.ts`
- Create: `core/src/data/data-service.ts`
- Test: `core/src/__tests__/data/data-service.test.ts`

**Interfaces:**
- Consumes: `CacheBackend` (Task 2), `DatasetRegistry` (Task 3), `KeyStore` (Task 4), `AccessManager` (Task 5), `redactRecord` (Task 1), all types.
- Produces:
  - `backend-registry.ts`: `class BackendRegistry { register(b: StorageBackend): void; get(kind: BackendKind): StorageBackend | undefined; }`
  - `data-service.ts`:
    - `interface CallCtx { principal: Principal; keyHeader?: string; }`
    - `type DataResult<T> = { ok: true; value: T } | { ok: false; code: string; reason: string };`
    - `class DataService` with `constructor(deps: { datasets: DatasetRegistry; backends: BackendRegistry; manager: AccessManager; })` and methods `isEnabled(): boolean`, `catalog(p: Principal): Array<{ id: string; backend: BackendKind; visibility: NodeVisibility; readOnly: boolean; actions: DataAction[] }>`, `requestAccess`, `revoke`, `get`, `query`, `put`, `del`, `resolvePrincipal`.
    - `getDataService(): DataService` singleton.

- [ ] **Step 1: Add `dataServiceEnabled` to project settings**

In `core/src/project-settings.ts`: add the field to the `ProjectSettings` interface, the `DEFAULTS` object, and the read/merge logic in `getProjectSettings()` and `saveProjectSettings()` — mirroring `knowledgeEnabled` exactly:

```typescript
// In the ProjectSettings interface, add:
  /** Kill switch: disable the generic data service (datasets, access keys, data routes). */
  dataServiceEnabled: boolean;

// In DEFAULTS, add:
  dataServiceEnabled: false,

// In getProjectSettings(), in the constructed `settings` object, add:
  dataServiceEnabled: typeof data.dataServiceEnabled === 'boolean' ? data.dataServiceEnabled : DEFAULTS.dataServiceEnabled,

// In saveProjectSettings(), in the `merged` object, add:
  dataServiceEnabled: typeof partial.dataServiceEnabled === 'boolean' ? partial.dataServiceEnabled : current.dataServiceEnabled,
```

- [ ] **Step 2: Write the failing test** `core/src/__tests__/data/data-service.test.ts`

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
import { REDACTED } from '../../data/redaction';

function service() {
  const datasets = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ds-reg-')), 'd.json'));
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ds-keys-')));
  const backends = new BackendRegistry();
  backends.register(new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ds-cache-'))));
  const manager = new AccessManager({ datasets, keys, nodeId: 'n1' });
  // force-enable regardless of project settings on the test box
  const svc = new DataService({ datasets, backends, manager });
  (svc as any).enabledOverride = true;
  return { svc, datasets };
}

test('data service: local put then redacted get', async () => {
  const { svc, datasets } = service();
  datasets.create({ id: 'd', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [] });
  const local = { principal: { type: 'local' as const } };
  const put = await svc.put(local, 'd', { id: 'a', fields: { name: 'x', apiKey: 'sk-1' }, createdAt: 't', updatedAt: 't' });
  assert.equal(put.ok, true);
  const got = await svc.get(local, 'd', 'a');
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.value?.fields.name, 'x');
  assert.equal(got.value?.fields.apiKey, REDACTED); // redaction on the way out
});

test('data service: cloud denied without key, allowed with minted key', async () => {
  const { svc, datasets } = service();
  datasets.create({ id: 'd', backend: 'cache', visibility: 'cross-node-readable',
    config: { kind: 'cache' }, acl: [{ principal: 'cloud', actions: ['read', 'query'] }] });
  await svc.put({ principal: { type: 'local' } }, 'd', { id: 'a', fields: { n: 1 }, createdAt: 't', updatedAt: 't' });
  const cloud = { type: 'cloud' as const, userId: 'u1' };
  const denied = await svc.get({ principal: cloud }, 'd', 'a');
  assert.equal(denied.ok, false);
  const issued = await svc.requestAccess(cloud, { grants: [{ dataset: 'd', actions: ['read'] }] });
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  const ok = await svc.get({ principal: cloud, keyHeader: issued.value.key }, 'd', 'a');
  assert.equal(ok.ok, true);
});

test('data service: catalog reflects what a principal may do', async () => {
  const { svc, datasets } = service();
  datasets.create({ id: 'pub', backend: 'cache', visibility: 'cross-node-readable',
    config: { kind: 'cache' }, acl: [{ principal: 'cloud', actions: ['read'] }] });
  datasets.create({ id: 'priv', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [] });
  const cloud = svc.catalog({ type: 'cloud', userId: 'u' });
  assert.deepEqual(cloud.map((c) => c.id), ['pub']); // priv hidden from cloud
  const local = svc.catalog({ type: 'local' });
  assert.deepEqual(local.map((c) => c.id).sort(), ['priv', 'pub']);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd core && npm run build:test`
Expected: build FAILS (`Cannot find module '../../data/backend-registry'`).

- [ ] **Step 4: Write `core/src/data/backend-registry.ts`**

```typescript
// core/src/data/backend-registry.ts
import type { StorageBackend, BackendKind } from './types';

export class BackendRegistry {
  private map = new Map<BackendKind, StorageBackend>();
  register(b: StorageBackend): void { this.map.set(b.kind, b); }
  get(kind: BackendKind): StorageBackend | undefined { return this.map.get(kind); }
}
```

- [ ] **Step 5: Write `core/src/data/data-service.ts`**

```typescript
// core/src/data/data-service.ts
import type {
  Principal, DataAction, DataRecord, QuerySpec, AccessRequest, BackendKind, NodeVisibility,
} from './types';
import type { DatasetRegistry } from './dataset-registry';
import { getDatasetRegistry } from './dataset-registry';
import type { BackendRegistry } from './backend-registry';
import { BackendRegistry as BReg } from './backend-registry';
import { AccessManager } from './access-manager';
import { CacheBackend } from './backends/cache-backend';
import { getKeyStore } from './key-store';
import { redactRecord } from './redaction';
import { thisNodeId } from './paths';
import { getProjectSettings } from '../project-settings';
import type { ParsedRequest } from '../routes/index';

export interface CallCtx { principal: Principal; keyHeader?: string; }
export type DataResult<T> = { ok: true; value: T } | { ok: false; code: string; reason: string };

export class DataService {
  private enabledOverride?: boolean; // tests only
  constructor(private deps: { datasets: DatasetRegistry; backends: BackendRegistry; manager: AccessManager }) {}

  isEnabled(): boolean {
    if (typeof this.enabledOverride === 'boolean') return this.enabledOverride;
    return getProjectSettings().dataServiceEnabled === true;
  }

  resolvePrincipal(req: ParsedRequest): Principal { return this.deps.manager.resolvePrincipal(req); }

  catalog(p: Principal): Array<{ id: string; backend: BackendKind; visibility: NodeVisibility; readOnly: boolean; actions: DataAction[] }> {
    const all: DataAction[] = ['read', 'query', 'search', 'write', 'delete', 'manage'];
    const out = [];
    for (const d of this.deps.datasets.list()) {
      const actions = this.deps.manager.evaluateGrants(p, d, all);
      if (!actions.length) continue;
      out.push({ id: d.id, backend: d.backend, visibility: d.visibility, readOnly: !!d.readOnly, actions });
    }
    return out;
  }

  async requestAccess(p: Principal, req: AccessRequest) { return this.deps.manager.requestAccess(p, req); }
  async revoke(_p: Principal, keyId: string): Promise<boolean> { return getKeyStore().revoke(keyId); }

  private async authorize(ctx: CallCtx, datasetId: string, action: DataAction): Promise<DataResult<{ backend: ReturnType<BackendRegistry['get']> }>> {
    const d = this.deps.datasets.get(datasetId);
    if (!d) return { ok: false, code: 'NOT_FOUND', reason: `dataset "${datasetId}" not found` };
    const verdict = await this.deps.manager.enforce(ctx.principal, ctx.keyHeader, d, action);
    if (!verdict.ok) return { ok: false, code: verdict.code, reason: verdict.reason };
    const backend = this.deps.backends.get(d.backend);
    if (!backend) return { ok: false, code: 'NO_BACKEND', reason: `backend "${d.backend}" unavailable` };
    return { ok: true, value: { backend } };
  }

  async get(ctx: CallCtx, datasetId: string, id: string): Promise<DataResult<DataRecord | null>> {
    const a = await this.authorize(ctx, datasetId, 'read');
    if (!a.ok) return a;
    const rec = await a.value.backend!.get(datasetId, id);
    return { ok: true, value: rec ? redactRecord(rec) : null };
  }

  async query(ctx: CallCtx, datasetId: string, q: QuerySpec): Promise<DataResult<{ records: DataRecord[]; total?: number }>> {
    const a = await this.authorize(ctx, datasetId, 'query');
    if (!a.ok) return a;
    const r = await a.value.backend!.query(datasetId, q);
    return { ok: true, value: { records: r.records.map(redactRecord), total: r.total } };
  }

  async put(ctx: CallCtx, datasetId: string, record: DataRecord): Promise<DataResult<{ id: string }>> {
    const a = await this.authorize(ctx, datasetId, 'write');
    if (!a.ok) return a;
    return { ok: true, value: await a.value.backend!.put(datasetId, record) };
  }

  async del(ctx: CallCtx, datasetId: string, id: string): Promise<DataResult<boolean>> {
    const a = await this.authorize(ctx, datasetId, 'delete');
    if (!a.ok) return a;
    return { ok: true, value: await a.value.backend!.delete(datasetId, id) };
  }
}

let instance: DataService | null = null;
export function getDataService(): DataService {
  if (!instance) {
    const datasets = getDatasetRegistry();
    const backends = new BReg();
    backends.register(new CacheBackend());
    const manager = new AccessManager({ datasets, keys: getKeyStore(), nodeId: thisNodeId() });
    instance = new DataService({ datasets, backends, manager });
  }
  return instance;
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/data/data-service.test.js`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add core/src/project-settings.ts core/src/data/backend-registry.ts core/src/data/data-service.ts core/src/__tests__/data/data-service.test.ts
git commit -m "feat(data): backend registry + DataService facade (redaction, kill-switch) + dataServiceEnabled"
```

---

## Task 7: REST routes + server header wiring

**Files:**
- Modify: `core/src/rest-server.ts` (populate `headers` in `parseRequest`)
- Create: `core/src/routes/core/data.routes.ts`
- Modify: `core/src/routes/core/index.ts` (register `createDataRoutes`)
- Test: `core/src/__tests__/data/data-routes.test.ts`

**Interfaces:**
- Consumes: `RouteHandler`, `RouteContext`, `ParsedRequest` from `../index`; `wrapResponse`, `wrapError` from `../../api/helpers`; `getDataService`, `CallCtx` from `../../data/data-service`.
- Produces: `createDataRoutes(ctx: RouteContext): RouteHandler[]`.

- [ ] **Step 1: Populate headers in the server**

In `core/src/rest-server.ts`, find `parseRequest()` (the method that builds the `ParsedRequest`) and add `headers: req.headers,` to the returned object (alongside `clientIp`):

```typescript
    return {
      method: req.method || 'GET',
      path: url.pathname,
      params: {},
      query: Object.fromEntries(url.searchParams),
      body: await this.parseBody(req),
      headers: req.headers,
      clientIp: req.socket?.remoteAddress || undefined,
    };
```

- [ ] **Step 2: Write the failing test** `core/src/__tests__/data/data-routes.test.ts`

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
// Hermetic: point all data-service storage at a temp dir. getDataDir() reads this env var
// lazily (at first getDataService() call), so setting it here keeps the test off the real data dir.
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-routes-'));
import { createDataRoutes } from '../../routes/core/data.routes';
import { getDataService } from '../../data/data-service';
import type { ParsedRequest } from '../../routes/index';

// Enable the singleton service for this suite.
function enable() { (getDataService() as any).enabledOverride = true; }
function find(method: string, path: string) {
  const routes = createDataRoutes({} as any);
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.pattern);
    if (m) return { handler: r.handler, params: m.groups ?? {} };
  }
  throw new Error(`no route for ${method} ${path}`);
}
function call(method: string, path: string, opts: { body?: any; headers?: Record<string, string> } = {}) {
  const { handler, params } = find(method, path);
  const req: ParsedRequest = { method, path, params, query: {}, body: opts.body, headers: opts.headers ?? {} };
  return handler(req, {} as any);
}

test('routes: create dataset (local) then put/get round-trip', async () => {
  enable();
  const id = `t_${Date.now()}`;
  const created = await call('POST', '/data/datasets', { body: { id, backend: 'cache', config: { kind: 'cache' } } });
  assert.equal(created.success, true);
  const put = await call('PUT', `/data/${id}/records`, { body: { id: 'a', fields: { name: 'z' } } });
  assert.equal(put.success, true);
  const got = await call('GET', `/data/${id}/records/a`, {});
  assert.equal(got.success, true);
  assert.equal(got.data.fields.name, 'z');
});

test('routes: cloud caller without key is forbidden', async () => {
  enable();
  const id = `t2_${Date.now()}`;
  await call('POST', '/data/datasets', { body: { id, backend: 'cache', config: { kind: 'cache' } } });
  await call('PUT', `/data/${id}/records`, { body: { id: 'a', fields: { n: 1 } } });
  const got = await call('GET', `/data/${id}/records/a`, { headers: { 'x-relay-source': 'hub', 'x-lm-user-id': 'u' } });
  assert.equal(got.success, false);
  assert.equal(got.error.code, 'FORBIDDEN');
});

test('routes: cloud create dataset is forbidden (local-only admin)', async () => {
  enable();
  const got = await call('POST', '/data/datasets',
    { body: { id: `nope_${Date.now()}`, backend: 'cache', config: { kind: 'cache' } },
      headers: { 'x-relay-source': 'hub' } });
  assert.equal(got.success, false);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd core && npm run build:test`
Expected: build FAILS (`Cannot find module '../../routes/core/data.routes'`).

- [ ] **Step 4: Write `core/src/routes/core/data.routes.ts`**

```typescript
// core/src/routes/core/data.routes.ts
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { getDataService, type CallCtx } from '../../data/data-service';
import type { DataRecord } from '../../data/types';

function ctxOf(req: ParsedRequest): CallCtx {
  const svc = getDataService();
  const principal = svc.resolvePrincipal(req);
  const raw = req.headers?.['x-lm-access-key'];
  const keyHeader = Array.isArray(raw) ? raw[0] : raw;
  return { principal, keyHeader };
}

function recordFromBody(body: any): DataRecord {
  const now = new Date().toISOString();
  return {
    id: String(body?.id ?? ''),
    fields: (body?.fields && typeof body.fields === 'object') ? body.fields : {},
    text: typeof body?.text === 'string' ? body.text : undefined,
    metadata: (body?.metadata && typeof body.metadata === 'object') ? body.metadata : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

export function createDataRoutes(_ctx: RouteContext): RouteHandler[] {
  const svc = () => getDataService();
  const disabled = (start: number) => wrapError('DATA_SERVICE_DISABLED', 'data service is disabled', start);

  return [
    // GET /data/catalog
    {
      method: 'GET',
      pattern: /^\/data\/catalog$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        return wrapResponse({ datasets: svc().catalog(svc().resolvePrincipal(req)) }, start);
      },
    },

    // POST /data/access  — request a scoped key
    {
      method: 'POST',
      pattern: /^\/data\/access$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const p = svc().resolvePrincipal(req);
        const res = await svc().requestAccess(p, req.body || { grants: [] });
        if (!res.ok) return wrapError('FORBIDDEN', res.reason, start);
        return wrapResponse(res, start);
      },
    },

    // DELETE /data/access/:keyId — revoke
    {
      method: 'DELETE',
      pattern: /^\/data\/access\/(?<keyId>[^/]+)$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const ok = await svc().revoke(svc().resolvePrincipal(req), req.params.keyId);
        return wrapResponse({ revoked: ok }, start);
      },
    },

    // GET /data/datasets — list descriptors visible to caller (catalog alias for admin)
    {
      method: 'GET',
      pattern: /^\/data\/datasets$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        return wrapResponse({ datasets: svc().catalog(svc().resolvePrincipal(req)) }, start);
      },
    },

    // POST /data/datasets — create a dataset (LOCAL principal only in M1)
    {
      method: 'POST',
      pattern: /^\/data\/datasets$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const p = svc().resolvePrincipal(req);
        if (p.type !== 'local') return wrapError('FORBIDDEN', 'dataset creation is local-only', start);
        const b = req.body || {};
        try {
          // getDatasetRegistry is the same instance the service uses
          const { getDatasetRegistry } = require('../../data/dataset-registry');
          const d = getDatasetRegistry().create({
            id: b.id, backend: b.backend ?? 'cache', title: b.title,
            visibility: b.visibility, readOnly: b.readOnly, sensitive: b.sensitive,
            config: b.config ?? { kind: 'cache' }, acl: b.acl,
          });
          // ensure the backend allocates storage
          await svc().put({ principal: p }, d.id, recordFromBody({ id: '__init__', fields: {} }));
          await svc().del({ principal: p }, d.id, '__init__');
          return wrapResponse({ dataset: d }, start);
        } catch (e) {
          return wrapError('BAD_REQUEST', e instanceof Error ? e.message : String(e), start);
        }
      },
    },

    // GET /data/:dataset/records/:id
    {
      method: 'GET',
      pattern: /^\/data\/(?<dataset>[^/]+)\/records\/(?<id>[^/]+)$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const r = await svc().get(ctxOf(req), req.params.dataset, req.params.id);
        if (!r.ok) return wrapError(r.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'FORBIDDEN', r.reason, start);
        return wrapResponse(r.value, start);
      },
    },

    // POST /data/:dataset/query
    {
      method: 'POST',
      pattern: /^\/data\/(?<dataset>[^/]+)\/query$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const r = await svc().query(ctxOf(req), req.params.dataset, req.body || {});
        if (!r.ok) return wrapError(r.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'FORBIDDEN', r.reason, start);
        return wrapResponse(r.value, start);
      },
    },

    // PUT /data/:dataset/records
    {
      method: 'PUT',
      pattern: /^\/data\/(?<dataset>[^/]+)\/records$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const rec = recordFromBody(req.body);
        if (!rec.id) return wrapError('BAD_REQUEST', 'record id is required', start);
        const r = await svc().put(ctxOf(req), req.params.dataset, rec);
        if (!r.ok) return wrapError(r.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'FORBIDDEN', r.reason, start);
        return wrapResponse(r.value, start);
      },
    },

    // DELETE /data/:dataset/records/:id
    {
      method: 'DELETE',
      pattern: /^\/data\/(?<dataset>[^/]+)\/records\/(?<id>[^/]+)$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const r = await svc().del(ctxOf(req), req.params.dataset, req.params.id);
        if (!r.ok) return wrapError(r.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'FORBIDDEN', r.reason, start);
        return wrapResponse({ deleted: r.value }, start);
      },
    },
  ];
}
```

- [ ] **Step 5: Register the routes**

In `core/src/routes/core/index.ts`: add the import near the other route imports, and the spread inside `createCoreRoutes`'s returned array:

```typescript
import { createDataRoutes } from './data.routes';
```
```typescript
    ...createDataRoutes(ctx),
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/data/data-routes.test.js`
Expected: PASS (3 tests).

- [ ] **Step 7: Full build + commit**

Run: `cd core && npm run build`
Expected: tsc completes with no errors.

```bash
git add core/src/rest-server.ts core/src/routes/core/data.routes.ts core/src/routes/core/index.ts core/src/__tests__/data/data-routes.test.ts
git commit -m "feat(data): REST data routes + server header wiring + route registration"
```

---

## Task 8: End-to-end smoke test on the dev server

**Files:** none created — this is a manual verification gate proving M1 works against the running dev API.

- [ ] **Step 1: Enable the data service**

Edit `~/.lm-assist/project-settings.json` (or `POST /project-settings`) so `dataServiceEnabled` is `true`. Then build + restart dev:

Run: `./core.sh build && ./core.sh restart`
Expected: `./core.sh status` shows dev API healthy on :3200.

- [ ] **Step 2: Create a dataset, write, read (local path)**

Run:
```bash
TOKEN=$(cat ~/.lm-assist/api-token)
curl -s -H "x-api-key: $TOKEN" -H 'content-type: application/json' \
  -d '{"id":"smoke","backend":"cache","config":{"kind":"cache"},"visibility":"cross-node-readable","acl":[{"principal":"cloud","actions":["read"]}]}' \
  http://localhost:3200/data/datasets
curl -s -H "x-api-key: $TOKEN" -H 'content-type: application/json' \
  -d '{"id":"r1","fields":{"title":"hello","apiKey":"sk-should-be-redacted"}}' \
  -X PUT http://localhost:3200/data/smoke/records
curl -s -H "x-api-key: $TOKEN" http://localhost:3200/data/smoke/records/r1
```
Expected: the GET returns `success:true`, `fields.title="hello"`, and `fields.apiKey` is `«redacted»`.

- [ ] **Step 3: Verify the catalog + access-key flow**

Run:
```bash
curl -s -H "x-api-key: $TOKEN" http://localhost:3200/data/catalog
curl -s -H "x-api-key: $TOKEN" -H 'content-type: application/json' \
  -d '{"intent":"read smoke","grants":[{"dataset":"smoke","actions":["read"]}]}' \
  http://localhost:3200/data/access
```
Expected: catalog lists `smoke`; `/data/access` returns `success:true` with a `key` of the form `<uuid>.<secret>` and `grants:[{dataset:"smoke",actions:["read"]}]`.

- [ ] **Step 4: Commit a short verification note (optional)**

If anything needed adjusting to pass the smoke test, fix it under TDD in the relevant task above and re-commit. Otherwise M1 is complete.

---

## Self-Review

**1. Spec coverage (M1 portion of the design doc):**
- Control plane (mgr): principal resolution ✓ (Task 5), grant evaluation ✓ (Task 5), key issuance ✓ (Task 5), enforcement ✓ (Task 5). Local fast-path ✓ (Task 5). Opaque/hashed/expiring/revocable keys + audit ✓ (Tasks 4–5).
- Cache backend (LMDB, compressed) ✓ (Task 2).
- DatasetRegistry + visibility/readOnly/sensitive flags ✓ (Tasks 1, 3, 5).
- Sensitivity guard: hard-exclusion ✓ + always-on redaction ✓ shipping in M1 ✓ (Tasks 1, 6). (Redaction choke point is `DataService` — Task 6.)
- REST surface for the M1 subset ✓ (Task 7). Kill-switch `dataServiceEnabled` ✓ (Task 6).
- Two principals mapped to transport paths ✓ (Task 5 via `x-relay-source`).
- Deferred (correctly out of M1): vector/sql backends, system datasets, file tracking, MCP tools, cross-node sync, web UI. These are M2–M6.

**2. Placeholder scan:** No "TBD/TODO/handle errors appropriately" — every step has complete code and exact commands. The only `require()` inside a handler (data.routes create) is deliberate and points at the real singleton.

**3. Type consistency:** `StorageBackend` (Task 1) is implemented exactly by `CacheBackend` (Task 2). `AccessManager` method names (`resolvePrincipal`, `evaluateGrants`, `requestAccess`, `enforce`) are used identically in Tasks 5–7. `DataService` methods (`get/query/put/del/catalog/requestAccess/revoke/resolvePrincipal/isEnabled`) match between Task 6 definition and Task 7 callers. `CallCtx { principal, keyHeader }` is consistent. `EnforceResult.code` values (`READ_ONLY`, `SENSITIVE`, `KEY_*`, `NOT_GRANTED`, `KEY_REQUIRED`) are produced in Task 5 and surfaced as `FORBIDDEN` envelopes in Task 7 (intentional mapping). `ParsedRequest.headers` added in Task 5, populated in Task 7.

**Known M1 limitations (documented, deferred):** the hub relay does not yet pass `x-lm-user-id`, so cloud `principalId` may be undefined until that wiring lands (M5); `thisNodeId()` uses hostname and will be unified with the canonical machineId in M5; error verdicts return a `success:false` envelope with `error.code` rather than a non-200 HTTP status (consistent with the existing codebase envelope).
