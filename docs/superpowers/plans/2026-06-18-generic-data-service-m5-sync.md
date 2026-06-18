# Generic Data Service — M5 (Engine-Level Cross-Node Sync) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add cross-node dataset sync as a **data-engine** capability (not an app-level copy of knowledge remote-sync): generic backend `exportSince`/`importBatch` hooks, a backend-agnostic sync engine driven by a `syncMode` (`none`/`full`/`partial`), per-record `version`+`updatedAt` last-writer-wins protection, and batched periodic `dataset_updated` events over the hub — so any dataset on any backend syncs by setting one flag.

**Architecture:** Sync lives in `core/src/data/` (the engine), not in any app. Each `StorageBackend` implements `exportSince`/`importBatch` once; a backend-agnostic `SyncEngine` discovers peers via the hub, pulls `full` datasets into read-only local replicas, and (for `partial`) does local-first/remote-fallback reads with lazy caching. Writes are single-writer (owner node) and carry a monotonic `version`; `importBatch` applies a record only if it is strictly newer (LWW), making batched/re-delivered events idempotent. A dirty-queue + one periodic flush timer emits batched `dataset_updated` events; a slower reconcile-pull self-heals. **Knowledge's `remote-sync.ts` is left untouched** — this is a separate generic engine.

**Tech Stack:** TypeScript (CommonJS); reuses M1 (`core/src/data/`), the hub-client + `/api/tier-agent/machines/{id}/proxy` mechanism, and the memory-autosync `memory_updated` pattern. **No new dependencies.** Builds on the deployed M1+M4.

## Global Constraints

- CommonJS; only CJS/built-in imports; no new npm deps. Tests: `node:test` + `node:assert/strict`, under `core/src/__tests__/data/`, hermetic via `process.env.LM_ASSIST_DATA_DIR`.
- Do **not** modify `core/src/knowledge/**` or `core/src/vector/**`. Do **not** touch the M1 enforcement logic (`access-manager.ts`) except where this plan adds a new action/flag explicitly.
- **Single-writer model:** a dataset is written only on its `ownerNode`; replicas on other nodes are **read-only**. The engine enforces this — a write to a replica (origin=remote) is rejected.
- **LWW determinism:** conflict order is `version` desc, then `updatedAt` desc, then `ownerNode` desc. `importBatch` applies a record only if strictly newer than the local copy; equal/older is skipped (idempotent).
- **`version` is engine-owned:** callers never set it. A local write computes `version = prev + 1`; a replica import preserves the source `version`. `createdAt` is preserved across updates.
- Transport for sync is the hub machine-proxy (`GET https://<hub-http>/api/tier-agent/machines/{gatewayId}/proxy/<path>` with `Authorization: Bearer <hub apiKey>`), reaching a peer's `/data/*` routes (already relay-allowed). The engine takes a `PeerClient` dependency so unit tests inject a fake (no real hub).
- Build/test as in M1: `cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/data/<file>.test.js`.
- Sync period + reconcile interval are configurable via project-settings (`dataSyncPeriodSec` default 15, `dataReconcileSec` default 300); both default-on only when `dataServiceEnabled`.

---

## File Structure

**Modify:**
- `core/src/data/types.ts` — add `version` to `DataRecord`; add `syncMode` + helpers; extend `StorageBackend` with `exportSince`/`importBatch`; add `NodeInfo`, `PeerClient`, `DatasetManifestEntry`, `SyncStatus`.
- `core/src/data/backends/cache-backend.ts` — implement `exportSince`/`importBatch`.
- `core/src/data/data-service.ts` — versioned `put` (engine-owned version + createdAt preserve + reject replica writes); `partial` read-through in `get`; expose sync entrypoints.
- `core/src/data/dataset-registry.ts` — `syncMode` in descriptor + `CreateDatasetInput`; mark/track replica descriptors.
- `core/src/routes/core/data.routes.ts` — `GET /data/:dataset/export`, `GET /data/sync/manifest`, `POST /data/sync`, `GET /data/sync/status`.
- `core/src/hub-client/index.ts` — `sendDatasetUpdated(...)` + a `dataset_updated` receive→emit, mirroring `sendMemoryUpdated`/`memory_updated`.
- `core/src/data/paths.ts` — `remoteDir(node, dataset)` replica path helper.
- `core/src/rest-server.ts` (or the boot path) — start the sync engine when `dataServiceEnabled` + hub configured.
- `core/src/project-settings.ts` — `dataSyncPeriodSec`, `dataReconcileSec`.

