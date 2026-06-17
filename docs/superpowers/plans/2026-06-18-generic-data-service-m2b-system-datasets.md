# Generic Data Service — M2b: System-Dataset Management Adapters + `data_admin` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the EXISTING knowledge store and vector store through the generic data service as reserved `system: true` datasets — so an LLM can read, search, and (gated, local-by-default) manage them from API/MCP via a `data_admin` tool that runs declared store-specific maintenance ops — WITHOUT rerouting or modifying any normal flow.

**Architecture:** Two new `StorageBackend` adapters (`KnowledgeBackend` kind `'knowledge'`, `VectorsBackend` kind `'vectors'`) delegate to `getKnowledgeStore()`/`getVectorStore()`'s OWN methods, so every invariant the existing `/knowledge/*` and `/vectors/*` routes maintain (index.json consistency, knowledge↔vector linkage) holds unchanged. A new optional `admin?(dataset, op, args?)` method on `StorageBackend` carries the maintenance ops. `DataService.admin` authorizes the `manage` action then dispatches. System datasets are auto-registered at service init with a read-open / mutate-local-only ACL. A `POST /data/:dataset/admin` route and a `data_admin` MCP tool expose the op path. The existing stores and routes are untouched — the adapters are *additional callers*.

**Tech Stack:** TypeScript (CommonJS), the existing `core/src/knowledge/` + `core/src/vector/` stores, `node:test` + `node:assert/strict`.

## Global Constraints

- **Additive only — do NOT modify existing code paths.** `core/src/knowledge/**`, `core/src/vector/vector-store.ts`, the `/knowledge/*` and `/vectors/*` routes, and the `search`/`detail`/`feedback` MCP tools stay byte-stable. The adapters CALL the stores' public methods; they never reach into store internals or duplicate store logic.
- **Adapters delegate to store METHODS, never raw writes.** Every mutation goes through `createKnowledge`/`updateKnowledge`/`deleteKnowledge`/`addComment`/`addVectors`/`deleteAllByType`/etc. so store invariants are preserved.
- **System datasets are `system: true`** (not user-deletable) and registered with the default gating ACL: `[{ principal: '*', actions: ['read','query','search'] }, { principal: 'local', actions: ['write','delete','manage'] }]` — **read open to all authed callers; write/delete/manage local-only by default.** They are NOT `readOnly` (that would hard-cap out `manage`) and NOT `sensitive`. `syncMode: 'none'` (knowledge has its OWN remote-sync; system datasets never ride the generic sync engine).
- **`manage` is the admin path.** `DataService.admin` authorizes the `manage` action via the existing `enforce`. A cloud caller gets `manage` only with an explicit operator ACL rule + a key granting it; local callers manage via the root fast-path. Never grant cloud `manage` by default.
- **Redaction stays on.** Read results already pass through `redactRecord` in `DataService`. `admin` op RESULTS (status/stats objects) must ALSO be redaction-swept before return (they can echo paths/config) — `DataService.admin` runs the result through a redaction pass.
- **Backend contract additions are OPTIONAL methods.** `admin?` is optional on `StorageBackend`; cache/vector backends omit it. `exportSince`/`importBatch` on the adapters throw a clear `SYNC_NOT_SUPPORTED` error (system datasets are `syncMode: 'none'` so the engine never calls them; the throw is a guard).
- **`BackendKind` extension:** add `'knowledge' | 'vectors'` to the union (it is currently `'vector' | 'sql' | 'cache'`). Add matching `BackendConfig` variants `{ kind: 'knowledge' }` and `{ kind: 'vectors' }`.
- **DataRecord↔Knowledge mapping (the adapter's contract):** a knowledge `DataRecord` carries the document in `fields`: `{ title, type, project, status, parts, createdAt, updatedAt, origin?, machineId? }` where `parts` is `KnowledgePart[]` (`{ partId, title, summary, content }`); `text` = the parts' content joined; `id` = the `K00x` id. `put` with an existing id → `updateKnowledge`; without (or unknown id) → `createKnowledge`.
- **Hermetic tests** set `process.env.LM_ASSIST_DATA_DIR` to a temp dir BEFORE importing the store/service (so `getKnowledgeStore()`/`getVectorStore()` use the temp dir), and populate via the stores' own methods. The `search` delegations (which need the real embedder model) are NOT unit-tested — they are thin pass-throughs proven at the deploy e2e (same policy as M2a's vector search).
- **`data_admin` MCP tool** threads the principal exactly like the other `data_*` tools (`currentMcpContext`/`ctxFromArgs`) and flows through the existing `...DATA_TOOL_DEFS`/`...DATA_HANDLERS` spreads in `expanded.ts` (no `expanded.ts` edit). It is `manage`-scoped: `annotations.readOnlyHint: false`.
- Tests: `node:test` + `node:assert/strict`, compiled via `tsc -p core/tsconfig.test.json`, run `node --test core/dist-test/__tests__/data/<file>.test.js`.

## File Structure

- **Modify** `core/src/data/types.ts` — extend `BackendKind`; add `KnowledgeConfig`/`VectorsConfig` to `BackendConfig`; add `admin?` to `StorageBackend`.
- **Create** `core/src/data/backends/knowledge-backend.ts` — `KnowledgeBackend implements StorageBackend`.
- **Create** `core/src/data/backends/vectors-backend.ts` — `VectorsBackend implements StorageBackend`.
- **Create** `core/src/data/system-datasets.ts` — `ensureSystemDatasets(registry)` + the system descriptor specs.
- **Modify** `core/src/data/data-service.ts` — register the two adapters; call `ensureSystemDatasets`; add `admin()` method + a result-redaction helper.
- **Modify** `core/src/data/redaction.ts` — add `redactValueDeep(v)` (redact a generic object/array, not just a DataRecord) for admin-result scrubbing. (If an equivalent already exists, reuse it.)
- **Modify** `core/src/routes/core/data.routes.ts` — add `POST /data/:dataset/admin`.
- **Modify** `core/src/mcp-server/tools/data-tools.ts` — add `data_admin` def + handler.
- **Create** tests: `core/src/__tests__/data/knowledge-backend.test.ts`, `core/src/__tests__/data/vectors-backend.test.ts`, `core/src/__tests__/data/system-datasets.test.ts`, `core/src/__tests__/data/data-admin.test.ts`.
- **Modify** `core/src/__tests__/data/data-tools.test.ts` — bump the tool-count assertion to 8 (add `data_admin`).