**Create:**
- `core/src/data/sync-queue.ts` — dirty-change queue + batched periodic flush.
- `core/src/data/peer-client.ts` — `HubPeerClient` (hub-proxy impl of `PeerClient`).
- `core/src/data/sync-engine.ts` — backend-agnostic engine (reconcile/pull/import; full + partial).
- `core/src/__tests__/data/*.test.ts` — one per task.

---

## Task 1: Per-record `version` + versioned, createdAt-preserving `put`

**Files:** Modify `core/src/data/types.ts`, `core/src/data/data-service.ts`; Test `core/src/__tests__/data/versioning.test.ts`.

**Interfaces:**
- Consumes: M1 `DataRecord`, `DataService`, `CacheBackend`.
- Produces: `DataRecord.version: number`; an exported `isNewer(incoming: DataRecord, local: DataRecord | null): boolean` in `types.ts`; `DataService.put` now engine-owns `version`/`createdAt`/`updatedAt` and rejects writes to replicas.

- [ ] **Step 1: Add `version` + `isNewer` to `types.ts`**

In `DataRecord`, add `version: number;` (after `id`). Add the LWW comparator + a sync-mode type:
```typescript
export type SyncMode = 'none' | 'full' | 'partial';

/** LWW order: version desc, then updatedAt desc, then ownerNode desc. True iff `incoming` should win. */
export function isNewer(incoming: { version: number; updatedAt: string; origin?: NodeOrigin },
                        local: { version: number; updatedAt: string; origin?: NodeOrigin } | null): boolean {
  if (!local) return true;
  if (incoming.version !== local.version) return incoming.version > local.version;
  if (incoming.updatedAt !== local.updatedAt) return incoming.updatedAt > local.updatedAt;
  return (incoming.origin?.machineId || '') > (local.origin?.machineId || '');
}
```

- [ ] **Step 2: Write the failing test** `core/src/__tests__/data/versioning.test.ts`

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ver-'));
import { isNewer } from '../../data/types';
import { DataService } from '../../data/data-service';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { DatasetRegistry } from '../../data/dataset-registry';
import { KeyStore } from '../../data/key-store';
import { AccessManager } from '../../data/access-manager';

function svc() {
  const datasets = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(),'r-')),'d.json'));
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(),'k-')));
  const backends = new BackendRegistry(); backends.register(new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(),'c-'))));
  const s = new DataService({ datasets, backends, manager: new AccessManager({ datasets, keys, nodeId: 'n1' }) });
  (s as any).enabledOverride = true; return { s, datasets };
}

test('isNewer: version then updatedAt then ownerNode', () => {
  const r = (v:number,u:string,m='a') => ({version:v,updatedAt:u,origin:{machineId:m,hostname:'',os:''}});
  assert.equal(isNewer(r(2,'t'), r(1,'t')), true);
  assert.equal(isNewer(r(1,'t'), r(2,'t')), false);
  assert.equal(isNewer(r(1,'2026-02'), r(1,'2026-01')), true);
  assert.equal(isNewer(r(1,'t','b'), r(1,'t','a')), true);
  assert.equal(isNewer(r(1,'t','a'), r(1,'t','a')), false);
  assert.equal(isNewer(r(1,'t'), null), true);
});

test('put: engine assigns version 1,2,... preserves createdAt, bumps updatedAt', async () => {
  const { s, datasets } = svc();
  datasets.create({ id:'d', backend:'cache', visibility:'local-only', config:{kind:'cache'}, acl:[] });
  const ctx = { principal: { type:'local' as const } };
  const p1 = await s.put(ctx, 'd', { id:'a', fields:{x:1}, createdAt:'ignored', updatedAt:'ignored', version:99 } as any);
  assert.equal(p1.ok, true);
  const g1 = await s.get(ctx, 'd', 'a'); if (!g1.ok || !g1.value) throw new Error('no g1');
  assert.equal(g1.value.version, 1);
  const created = g1.value.createdAt;
  await s.put(ctx, 'd', { id:'a', fields:{x:2} } as any);
  const g2 = await s.get(ctx, 'd', 'a'); if (!g2.ok || !g2.value) throw new Error('no g2');
  assert.equal(g2.value.version, 2);
  assert.equal(g2.value.createdAt, created);          // preserved
  assert.ok(g2.value.updatedAt >= g1.value!.updatedAt); // bumped
});
```

- [ ] **Step 3: Run to verify it fails** — `cd core && npm run build:test` → build error (`version` missing / `isNewer` not found).

- [ ] **Step 4: Implement versioned `put` in `data-service.ts`**

Read the current `put`. Replace its body so the engine owns version/timestamps and rejects replica writes:
```typescript
  async put(ctx: CallCtx, datasetId: string, record: DataRecord): Promise<DataResult<{ id: string }>> {
    const a = await this.authorize(ctx, datasetId, 'write');
    if (!a.ok) return a;
    const d = this.deps.datasets.get(datasetId)!;
    if (d.origin) return { ok: false, code: 'READ_ONLY_REPLICA', reason: `dataset "${datasetId}" is a remote replica (read-only)` };
    const existing = await a.value.backend!.get(datasetId, record.id);
    const now = new Date().toISOString();
    const versioned: DataRecord = {
      ...record,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      origin: undefined, // local-owned record (origin is stamped only on replicas)
    };
    const r = await a.value.backend!.put(datasetId, versioned);
    this.deps.onLocalWrite?.(datasetId, record.id); // sync-queue hook (Task 5); optional
    return { ok: true, value: r };
  }
```
Add `onLocalWrite?: (dataset: string, id: string) => void;` to the `DataService` constructor deps type (optional; wired in Task 5). `DatasetDescriptor.origin` is the replica marker (added in Task 3 — for Task 1, reference it via an optional read: use `(d as any).origin`; Task 3 adds the typed field). To keep Task 1 self-contained, treat `d.origin` as optional now.

- [ ] **Step 5: Run to verify it passes** — `cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/data/versioning.test.js` → 2 tests pass. Also `npm run build` clean. Confirm existing M1/M4 suites still pass: `node --test dist-test/__tests__/data/data-service.test.js dist-test/__tests__/data/data-tools.test.js`.

- [ ] **Step 6: Commit** — `git add -A core/src/data/types.ts core/src/data/data-service.ts core/src/__tests__/data/versioning.test.ts && git commit -m "feat(data): per-record version + engine-owned versioned put (LWW isNewer)"`

---

## Task 2: Backend sync hooks (`exportSince`/`importBatch`) + export/manifest routes

**Files:** Modify `core/src/data/types.ts` (StorageBackend), `core/src/data/backends/cache-backend.ts`, `core/src/data/paths.ts`, `core/src/routes/core/data.routes.ts`; Test `core/src/__tests__/data/sync-hooks.test.ts`.

**Interfaces:**
- Produces: `StorageBackend.exportSince(dataset, since?: string): Promise<DataRecord[]>` (records with `updatedAt >= since`, ascending), `StorageBackend.importBatch(dataset, records: DataRecord[], origin: NodeOrigin): Promise<{ applied: number; skipped: number }>` (LWW-guarded, stamps `origin`); `paths.remoteDir(node, dataset)`; routes `GET /data/:dataset/export`, `GET /data/sync/manifest`.

- [ ] **Step 1: Extend `StorageBackend` in `types.ts`**
```typescript
  exportSince(dataset: string, since?: string): Promise<DataRecord[]>;
  importBatch(dataset: string, records: DataRecord[], origin: NodeOrigin): Promise<{ applied: number; skipped: number }>;
  // add `manifestHint?(dataset): Promise<{ maxUpdatedAt: string; count: number }>` is OPTIONAL; skip for M5.
```

- [ ] **Step 2: Write the failing test** `core/src/__tests__/data/sync-hooks.test.ts`
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os'; import * as path from 'path'; import * as fs from 'fs';
import { CacheBackend } from '../../data/backends/cache-backend';
import type { DataRecord, DatasetDescriptor, NodeOrigin } from '../../data/types';
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'lm-sh-'));}
function d(id:string):DatasetDescriptor{return {id,backend:'cache',ownerNode:'n',visibility:'local-only',config:{kind:'cache'},acl:[],createdAt:'t',updatedAt:'t'};}
function rec(id:string,v:number,u:string):DataRecord{return {id,version:v,fields:{},createdAt:'t',updatedAt:u};}
const ORIGIN:NodeOrigin={machineId:'peerA',hostname:'h',os:'linux'};

test('exportSince returns records with updatedAt >= since, ascending', async () => {
  const be=new CacheBackend(tmp()); await be.createDataset(d('x'));
  await be.put('x',rec('a',1,'2026-01-01')); await be.put('x',rec('b',1,'2026-02-01')); await be.put('x',rec('c',1,'2026-03-01'));
  const all=await be.exportSince('x'); assert.equal(all.length,3);
  const since=await be.exportSince('x','2026-02-01'); assert.deepEqual(since.map(r=>r.id),['b','c']);
});

test('importBatch applies only strictly-newer (LWW), stamps origin', async () => {
  const be=new CacheBackend(tmp()); await be.createDataset(d('y'));
  const r1=await be.importBatch('y',[rec('a',1,'2026-01-01')],ORIGIN);
  assert.deepEqual(r1,{applied:1,skipped:0});
  const got=await be.get('y','a'); assert.equal(got?.origin?.machineId,'peerA'); // stamped
  const r2=await be.importBatch('y',[rec('a',1,'2026-01-01')],ORIGIN); // same version -> skip
  assert.deepEqual(r2,{applied:0,skipped:1});
  const r3=await be.importBatch('y',[rec('a',2,'2026-01-01')],ORIGIN); // newer version -> apply
  assert.deepEqual(r3,{applied:1,skipped:0});
  assert.equal((await be.get('y','a'))?.version,2);
});
```