**Base commit before Task 1:** the current branch HEAD (the M2a tip + final fixes). Record it in the ledger.

---

### Task 1: `admin` contract + `BackendKind`/config extension + `DataService.admin`

**Files:**
- Modify: `core/src/data/types.ts`
- Modify: `core/src/data/redaction.ts` (add `redactValueDeep`)
- Modify: `core/src/data/data-service.ts` (add `admin()` + import)
- Test: `core/src/__tests__/data/data-admin.test.ts` (service-level, with a fake admin backend)

**Interfaces:**
- Produces: `StorageBackend.admin?(dataset: string, op: string, args?: Record<string, unknown>): Promise<unknown>`; `BackendKind` includes `'knowledge'|'vectors'`; `DataService.admin(ctx: CallCtx, datasetId: string, op: string, args?: Record<string, unknown>): Promise<DataResult<unknown>>`; `redactValueDeep(v: unknown): unknown`.

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/data/data-admin.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { DataService } from '../../data/data-service';
import { BackendRegistry } from '../../data/backend-registry';
import { DatasetRegistry } from '../../data/dataset-registry';
import { KeyStore } from '../../data/key-store';
import { AccessManager } from '../../data/access-manager';
import type { StorageBackend, BackendKind, DataRecord, QuerySpec, NodeOrigin } from '../../data/types';

// Minimal fake backends to test the service-level admin dispatch in isolation.
// FakeAdminBackend (kind 'cache') HAS admin; FakeNoAdminBackend (kind 'vector') does NOT.
class FakeAdminBackend implements StorageBackend {
  readonly kind: BackendKind = 'cache';
  lastOp: { op: string; args?: Record<string, unknown> } | null = null;
  async createDataset(): Promise<void> {}
  async dropDataset(): Promise<void> {}
  async put(_d: string, r: DataRecord): Promise<{ id: string }> { return { id: r.id }; }
  async get(): Promise<DataRecord | null> { return null; }
  async query(): Promise<{ records: DataRecord[]; total?: number }> { return { records: [], total: 0 }; }
  async delete(): Promise<boolean> { return false; }
  async exportSince(): Promise<DataRecord[]> { return []; }
  async importBatch(_d: string, _r: DataRecord[], _o: NodeOrigin): Promise<{ applied: number; skipped: number }> { return { applied: 0, skipped: 0 }; }
  async admin(_dataset: string, op: string, args?: Record<string, unknown>): Promise<unknown> {
    this.lastOp = { op, args };
    return { ok: true, op, echoed: args, apiKey: 'sk-should-be-redacted' };
  }
}
class FakeNoAdminBackend implements StorageBackend {
  readonly kind: BackendKind = 'vector'; // distinct kind, no admin method
  async createDataset(): Promise<void> {}
  async dropDataset(): Promise<void> {}
  async put(_d: string, r: DataRecord): Promise<{ id: string }> { return { id: r.id }; }
  async get(): Promise<DataRecord | null> { return null; }
  async query(): Promise<{ records: DataRecord[]; total?: number }> { return { records: [], total: 0 }; }
  async delete(): Promise<boolean> { return false; }
  async exportSince(): Promise<DataRecord[]> { return []; }
  async importBatch(_d: string, _r: DataRecord[], _o: NodeOrigin): Promise<{ applied: number; skipped: number }> { return { applied: 0, skipped: 0 }; }
}

function svc() {
  const datasets = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-adm-reg-')), 'd.json'));
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-adm-keys-')));
  const backends = new BackendRegistry();
  const fake = new FakeAdminBackend();
  backends.register(fake);
  backends.register(new FakeNoAdminBackend());
  const manager = new AccessManager({ datasets, keys, nodeId: 'n1' });
  const s = new DataService({ datasets, backends, manager });
  (s as any).enabledOverride = true;
  return { s, datasets, fake };
}