- [ ] **Step 3: Run to verify it fails** — build error (methods missing).

- [ ] **Step 4: Implement in `cache-backend.ts`** (add `import { isNewer } from '../types';`)
```typescript
  async exportSince(dataset: string, since?: string): Promise<DataRecord[]> {
    const { db } = this.envFor(dataset);
    const rows: DataRecord[] = [];
    for (const { value } of db.getRange()) {
      const r = value as DataRecord;
      if (!since || r.updatedAt >= since) rows.push(r);
    }
    rows.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
    return rows;
  }
  async importBatch(dataset: string, records: DataRecord[], origin: NodeOrigin): Promise<{ applied: number; skipped: number }> {
    const { db } = this.envFor(dataset);
    let applied = 0, skipped = 0;
    for (const incoming of records) {
      const local = (db.get(incoming.id) as DataRecord | undefined) ?? null;
      const stamped: DataRecord = { ...incoming, origin };
      if (isNewer(stamped, local)) { await db.put(incoming.id, stamped); applied++; } else skipped++;
    }
    return { applied, skipped };
  }
```
Add `NodeOrigin` to the cache-backend type imports.

- [ ] **Step 5: Add `remoteDir` to `paths.ts`**
```typescript
export function remoteDir(node: string, datasetId: string): string {
  return path.join(dataRoot(), 'remote', node, `${datasetId}.lmdb`);
}
```

- [ ] **Step 6: Add export + manifest routes to `data.routes.ts`** (both require `read`/`query`; gated by `enforce`)
```typescript
    // GET /data/:dataset/export?since=ISO  — records changed since watermark (for sync pull)
    {
      method: 'GET',
      pattern: /^\/data\/(?<dataset>[^/]+)\/export$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const r = await svc().exportDataset(ctxOf(req), req.params.dataset, req.query?.since);
        if (!r.ok) return wrapError(r.code, r.reason, start);
        return wrapResponse({ records: r.value }, start);
      },
    },
    // GET /data/sync/manifest — this node's syncable (full/partial) datasets
    {
      method: 'GET',
      pattern: /^\/data\/sync\/manifest$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        return wrapResponse({ node: svc().nodeId(), datasets: svc().syncManifest(svc().resolvePrincipal(req)) }, start);
      },
    },
```
Add `DataService.exportDataset(ctx, dataset, since)` (authorizes `read`, returns `backend.exportSince`), `DataService.nodeId()` (returns `thisNodeId()`), and `DataService.syncManifest(principal)` (returns `[{id, syncMode, ownerNode, backend}]` for datasets with `syncMode !== 'none'` the principal may read). Implement these thin methods on `DataService`.

- [ ] **Step 7: Run + commit** — focused suite + `npm run build`; `git add -A && git commit -m "feat(data): backend exportSince/importBatch (LWW) + export+manifest routes + remoteDir"`

---

## Task 3: `syncMode` on datasets + replica descriptors

**Files:** Modify `core/src/data/types.ts`, `core/src/data/dataset-registry.ts`; Test `core/src/__tests__/data/syncmode-registry.test.ts`.

**Interfaces:** `DatasetDescriptor` gains `syncMode?: SyncMode` (default `'none'`) and `origin?: NodeOrigin` (set ⇒ this descriptor is a remote replica, read-only). `CreateDatasetInput` gains `syncMode?`. `DatasetRegistry` gains `upsertReplica(input)` to register/track a replica descriptor.