test('data admin: local manage dispatches op, result is redacted', async () => {
  const { s, datasets, fake } = svc();
  datasets.create({ id: 'sysd', backend: 'cache', visibility: 'local-only', system: true,
    config: { kind: 'cache' }, acl: [{ principal: 'local', actions: ['manage'] }] });
  const r = await s.admin({ principal: { type: 'local' } }, 'sysd', 'do-thing', { x: 1 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(fake.lastOp?.op, 'do-thing');
  assert.deepEqual(fake.lastOp?.args, { x: 1 });
  // admin RESULT is redaction-swept
  assert.equal((r.value as any).apiKey, '«redacted»');
  assert.equal((r.value as any).ok, true);
});

test('data admin: cloud without a manage key is denied (not dispatched)', async () => {
  const { s, datasets, fake } = svc();
  datasets.create({ id: 'sysd', backend: 'cache', visibility: 'cross-node-readable', system: true,
    config: { kind: 'cache' }, acl: [{ principal: '*', actions: ['read'] }, { principal: 'local', actions: ['manage'] }] });
  const denied = await s.admin({ principal: { type: 'cloud', userId: 'u' } }, 'sysd', 'do-thing');
  assert.equal(denied.ok, false);
  assert.equal(fake.lastOp, null); // never dispatched
});

test('data admin: backend without admin() returns NOT_SUPPORTED', async () => {
  const { s, datasets } = svc();
  // 'plain' uses backend 'vector' -> FakeNoAdminBackend, which has no admin method.
  datasets.create({ id: 'plain', backend: 'vector', visibility: 'local-only',
    config: { kind: 'vector' }, acl: [] });
  const r = await s.admin({ principal: { type: 'local' } }, 'plain', 'noop');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'NOT_SUPPORTED');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/data-admin.test.js`
Expected: FAIL — `s.admin` is not a function / property does not exist.

- [ ] **Step 3: Extend `types.ts`**

In `core/src/data/types.ts`:
1. Change `BackendKind`:
```typescript
export type BackendKind = 'vector' | 'sql' | 'cache' | 'knowledge' | 'vectors';
```
2. Add config variants (after the existing `SqlConfig`):
```typescript
export interface KnowledgeConfig { kind: 'knowledge'; } // system dataset over getKnowledgeStore()
export interface VectorsConfig { kind: 'vectors'; }      // system dataset over getVectorStore()
```
and extend the union:
```typescript
export type BackendConfig = CacheConfig | VectorConfig | SqlConfig | KnowledgeConfig | VectorsConfig;
```
3. Add the optional `admin` method to `StorageBackend` (after `search?`):
```typescript
  /** Store-specific maintenance op (the 'manage' path). Optional — only system-dataset adapters implement it. */
  admin?(dataset: string, op: string, args?: Record<string, unknown>): Promise<unknown>;
```

- [ ] **Step 4: Add `redactValueDeep` to `redaction.ts`**

In `core/src/data/redaction.ts`, export a generic deep-redactor (reuse the existing `SECRET_KEY_RE` + `REDACTED`). Add:

```typescript
/** Deep-clone an arbitrary value, replacing any object property whose key matches SECRET_KEY_RE with REDACTED.
 *  Used to scrub admin-op results (status/stats objects), which are not DataRecords. */
export function redactValueDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactValueDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redactValueDeep(val);
    }
    return out;
  }
  return v;
}
```

> If `redaction.ts` already has an internal `redactValue`/`redactObject` you can export/wrap, reuse it instead of duplicating — match the existing helper's behavior. The behavior required: any key matching `SECRET_KEY_RE` → `REDACTED`, recursively, for plain objects and arrays.

- [ ] **Step 5: Add `DataService.admin`**

In `core/src/data/data-service.ts`:
1. Add `redactValueDeep` to the redaction import:
```typescript
import { redactRecord, redactValueDeep } from './redaction';
```
2. Add the method (place it after `search`, before `del`):
```typescript
  async admin(ctx: CallCtx, datasetId: string, op: string, args?: Record<string, unknown>): Promise<DataResult<unknown>> {
    const a = await this.authorize(ctx, datasetId, 'manage');
    if (!a.ok) return a;
    const backend = a.value.backend!;
    if (!backend.admin) return { ok: false, code: 'NOT_SUPPORTED', reason: `backend "${backend.kind}" has no admin ops` };
    const result = await backend.admin(datasetId, op, args);
    return { ok: true, value: redactValueDeep(result) };
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/data-admin.test.js`
Expected: PASS — local manage dispatches + result redacted; cloud-no-key denied (not dispatched); no-admin backend → NOT_SUPPORTED.

- [ ] **Step 7: Commit**

```bash
git add core/src/data/types.ts core/src/data/redaction.ts core/src/data/data-service.ts core/src/__tests__/data/data-admin.test.ts
git commit -m "feat(data): StorageBackend.admin contract + DataService.admin (manage-gated, result-redacted) + BackendKind knowledge/vectors"
```

---

### Task 2: `KnowledgeBackend` adapter — read surface (get/query/search) + delete

**Files:**
- Create: `core/src/data/backends/knowledge-backend.ts`
- Test: `core/src/__tests__/data/knowledge-backend.test.ts`

**Interfaces:**
- Consumes: `getKnowledgeStore()` from `../../knowledge/store`, `getVectorStore()` from `../../vector/vector-store`, `applyQuery` from `./query-filter`.
- Produces: `class KnowledgeBackend implements StorageBackend` (`kind = 'knowledge'`), `knowledgeToRecord(k: Knowledge): DataRecord`. Task 3 adds `put`/`admin`.

- [ ] **Step 1: Write the failing test** (hermetic — temp data dir, populate via the real store's own methods)

`core/src/__tests__/data/knowledge-backend.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-kb-'));
import { KnowledgeBackend } from '../../data/backends/knowledge-backend';
import { getKnowledgeStore } from '../../knowledge/store';

function seedDoc(title: string) {
  return getKnowledgeStore().createKnowledge({
    title, type: 'flow', project: '/proj',
    parts: [{ partId: 'p1', title: 'Part one', summary: 'sum', content: 'the body content' }],
  });
}

test('knowledge backend: get maps a stored doc to a DataRecord', async () => {
  const be = new KnowledgeBackend();
  const k = seedDoc('Alpha doc');
  const rec = await be.get('knowledge', k.id);
  assert.equal(rec?.id, k.id);
  assert.equal(rec?.fields.title, 'Alpha doc');
  assert.equal(rec?.fields.type, 'flow');
  assert.ok(Array.isArray(rec?.fields.parts));
  assert.match(String(rec?.text), /body content/);
  assert.equal(await be.get('knowledge', 'K999'), null);
});

test('knowledge backend: query lists + filters docs', async () => {
  const be = new KnowledgeBackend();
  seedDoc('Beta one'); seedDoc('Beta two');
  const all = await be.query('knowledge', {});
  assert.ok(all.records.length >= 2);
  assert.ok(all.records.every((r) => typeof r.fields.title === 'string'));
  const filtered = await be.query('knowledge', { filter: [{ field: 'type', op: 'eq', value: 'flow' }] });
  assert.ok(filtered.records.length >= 2);
});

test('knowledge backend: delete removes the doc', async () => {
  const be = new KnowledgeBackend();
  const k = seedDoc('Gamma doc');
  assert.equal(await be.delete('knowledge', k.id), true);
  assert.equal(await be.get('knowledge', k.id), null);
  assert.equal(await be.delete('knowledge', k.id), false);
});

test('knowledge backend: sync hooks throw (system datasets are not generically synced)', async () => {
  const be = new KnowledgeBackend();
  await assert.rejects(() => be.exportSince('knowledge'), /SYNC_NOT_SUPPORTED/);
  await assert.rejects(() => be.importBatch('knowledge', [], { machineId: 'm', hostname: 'h', os: 'linux' }), /SYNC_NOT_SUPPORTED/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/knowledge-backend.test.js`
Expected: FAIL — `Cannot find module '.../knowledge-backend'`.

- [ ] **Step 3: Create `core/src/data/backends/knowledge-backend.ts` (read surface + delete; put/admin stubbed for Task 3)**

```typescript
// core/src/data/backends/knowledge-backend.ts
// System-dataset adapter over the EXISTING knowledge store (getKnowledgeStore) + vector store
// (getVectorStore, for search). Delegates to the stores' own methods so every invariant the
// /knowledge routes maintain (index.json consistency, knowledge<->vector linkage) holds unchanged.
// This adapter NEVER reaches into store internals and NEVER duplicates store logic.
import type {
  StorageBackend, BackendKind, DatasetDescriptor, DataRecord, QuerySpec, SearchSpec, NodeOrigin,
} from '../types';
import { applyQuery } from './query-filter';
import { getKnowledgeStore } from '../../knowledge/store';
import { getVectorStore } from '../../vector/vector-store';
import type { Knowledge } from '../../knowledge/types';

/** Map an existing Knowledge document to the generic DataRecord shape. */
export function knowledgeToRecord(k: Knowledge): DataRecord {
  return {
    id: k.id,
    version: 1, // knowledge has no generic version; system datasets are not LWW-synced
    fields: {
      title: k.title, type: k.type, project: k.project, status: k.status, parts: k.parts,
      origin: k.origin, machineId: k.machineId, sourceSessionId: k.sourceSessionId,
      reviewRating: k.reviewRating,
    },
    text: (k.parts || []).map((p) => p.content).join('\n\n'),
    metadata: { partCount: (k.parts || []).length },
    createdAt: k.createdAt,
    updatedAt: k.updatedAt,
  };
}

export class KnowledgeBackend implements StorageBackend {
  readonly kind: BackendKind = 'knowledge';

  // createDataset/dropDataset are no-ops: the knowledge store owns its own storage lifecycle.
  async createDataset(_d: DatasetDescriptor): Promise<void> { /* store self-manages */ }
  async dropDataset(_id: string): Promise<void> { /* never drop the knowledge store */ }

  async get(_dataset: string, id: string): Promise<DataRecord | null> {
    const k = getKnowledgeStore().getKnowledge(id);
    return k ? knowledgeToRecord(k) : null;
  }

  async query(_dataset: string, q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }> {
    const records = getKnowledgeStore().getAllKnowledge().map(knowledgeToRecord);
    return applyQuery(records, q);
  }

  async search(_dataset: string, s: SearchSpec): Promise<Array<DataRecord & { score: number }>> {
    const limit = s.limit ?? 20;
    const hits = await getVectorStore().hybridSearch(s.query, limit, { type: 'knowledge' });
    const store = getKnowledgeStore();
    const out: Array<DataRecord & { score: number }> = [];
    const seen = new Set<string>();
    for (const h of hits) {
      const kid = h.knowledgeId;
      if (!kid || seen.has(kid)) continue;
      seen.add(kid);
      const k = store.getKnowledge(kid);
      if (k) out.push({ ...knowledgeToRecord(k), score: h.score });
    }
    return out.slice(0, limit);
  }

  async delete(_dataset: string, id: string): Promise<boolean> {
    const removed = getKnowledgeStore().deleteKnowledge(id);
    if (removed) {
      // mirror the /knowledge delete route: drop the linked vectors too (invariant: knowledge<->vector)
      try { await getVectorStore().deleteKnowledge(id); } catch { /* best effort */ }
    }
    return removed;
  }

  // put + admin land in Task 3.
  async put(_dataset: string, _record: DataRecord): Promise<{ id: string }> { throw new Error('not implemented'); }

  async exportSince(_dataset: string, _since?: string): Promise<DataRecord[]> {
    throw new Error('SYNC_NOT_SUPPORTED: knowledge is a system dataset (uses its own remote-sync)');
  }
  async importBatch(_dataset: string, _records: DataRecord[], _origin: NodeOrigin): Promise<{ applied: number; skipped: number }> {
    throw new Error('SYNC_NOT_SUPPORTED: knowledge is a system dataset (uses its own remote-sync)');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/knowledge-backend.test.js`
Expected: PASS — get/query/delete + sync-hook-throws green. (search is not unit-tested — it delegates to the real embedder; proven at e2e.)

- [ ] **Step 5: Commit**

```bash
git add core/src/data/backends/knowledge-backend.ts core/src/__tests__/data/knowledge-backend.test.ts
git commit -m "feat(data): KnowledgeBackend adapter — read surface (get/query/search) + delete over getKnowledgeStore()"
```

---

### Task 3: `KnowledgeBackend` — put (create/update) + admin ops

**Files:**
- Modify: `core/src/data/backends/knowledge-backend.ts` (replace `put` stub; add `admin`)
- Test: `core/src/__tests__/data/knowledge-backend.test.ts` (append)

**Interfaces:**
- Produces: working `put` (create when id absent/unknown, update when id exists) and `admin(op, args)` for ops `stats`, `add-comment`, `dedup`, `regenerate`, `review`, `remote-sync`.

- [ ] **Step 1: Write the failing test** (append)

```typescript
test('knowledge backend: put creates a new doc then updates it', async () => {
  const be = new KnowledgeBackend();
  // create (no id)
  const created = await be.put('knowledge', {
    id: '', version: 0,
    fields: { title: 'Created via put', type: 'invariant', project: '/p',
      parts: [{ partId: 'p1', title: 'P', summary: 's', content: 'c' }] },
    createdAt: 't', updatedAt: 't',
  });
  assert.match(created.id, /^K\d+/);
  const got = await be.get('knowledge', created.id);
  assert.equal(got?.fields.title, 'Created via put');
  assert.equal(got?.fields.type, 'invariant');

  // update (existing id)
  await be.put('knowledge', {
    id: created.id, version: 0,
    fields: { title: 'Renamed', type: 'invariant', project: '/p',
      parts: [{ partId: 'p1', title: 'P', summary: 's', content: 'c2' }], status: 'active' },
    createdAt: 't', updatedAt: 't',
  });
  const after = await be.get('knowledge', created.id);
  assert.equal(after?.fields.title, 'Renamed');
});

test('knowledge backend: admin stats reports counts', async () => {
  const be = new KnowledgeBackend();
  await be.put('knowledge', { id: '', version: 0, fields: { title: 'S1', type: 'flow', project: '/p', parts: [] }, createdAt: 't', updatedAt: 't' });
  const stats = await be.admin('knowledge', 'stats') as any;
  assert.equal(typeof stats.total, 'number');
  assert.ok(stats.total >= 1);
});

test('knowledge backend: admin add-comment delegates to the store', async () => {
  const be = new KnowledgeBackend();
  const created = await be.put('knowledge', { id: '', version: 0, fields: { title: 'Commented', type: 'flow', project: '/p', parts: [] }, createdAt: 't', updatedAt: 't' });
  const c = await be.admin('knowledge', 'add-comment', { knowledgeId: created.id, type: 'general', content: 'note from llm' }) as any;
  assert.equal(c.knowledgeId, created.id);
  assert.equal(c.content, 'note from llm');
});

test('knowledge backend: admin rejects an unknown op', async () => {
  const be = new KnowledgeBackend();
  await assert.rejects(() => be.admin('knowledge', 'no-such-op'), /unknown admin op/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/knowledge-backend.test.js`
Expected: FAIL — `put` throws `not implemented`; `admin` is not a function.

- [ ] **Step 3: Implement `put` + `admin`**

Replace the `put` stub in `knowledge-backend.ts`:

```typescript
  async put(_dataset: string, record: DataRecord): Promise<{ id: string }> {
    const store = getKnowledgeStore();
    const f = record.fields || {};
    const title = String(f.title ?? '');
    const type = (f.type ?? 'flow') as any;
    const project = String(f.project ?? '');
    const parts = Array.isArray(f.parts) ? (f.parts as any[]) : [];
    const status = (f.status as any) ?? undefined;
    const existing = record.id ? store.getKnowledge(record.id) : null;
    if (existing) {
      const updated = store.updateKnowledge(record.id, { title, type, project, parts, ...(status ? { status } : {}) });
      return { id: updated?.id ?? record.id };
    }
    const created = store.createKnowledge({ title, type, project, parts, ...(status ? { status } : {}) });
    return { id: created.id };
  }
```

Add the `admin` method (place after `delete`). It is a declared whitelist; every op delegates to a store/pipeline method (`require`d lazily to keep heavy singletons cold until used, mirroring the knowledge routes):

```typescript
  async admin(_dataset: string, op: string, args?: Record<string, unknown>): Promise<unknown> {
    const a = args || {};
    const store = getKnowledgeStore();
    switch (op) {
      case 'stats': {
        const all = store.getAllKnowledge();
        const byStatus: Record<string, number> = {};
        const byType: Record<string, number> = {};
        for (const k of all) { byStatus[k.status] = (byStatus[k.status] || 0) + 1; byType[k.type] = (byType[k.type] || 0) + 1; }
        return { total: all.length, byStatus, byType };
      }
      case 'add-comment': {
        return store.addComment({
          knowledgeId: String(a.knowledgeId || ''),
          partId: a.partId ? String(a.partId) : undefined,
          type: (a.type as any) || 'general',
          content: String(a.content || ''),
          source: 'llm',
        });
      }
      case 'regenerate': {
        const { getKnowledgePipeline } = require('../../knowledge/pipeline');
        return await getKnowledgePipeline().regenerateKnowledge(String(a.knowledgeId || ''));
      }
      case 'dedup': {
        const { cleanupExistingDuplicates } = require('../../knowledge/dedup');
        return await cleanupExistingDuplicates(a.project ? String(a.project) : undefined, a.dryRun === true);
      }
      case 'review': {
        const { getKnowledgeReviewer } = require('../../knowledge/reviewer');
        return await getKnowledgeReviewer().review();
      }
      case 'remote-sync': {
        const rs = require('../../knowledge/remote-sync');
        // fire-and-forget like the route; return the current status snapshot
        Promise.resolve(rs.sync(a.project ? String(a.project) : undefined)).catch(() => {});
        return { started: true, status: rs.getSyncStatus() };
      }
      default:
        throw new Error(`unknown admin op: ${op}`);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/knowledge-backend.test.js`
Expected: PASS — put create+update, admin stats, admin add-comment, unknown-op-rejects green. (regenerate/dedup/review/remote-sync are thin delegations to existing pipeline entry points — not unit-tested here as they need sessions/hub/LLM; proven via existing route tests + deploy e2e.)

- [ ] **Step 5: Commit**

```bash
git add core/src/data/backends/knowledge-backend.ts core/src/__tests__/data/knowledge-backend.test.ts
git commit -m "feat(data): KnowledgeBackend put (create/update) + admin ops (stats/add-comment/regenerate/dedup/review/remote-sync)"
```

---

### Task 4: `VectorsBackend` adapter — query/search + admin ops

**Files:**
- Create: `core/src/data/backends/vectors-backend.ts`
- Test: `core/src/__tests__/data/vectors-backend.test.ts`

**Interfaces:**
- Consumes: `getVectorStore()`, `applyQuery`.
- Produces: `class VectorsBackend implements StorageBackend` (`kind = 'vectors'`). `query`/`search`/`admin`; `get`/`put`/`delete` → `NOT_SUPPORTED` errors; sync hooks throw.

- [ ] **Step 1: Write the failing test** (hermetic — temp data dir; uses real vector store stats/delete, which do NOT need the embedder; search is e2e-only)

`core/src/__tests__/data/vectors-backend.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-vb-'));
import { VectorsBackend } from '../../data/backends/vectors-backend';

test('vectors backend: generic record ops are NOT_SUPPORTED (bulk-managed via admin)', async () => {
  const be = new VectorsBackend();
  await assert.rejects(() => be.get('vectors', 'x'), /NOT_SUPPORTED/);
  await assert.rejects(() => be.put('vectors', { id: 'x', version: 0, fields: {}, createdAt: 't', updatedAt: 't' }), /NOT_SUPPORTED/);
  await assert.rejects(() => be.delete('vectors', 'x'), /NOT_SUPPORTED/);
});

test('vectors backend: admin stats returns counts by type', async () => {
  const be = new VectorsBackend();
  const stats = await be.admin('vectors', 'stats') as any;
  assert.equal(typeof stats.totalVectors, 'number');
  assert.equal(typeof stats.sessionVectors, 'number');
  assert.equal(typeof stats.knowledgeVectors, 'number');
});

test('vectors backend: admin delete-all-by-type delegates (0 on an empty store)', async () => {
  const be = new VectorsBackend();
  const r = await be.admin('vectors', 'delete-all-by-type', { type: 'knowledge' }) as any;
  assert.equal(typeof r.deleted, 'number');
});

test('vectors backend: admin rejects unknown op + bad delete type', async () => {
  const be = new VectorsBackend();
  await assert.rejects(() => be.admin('vectors', 'nope'), /unknown admin op/i);
  await assert.rejects(() => be.admin('vectors', 'delete-all-by-type', { type: 'bogus' }), /type must be/i);
});

test('vectors backend: sync hooks throw', async () => {
  const be = new VectorsBackend();
  await assert.rejects(() => be.exportSince('vectors'), /SYNC_NOT_SUPPORTED/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/vectors-backend.test.js`
Expected: FAIL — `Cannot find module '.../vectors-backend'`.

- [ ] **Step 3: Create `core/src/data/backends/vectors-backend.ts`**

```typescript
// core/src/data/backends/vectors-backend.ts
// System-dataset adapter over the EXISTING vector store (getVectorStore). Vectors are derived,
// bulk-managed data: there is no clean per-record generic identity, so get/put/delete are
// NOT_SUPPORTED and all mutation flows through declared `admin` ops that delegate to the store.
import type {
  StorageBackend, BackendKind, DatasetDescriptor, DataRecord, QuerySpec, SearchSpec, NodeOrigin,
} from '../types';
import { applyQuery } from './query-filter';
import { getVectorStore } from '../../vector/vector-store';

function vectorHitToRecord(h: any): DataRecord & { score: number } {
  return {
    id: h.knowledgeId || h.partId || h.sessionId || '',
    version: 1,
    fields: { type: h.type, contentType: h.contentType, sessionId: h.sessionId, knowledgeId: h.knowledgeId, partId: h.partId, origin: h.origin },
    text: h.text,
    createdAt: h.timestamp || '', updatedAt: h.timestamp || '',
    score: h.score,
  };
}

export class VectorsBackend implements StorageBackend {
  readonly kind: BackendKind = 'vectors';

  async createDataset(_d: DatasetDescriptor): Promise<void> { /* store self-manages */ }
  async dropDataset(_id: string): Promise<void> { /* never drop the vector store */ }

  async get(_dataset: string, _id: string): Promise<DataRecord | null> {
    throw new Error('NOT_SUPPORTED: vectors are bulk-managed; use search/query or data_admin ops');
  }
  async put(_dataset: string, _record: DataRecord): Promise<{ id: string }> {
    throw new Error('NOT_SUPPORTED: vectors are derived data; they are (re)built via the knowledge/session pipelines, not written directly');
  }
  async delete(_dataset: string, _id: string): Promise<boolean> {
    throw new Error('NOT_SUPPORTED: delete vectors via data_admin ops (delete-knowledge/delete-session/delete-all-by-type)');
  }

  async query(_dataset: string, q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }> {
    // No raw record listing; query is FTS-only over the vector text via the store's pure search,
    // then the shared filter/sort/limit is applied. Without a query string, returns empty.
    if (!q.fts) return { records: [], total: 0 };
    const hits = await getVectorStore().search(q.fts, q.limit ?? 50);
    return applyQuery(hits.map(vectorHitToRecord), q);
  }

  async search(_dataset: string, s: SearchSpec): Promise<Array<DataRecord & { score: number }>> {
    const hits = await getVectorStore().hybridSearch(s.query, s.limit ?? 20);
    return hits.map(vectorHitToRecord);
  }

  async admin(_dataset: string, op: string, args?: Record<string, unknown>): Promise<unknown> {
    const a = args || {};
    const store = getVectorStore();
    switch (op) {
      case 'stats':
        return await store.getStatsByType();
      case 'rebuild-fts':
        await store.rebuildFtsIndex();
        return { ok: true };
      case 'delete-knowledge':
        return { deleted: await store.deleteKnowledge(String(a.knowledgeId || '')) };
      case 'delete-session':
        return { deleted: await store.deleteSession(String(a.sessionId || '')) };
      case 'delete-all-by-type': {
        const t = String(a.type || '');
        if (t !== 'session' && t !== 'knowledge') throw new Error("delete-all-by-type: type must be 'session' or 'knowledge'");
        return { deleted: await store.deleteAllByType(t) };
      }
      default:
        throw new Error(`unknown admin op: ${op}`);
    }
  }

  async exportSince(_dataset: string, _since?: string): Promise<DataRecord[]> {
    throw new Error('SYNC_NOT_SUPPORTED: vectors is a system dataset');
  }
  async importBatch(_dataset: string, _records: DataRecord[], _origin: NodeOrigin): Promise<{ applied: number; skipped: number }> {
    throw new Error('SYNC_NOT_SUPPORTED: vectors is a system dataset');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/vectors-backend.test.js`
Expected: PASS — NOT_SUPPORTED on get/put/delete; admin stats/delete-all-by-type/unknown-op/bad-type; sync throws.

- [ ] **Step 5: Commit**

```bash
git add core/src/data/backends/vectors-backend.ts core/src/__tests__/data/vectors-backend.test.ts
git commit -m "feat(data): VectorsBackend adapter — query/search + admin ops (stats/rebuild-fts/delete-*); record ops NOT_SUPPORTED"
```

---

### Task 5: Auto-register system datasets + wire the adapters into `getDataService`

**Files:**
- Create: `core/src/data/system-datasets.ts`
- Modify: `core/src/data/data-service.ts` (register adapters; call `ensureSystemDatasets`)
- Modify: `core/src/data/dataset-registry.ts` — ONLY if `create` rejects re-creating an existing id without an idempotent path; otherwise `ensureSystemDatasets` guards with `get()` first (preferred — no registry change).
- Test: `core/src/__tests__/data/system-datasets.test.ts`

**Interfaces:**
- Consumes: `DatasetRegistry`.
- Produces: `SYSTEM_DATASETS: Array<{ id, backend, config, title }>` + `ensureSystemDatasets(registry: DatasetRegistry): void` (idempotent). `getDataService()` registers `KnowledgeBackend`+`VectorsBackend` and calls `ensureSystemDatasets`.

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/data/system-datasets.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ensureSystemDatasets, SYSTEM_DATASETS } from '../../data/system-datasets';
import { DatasetRegistry } from '../../data/dataset-registry';

function reg() { return new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sysd-')), 'd.json')); }

test('system datasets: registers knowledge + vectors with the gating ACL, idempotently', () => {
  const r = reg();
  ensureSystemDatasets(r);
  ensureSystemDatasets(r); // second call must not throw or duplicate
  const ids = r.list().map((d) => d.id).sort();
  assert.ok(ids.includes('knowledge'));
  assert.ok(ids.includes('vectors'));

  const k = r.get('knowledge')!;
  assert.equal(k.system, true);
  assert.equal(k.readOnly ?? false, false);  // NOT readOnly (manage must be allowed)
  assert.equal(k.syncMode, 'none');
  // gating: cloud/* gets read/query/search; local gets write/delete/manage
  const star = k.acl.find((a: any) => a.principal === '*');
  const local = k.acl.find((a: any) => a.principal === 'local');
  assert.deepEqual(star?.actions.sort(), ['query', 'read', 'search']);
  assert.ok(local?.actions.includes('manage'));
});

test('system datasets: SYSTEM_DATASETS declares knowledge + vectors backends', () => {
  const byId = Object.fromEntries(SYSTEM_DATASETS.map((s) => [s.id, s.backend]));
  assert.equal(byId.knowledge, 'knowledge');
  assert.equal(byId.vectors, 'vectors');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/system-datasets.test.js`
Expected: FAIL — `Cannot find module '.../system-datasets'`.

- [ ] **Step 3: Create `core/src/data/system-datasets.ts`**

```typescript
// core/src/data/system-datasets.ts
// Reserved system datasets that expose existing stores through the generic data service.
// Registered idempotently at service init. Gating: read open to all authed callers;
// write/delete/manage local-only by default (an operator adds a cloud { userId, actions } rule to grant more).
import type { DatasetRegistry } from './dataset-registry';
import type { BackendKind, BackendConfig, AclRule } from './types';

const GATING_ACL: AclRule[] = [
  { principal: '*', actions: ['read', 'query', 'search'] },
  { principal: 'local', actions: ['write', 'delete', 'manage'] },
];

export const SYSTEM_DATASETS: Array<{ id: string; backend: BackendKind; config: BackendConfig; title: string }> = [
  { id: 'knowledge', backend: 'knowledge', config: { kind: 'knowledge' }, title: 'Knowledge base (system)' },
  { id: 'vectors', backend: 'vectors', config: { kind: 'vectors' }, title: 'Vector index (system)' },
];

/** Idempotently ensure the reserved system datasets exist in the registry. */
export function ensureSystemDatasets(registry: DatasetRegistry): void {
  for (const s of SYSTEM_DATASETS) {
    if (registry.get(s.id)) continue;
    registry.create({
      id: s.id, backend: s.backend, title: s.title,
      visibility: 'cross-node-readable', // reads allowed cross-node; mutate/manage still ACL+key gated
      system: true,
      config: s.config,
      acl: GATING_ACL.map((a) => ({ ...a, actions: [...a.actions] })),
      syncMode: 'none',
    });
  }
}
```

> NOTE TO IMPLEMENTER: confirm `DatasetRegistry.create` accepts `system` + `syncMode` (M5 added `syncMode`; M1 had `system` on the descriptor). If `create`'s input type omits `system`, add `system?: boolean` to its `CreateDatasetInput` (the registry already stores it on the descriptor — `types.ts` `DatasetDescriptor.system`). Make the minimal change so `ensureSystemDatasets` compiles and the stored descriptor has `system: true`.

- [ ] **Step 4: Wire into `getDataService()`**

In `core/src/data/data-service.ts`, in `getDataService()`:
1. Add imports near the other backend imports:
```typescript
import { KnowledgeBackend } from './backends/knowledge-backend';
import { VectorsBackend } from './backends/vectors-backend';
import { ensureSystemDatasets } from './system-datasets';
```
2. Register the adapters after the existing `backends.register(new VectorBackend());`:
```typescript
    backends.register(new KnowledgeBackend());
    backends.register(new VectorsBackend());
```
3. After the `datasets` registry is obtained (right after `const datasets = getDatasetRegistry();`), ensure the system datasets exist:
```typescript
    ensureSystemDatasets(datasets);
```

- [ ] **Step 5: Run tests + the full data suite**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/system-datasets.test.js dist-test/__tests__/data/data-service.test.js dist-test/__tests__/data/data-tools.test.js`
Expected: PASS — system-datasets tests green; existing data-service + data-tools tests still green (the singleton now also registers the adapters + system datasets; cache/vector tests unaffected). NOTE: tests that use the `getDataService()` singleton will now find `knowledge`+`vectors` in the catalog — confirm no existing assertion does an exact-equality on the singleton catalog that would break (the data-service.test.ts uses hand-wired registries, so it is unaffected; data-tools.test.ts asserts on specific dataset ids it creates, not the full catalog).

- [ ] **Step 6: Commit**

```bash
git add core/src/data/system-datasets.ts core/src/data/data-service.ts core/src/data/dataset-registry.ts core/src/__tests__/data/system-datasets.test.ts
git commit -m "feat(data): auto-register knowledge+vectors system datasets; wire adapters into getDataService"
```

---

### Task 6: `POST /data/:dataset/admin` route + `data_admin` MCP tool

**Files:**
- Modify: `core/src/routes/core/data.routes.ts` (add the admin route after `/search`)
- Modify: `core/src/mcp-server/tools/data-tools.ts` (add `data_admin` def + handler)
- Modify: `core/src/__tests__/data/data-tools.test.ts` (bump to 8 tools; add a `data_admin` test)
- Test: `core/src/__tests__/data/data-tools.test.ts`

**Interfaces:**
- Consumes: `DataService.admin`.
- Produces: `POST /data/:dataset/admin {op, args}` → `{ result }`; MCP tool `data_admin`.

- [ ] **Step 1: Write the failing test**

Update the tool-count assertion in `data-tools.test.ts` (now 8, sorted, includes `data_admin`):

```typescript
test('data tools: the 8 expected tools are defined and mapped', () => {
  const names = DATA_TOOL_DEFS.map((d) => d.name).sort();
  assert.deepEqual(names, ['data_admin', 'data_catalog', 'data_delete', 'data_get', 'data_put', 'data_query', 'data_request_access', 'data_search']);
  for (const n of names) assert.equal(typeof DATA_HANDLERS[n], 'function');
});
```

Append a behavior test — `data_admin` on the auto-registered `knowledge` system dataset, locally, runs `stats`:

```typescript
test('data tools: data_admin runs a system-dataset op (knowledge stats) for a local caller', async () => {
  enable();
  const r = await runWithMcpContext({ principal: { type: 'local' } }, () =>
    DATA_HANDLERS.data_admin({ dataset: 'knowledge', op: 'stats' }));
  assert.equal(r.isError ?? false, false);
  assert.match(textOf(r), /"total"/);
});

test('data tools: data_admin requires dataset and op', async () => {
  enable();
  const miss = await runWithMcpContext({ principal: { type: 'local' } }, () =>
    DATA_HANDLERS.data_admin({ dataset: 'knowledge' }));
  assert.equal(miss.isError, true);
  assert.match(textOf(miss), /op is required/);
});
```

> NOTE: this test relies on the `getDataService()` singleton having the `knowledge` system dataset auto-registered (Task 5) and a real `getKnowledgeStore()` (which reads `LM_ASSIST_DATA_DIR`, set at the top of `data-tools.test.ts` to a temp dir). `stats` only lists docs — no embedder, no network — so it stays hermetic/model-free.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/data-tools.test.js`
Expected: FAIL — `DATA_HANDLERS.data_admin` is undefined; the 8-tool `deepEqual` fails.

- [ ] **Step 3: Add the `data_admin` MCP handler + def**

In `core/src/mcp-server/tools/data-tools.ts`:

Add the handler (after `handleDataDelete`):

```typescript
async function handleDataAdmin(args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = ctxFromArgs(args);
  if ('error' in ctx) return err(ctx.error);
  const svc = getDataService();
  if (!svc.isEnabled()) return err('data service is disabled');
  const dataset = String(args.dataset || '');
  const op = String(args.op || '');
  if (!dataset) return err('dataset is required');
  if (!op) return err('op is required');
  const opArgs = (args.args && typeof args.args === 'object' ? args.args : undefined) as Record<string, unknown> | undefined;
  const r = await svc.admin(ctx, dataset, op, opArgs);
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  return ok(pretty(r.value));
}
```

Add the tool def to `DATA_TOOL_DEFS` (after `data_delete`):

```typescript
  {
    name: 'data_admin',
    description: 'Run a declared maintenance op on a (system) dataset — break-glass management of the existing knowledge/vectors stores. knowledge ops: stats, add-comment, regenerate, dedup, review, remote-sync. vectors ops: stats, rebuild-fts, delete-knowledge, delete-session, delete-all-by-type. Requires the manage action (local by default; cloud only via an explicit operator ACL rule + key).',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object' as const,
      properties: {
        dataset: STR('System dataset id (e.g. "knowledge" or "vectors").'),
        op: STR('The maintenance op to run.'),
        args: { type: 'object' as const, description: 'Op-specific arguments (e.g. { knowledgeId } for regenerate, { type } for delete-all-by-type).' },
        key: STR('Access key granting manage (omit if local).'),
      },
      required: ['dataset', 'op'],
    },
  },
```

Add to `DATA_HANDLERS`:

```typescript
  data_admin: handleDataAdmin,
```

- [ ] **Step 4: Add the REST route**

In `core/src/routes/core/data.routes.ts`, after the `POST /data/:dataset/search` route:

```typescript
    // POST /data/:dataset/admin — run a declared store-specific maintenance op (manage-gated; goal-8 LLM management)
    {
      method: 'POST',
      pattern: /^\/data\/(?<dataset>[^/]+)\/admin$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const b = req.body || {};
        const op = typeof b.op === 'string' ? b.op : '';
        if (!op) return wrapError('BAD_REQUEST', 'op is required', start);
        const opArgs = (b.args && typeof b.args === 'object') ? b.args : undefined;
        const r = await svc().admin(ctxOf(req), req.params.dataset, op, opArgs);
        if (!r.ok) return wrapError(r.code, r.reason, start);
        return wrapResponse({ result: r.value }, start);
      },
    },
```

- [ ] **Step 5: Run the full data suite + production build**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/`
Expected: PASS — all data tests green incl. the 8-tool assertion + the `data_admin` knowledge-stats test.
Then: `cd /home/ubuntu/lm-assist && ./core.sh build`
Expected: tsc clean.

- [ ] **Step 6: Commit**

```bash
git add core/src/routes/core/data.routes.ts core/src/mcp-server/tools/data-tools.ts core/src/__tests__/data/data-tools.test.ts
git commit -m "feat(data): POST /data/:dataset/admin route + data_admin MCP tool (goal-8 break-glass management)"
```

---

## Post-Plan: Controller Verification (not a coding task)

After all 6 tasks pass review, the controller runs a live dev-server check (dev `:3200`, real stores):
1. `./core.sh restart`; confirm `GET /data/catalog` now lists `knowledge` + `vectors` as `system` datasets with the gating ACL.
2. `POST /data/knowledge/admin {op:'stats'}` → counts; `POST /data/vectors/admin {op:'stats'}` → vector counts by type.
3. `POST /data/knowledge/query` and `/data/knowledge/records/:id` → inspect real knowledge entries (redacted).
4. Confirm `data_admin` is live over MCP (local → runs op; cloud without a manage key → denied).
5. Confirm the existing `/knowledge/*` routes + `search`/`detail`/`feedback` tools are byte-stable (regression: a couple of existing knowledge route calls still return the same shape).

This is folded into the single combined M2 deploy + e2e after M2c is also built.