- [ ] **Step 1: failing test** — create with `syncMode:'full'` persists; `upsertReplica` creates an `origin`-stamped, read-only replica descriptor; `list` includes it.
```typescript
import { test } from 'node:test'; import assert from 'node:assert/strict';
import * as os from 'os'; import * as path from 'path'; import * as fs from 'fs';
import { DatasetRegistry } from '../../data/dataset-registry';
function f(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lm-sm-'));return path.join(dir,'d.json');}
test('syncMode persists; default none', () => {
  const r=new DatasetRegistry(f());
  const a=r.create({id:'a',backend:'cache',config:{kind:'cache'}}); assert.equal(a.syncMode,'none');
  const b=r.create({id:'b',backend:'cache',config:{kind:'cache'},syncMode:'full'}); assert.equal(b.syncMode,'full');
});
test('upsertReplica registers a read-only remote replica', () => {
  const r=new DatasetRegistry(f());
  const rep=r.upsertReplica({id:'tickets',backend:'cache',ownerNode:'peerA',syncMode:'full',config:{kind:'cache'},origin:{machineId:'peerA',hostname:'h',os:'linux'}});
  assert.equal(rep.origin?.machineId,'peerA'); assert.equal(rep.ownerNode,'peerA');
  assert.equal(r.get('tickets')?.origin?.machineId,'peerA');
});
```

- [ ] **Step 2: run→fail; Step 3: implement** — add `syncMode` (default `'none'`) + `origin` to the descriptor build in `create`; add `upsertReplica(input)` that builds a descriptor with `origin` set + `ownerNode` = the peer (not `thisNodeId()`), upserts by id (replace if exists). **Step 4: run→pass; Step 5: commit** `feat(data): syncMode + replica descriptors in dataset registry`.

---

## Task 4: `PeerClient` + `SyncEngine` (full-mode pull/import)

**Files:** Modify `core/src/data/types.ts` (PeerClient, NodeInfo, SyncStatus); Create `core/src/data/peer-client.ts`, `core/src/data/sync-engine.ts`; Test `core/src/__tests__/data/sync-engine.test.ts`.

**Interfaces:**
- `interface NodeInfo { node: string; hostname: string; platform: string; }`
- `interface PeerClient { listPeers(): Promise<NodeInfo[]>; manifest(node: string): Promise<{ node: string; datasets: Array<{ id: string; syncMode: SyncMode; ownerNode: string; backend: BackendKind }> }>; exportFrom(node: string, dataset: string, since?: string): Promise<DataRecord[]>; getFrom(node: string, dataset: string, id: string): Promise<DataRecord | null>; }`
- `class SyncEngine { constructor(deps: { datasets: DatasetRegistry; backends: BackendRegistry; peers: PeerClient; nodeId: string }); reconcile(): Promise<SyncStatus>; pullDataset(node: string, dataset: string): Promise<{ applied: number; skipped: number }>; status(): SyncStatus; }`

- [ ] **Step 1: failing test** `sync-engine.test.ts` — two in-process services (node A owns a `full` dataset with records; node B empty). A fake `PeerClient` bridges B→A (its `manifest`/`exportFrom`/`getFrom` read A's registry+backend directly). Run `engineB.reconcile()` → B has a read-only replica of A's dataset with the same records+versions; re-running reconcile applies 0 (idempotent); update a record on A (version bumps) + reconcile → B's replica updates.
```typescript
// Build serviceA + serviceB (each its own registries/backends/temp dirs, like svc() helpers).
// fakePeerForB = { listPeers:()=>[{node:'A',...}], manifest:(n)=>({node:'A',datasets:[{id:'tickets',syncMode:'full',ownerNode:'A',backend:'cache'}]}),
//   exportFrom:(n,ds,since)=>backendA.exportSince(ds,since), getFrom:(n,ds,id)=>backendA.get(ds,id) }
// Assert: after engineB.reconcile(), datasetsB.get('tickets').origin.machineId==='A' (replica) and getB('tickets','r1') matches A; second reconcile -> applied 0; bump r1 on A -> reconcile -> B sees new version.
```
(Write the full bodies following the M1 `svc()` helper pattern + the assertions above.)

- [ ] **Step 2: run→fail.**
- [ ] **Step 3: implement `sync-engine.ts`** — `reconcile()`: `peers.listPeers()` → for each peer `manifest(node)` → for each `full` dataset: ensure a local replica descriptor via `datasets.upsertReplica({id,backend,ownerNode:peerOwner,syncMode:'full',config,origin:{machineId:node,...}})`; compute watermark = max `updatedAt` currently in the local replica (via `backend.exportSince(ds)` max, or a stored cursor); `records = peers.exportFrom(node, ds, watermark)`; `backend.importBatch(ds, records, origin)`. Aggregate applied/skipped into `SyncStatus`. `pullDataset(node,ds)` = the per-dataset slice (used by the event handler in Task 5). Keep it backend-agnostic (only uses `BackendRegistry.get(d.backend)` + the hooks). **Step 4: run→pass; Step 5: commit** `feat(data): SyncEngine full-mode pull + PeerClient contract`.
- [ ] **Step 6: implement `peer-client.ts`** — `HubPeerClient implements PeerClient` using the hub machine-proxy: `listPeers()` = GET `<hubHttp>/api/tier-agent/machines` (Bearer hub apiKey) minus self; `manifest(node)` = proxy GET `/data/sync/manifest`; `exportFrom` = proxy GET `/data/:ds/export?since=`; `getFrom` = proxy GET `/data/:ds/records/:id`. Read `hubHttp` + apiKey from `getHubConfig()`/hub.json (mirror `knowledge/remote-sync.ts` `proxyFetch`/`hubFetch`). No unit test (network); covered by the live e2e (Task 8). Commit with the engine or separately: `feat(data): HubPeerClient (hub machine-proxy transport)`.

---

## Task 5: Dirty-queue + batched periodic flush + hub `dataset_updated`

**Files:** Create `core/src/data/sync-queue.ts`; Modify `core/src/hub-client/index.ts`, `core/src/data/data-service.ts` (wire `onLocalWrite`); Test `core/src/__tests__/data/sync-queue.test.ts`.

**Interfaces:** `class SyncQueue { markDirty(dataset: string, id: string): void; flush(): Array<{ dataset: string; recordIds: string[] }>; size(): number; }`; hub-client `sendDatasetUpdated(msg: { node: string; dataset: string; recordIds: string[]; ts: number }): boolean` + a `dataset_updated` receive that `emit`s the message; `interface DatasetUpdatedMessage` in types.

- [ ] **Step 1: failing test** `sync-queue.test.ts` — `markDirty('d','a'); markDirty('d','b'); markDirty('e','c')` then `flush()` returns `[{dataset:'d',recordIds:['a','b']},{dataset:'e',recordIds:['c']}]` (dedup within dataset; coalesced) and clears (next `flush()` is `[]`); `markDirty` same id twice → one entry.
- [ ] **Step 2: run→fail; Step 3: implement `sync-queue.ts`** — a `Map<string, Set<string>>`; `markDirty` adds; `flush` snapshots → array, clears the map; `size` = total ids. (Pure, timer-free — the timer lives in the engine/boot, Task 7, and just calls `flush()` then `sendDatasetUpdated` per entry.)
- [ ] **Step 4: run→pass.**
- [ ] **Step 5: hub-client `dataset_updated`** — In `core/src/hub-client/index.ts`, READ the `sendMemoryUpdated` method + the `case 'memory_updated':` handler (and the `MemoryUpdatedMessage` type) and add the exact analogues:
```typescript
// type (near MemoryUpdatedMessage)
export interface DatasetUpdatedMessage { type: 'dataset_updated'; node: string; dataset: string; recordIds: string[]; ts: number; }
// send method (mirror sendMemoryUpdated): returns false if not connected, else this.send({event:'dataset_updated', ...msg}); return true.
sendDatasetUpdated(msg: { node: string; dataset: string; recordIds: string[]; ts: number }): boolean { /* mirror sendMemoryUpdated */ }
// in the websocket message switch, mirror the 'memory_updated' case:
case 'dataset_updated': this.emit('dataset_updated', message); break;
```
Place them beside the memory equivalents; match the existing connection-guard + `send` usage exactly.
- [ ] **Step 6: wire `onLocalWrite`** — `getDataService()` constructs a module-level `SyncQueue`; pass `onLocalWrite: (ds,id) => queue.markDirty(ds,id)` into the `DataService` deps, and expose `getSyncQueue()`. (The flush timer + send + the `dataset_updated` receive→`pullDataset` are wired at boot in Task 7.)
- [ ] **Step 7: run + commit** — `feat(data): batched sync-queue + hub dataset_updated send/receive`.

---

## Task 6: `partial` mode — local-first read, remote-fallback, lazy cache

**Files:** Modify `core/src/data/data-service.ts`; Test `core/src/__tests__/data/partial-mode.test.ts`.

**Interfaces:** `DataService.get` for a `syncMode:'partial'` dataset: local hit → return; local miss → `peers.getFrom(...)` across peers that have it → first hit → `importBatch` (lazy cache) + return; total miss → null. The `DataService` gains an optional `peers?: PeerClient` dep (injected at boot; in tests a fake).

- [ ] **Step 1: failing test** `partial-mode.test.ts` — service with a fake `PeerClient` whose `getFrom` returns a record for `id='remote1'` only. Create dataset `p` with `syncMode:'partial'`. `get(ctx,'p','remote1')` (local miss) → returns the record AND a subsequent `backend.get('p','remote1')` shows it was cached locally (origin stamped). `get(ctx,'p','nope')` → ok with value null. A locally-put record is served from local without calling the peer (spy the fake).
- [ ] **Step 2: run→fail; Step 3: implement** — in `get`, after the local `backend.get` returns null, if `d.syncMode === 'partial'` and `this.deps.peers`: iterate `await this.deps.peers.listPeers()` (or use `d.ownerNode` if set), `const rec = await peers.getFrom(node, datasetId, id)`; on first non-null, `await backend.importBatch(datasetId, [rec], rec.origin ?? {machineId:node,...})` and return redacted. Respect enforcement (already authorized `read` above) and the kill-switch.
- [ ] **Step 4: run→pass; Step 5: commit** — `feat(data): partial sync mode — local-first get with remote-fallback + lazy cache`.

---

## Task 7: Boot wiring — start the engine, flush timer, reconcile, event handler; settings; sync routes

**Files:** Modify `core/src/project-settings.ts`, `core/src/data/data-service.ts` (assemble peers+engine in `getDataService`), `core/src/routes/core/data.routes.ts` (`POST /data/sync`, `GET /data/sync/status`), and the Core boot path (`rest-server.ts` or `cli.ts` startup) to start the periodic flush + reconcile + `dataset_updated` subscription when `dataServiceEnabled` + hub configured. Test `core/src/__tests__/data/sync-routes.test.ts`.

**Interfaces:** `project-settings` gains `dataSyncPeriodSec` (15), `dataReconcileSec` (300). `startDataSync()` exported from a new `core/src/data/sync-boot.ts` — sets up the interval timers + the hub `dataset_updated` subscription (calls `syncEngine.pullDataset(msg.node, msg.dataset)`); idempotent (no double-start). `POST /data/sync` → `syncEngine.reconcile()`; `GET /data/sync/status` → `syncEngine.status()`.

- [ ] **Step 1: settings** — add the two fields to `ProjectSettings`/`DEFAULTS`/read/merge (mirror `dataServiceEnabled`).
- [ ] **Step 2: assemble** — in `getDataService()`, construct `HubPeerClient` + `SyncEngine` and pass `peers` into `DataService`; export `getSyncEngine()`.
- [ ] **Step 3: `sync-boot.ts`** — `startDataSync()`: guard on `getProjectSettings().dataServiceEnabled`; set a `setInterval(flushPeriod)` → `const batches = getSyncQueue().flush(); for (b of batches) getHubClient().sendDatasetUpdated({node:thisNodeId(), dataset:b.dataset, recordIds:b.recordIds, ts:Date.now()})`; a `setInterval(reconcileSec)` → `getSyncEngine().reconcile()`; subscribe `getHubClient().on('dataset_updated', m => { if (m.node !== thisNodeId()) getSyncEngine().pullDataset(m.node, m.dataset); })`. Guard against double-start with a module flag. **Chunk any interval > 2^31 ms** (reuse the api-token rotation chunking note — not an issue at these values, but never pass a huge ms to setInterval).
- [ ] **Step 4: call `startDataSync()` at Core boot** — read the rest-server/cli startup where other background services start (e.g. knowledge scheduler); add `try { if (getProjectSettings().dataServiceEnabled) require('./data/sync-boot').startDataSync(); } catch {}` after the hub client is up.
- [ ] **Step 5: sync routes** — `POST /data/sync` (local-only principal; `await getSyncEngine().reconcile()`) and `GET /data/sync/status`.
- [ ] **Step 6: test** `sync-routes.test.ts` — invoke the route handlers: `GET /data/sync/manifest` returns this node's full/partial datasets; `POST /data/sync` as cloud → FORBIDDEN, as local → runs (with a stubbed engine via the singleton or a no-peer reconcile returning a status). Keep it to route-level assertions (no live hub).
- [ ] **Step 7: build + run all data suites + commit** — `npm run build`; run every `dist-test/__tests__/data/*.test.js`; `git commit -m "feat(data): sync boot wiring (flush/reconcile timers + dataset_updated) + sync routes + settings"`.

---

## Task 8: Deploy to 117/123/107 + live cross-node sync e2e

**Files:** none — deploy the rebuilt `core/dist` (M1+M4+M5) to all three prod workers (same method as the M4 deploy: NVM path on 117; `sudo rsync` to `/usr/lib/node_modules` on 123 + `sudo systemctl restart lm-assist`; tar→real AppData path on 107 + restart) and run the e2e.

- [ ] **Step 1:** `./core.sh build`; re-overlay `core/dist` onto each node's prod install (117 NVM path; 123 via `--rsync-path="sudo rsync"`; 107 via tar to the real `AppData\...\node_modules\lm-assist\core` path), restart each (117 `lm-assist restart`; 123 `sudo systemctl restart lm-assist`; 107 `lm-assist restart`). Verify `data_*` still listed + `dataServiceEnabled` true on each.
- [ ] **Step 2 — full sync e2e:** on 117 (owner), create `sync_demo` with `syncMode:'full'`, `visibility:'cross-node-readable'`, cloud-read ACL; `data_put` a record. Trigger reconcile on 123 + 107 (`POST /data/sync` locally on each, or wait one reconcile interval / rely on the `dataset_updated` event). Then on 123 + 107 confirm a **local replica** of `sync_demo` exists with the record (read it locally — origin = 117). Update the record on 117 (version 2); confirm 123/107 converge to version 2 after the next event/reconcile.
- [ ] **Step 3 — LWW/idempotency:** re-deliver/re-trigger a stale pull on 123 → record stays at the latest version (applied 0). 
- [ ] **Step 4 — partial e2e:** on 117 create `partial_demo` `syncMode:'partial'` + put `r1`; on 123, `data_get partial_demo/r1` (local miss → remote-fallback fetch from 117 → returns r1 + lazily cached locally); second `data_get` served from local.
- [ ] **Step 5:** record results in the ledger. Then per the user's earlier open item: leave `dataServiceEnabled` on or revert + clean test datasets (`xnode_123`, `e2e_win`, `sync_demo`, `partial_demo`) — confirm with the controller's standing instruction.

---

## Self-Review

**Spec/design coverage:** engine-level (generic `StorageBackend` hooks + backend-agnostic `SyncEngine`, no app coupling) ✓; `syncMode` none/full/partial ✓; per-record `version`+`updatedAt` LWW (`isNewer`, `importBatch` guard) ✓; createdAt preserved + engine-owned version ✓; read-only single-writer replicas (`origin` marker, `put` rejects replicas) ✓; batched periodic `dataset_updated` (sync-queue flush timer) + slow reconcile pull ✓; partial local-first/remote-fallback + lazy cache ✓; transport over hub machine-proxy with injectable `PeerClient` for tests ✓; knowledge remote-sync untouched ✓.

**Placeholder scan:** Tasks 4/6/7 describe test bodies in prose where they follow the established `svc()` helper + fake-`PeerClient` pattern — the implementer writes them from the given assertions; all production code is complete. (Acceptable: the test shapes are fully specified by their assertions + the M1 helper precedent.) Re-confirm each test asserts real behavior before its commit.

**Type consistency:** `DataRecord.version` (Task 1) flows through `exportSince`/`importBatch` (Task 2), `isNewer` (Task 1) used by `importBatch` + partial cache + replica apply; `PeerClient`/`SyncEngine`/`SyncQueue` signatures consistent across Tasks 4–7; `syncMode`/`origin` (Task 3) read by engine (4), partial (6), and `put`'s replica-reject (1, finalized in 3). `DatasetUpdatedMessage` shape consistent between hub send (5) and the boot subscription (7).

**Security:** sync rides the SAME hub-proxy + relay trust path proven in M4 (peers reached via authenticated hub proxy; the export/manifest routes are `enforce`-gated like all `/data` routes; replicas are read-only). No new trust boundary. `POST /data/sync` is local-only.

**Known scope notes:** only the **cache** backend implements the hooks in M5 (sql/vector inherit the `StorageBackend` contract when built in M2/M3). `partial` `query`-federation is deferred (only `get` is local-first/remote-fallback in M5, per the agreed scope) — `query` on a partial dataset returns local matches only; document this in `data_query`'s behavior.
