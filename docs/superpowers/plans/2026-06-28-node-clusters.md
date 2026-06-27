# Node Clusters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Partition a hub's fleet into named **clusters** that each run independent leader election, mission control (incl. within-cluster executor placement), and within-cluster DB sync, while memory + knowledge stay fleet-wide — plus MCP management, cluster self-description, and bootstrap/controller awareness.

**Architecture:** A node's cluster identity lives in a local file and is published into a fleet-wide-synced `node-clusters` dataset, so every node converges on a `gatewayId→cluster` map. Two pure functions (`listOnlineNodeIds` for election, the sync-engine's per-dataset peer choice) and `selectFleetNodes` (build fan-out) filter by that map; datasets gain a `scope:'cluster'|'fleet'` field (default `cluster`). Memory/knowledge keep their own un-filtered fleet-wide paths.

**Tech Stack:** TypeScript (CommonJS, `core/`), the existing data-service (LMDB datasets + sync-engine), the hub machine-proxy relay, MCP stdio tools + raw HTTP routes.

**🔴 TEST CONVENTION (read first — the task code below uses `expect` shorthand; translate it):** core tests use **`node:test` + `node:assert/strict`**, NOT vitest. Tests live in `core/src/__tests__/`, compile via `npm run build:test` → `dist-test/`, and run with `node --test`. Run the whole suite with **`cd core && npm test`**; a single file with `cd core && npm run build:test && node --test dist-test/__tests__/<name>.test.js`. Every test block in this plan is shown in `describe/it/expect` shorthand for readability — **write it in node:test**: header `import { describe, it } from 'node:test'; import assert from 'node:assert/strict';`, and translate `expect(x).toBe(y)`→`assert.equal(x, y)`, `expect(x).toEqual(arr)`→`assert.deepEqual(x, arr)`, `expect(x).toBe(true)`→`assert.equal(x, true)`, `expect(x).toBeNull()`→`assert.equal(x, null)`. Tasks 1 & 2 below are shown fully converted as the worked template; mirror them for Tasks 3-10.

## Global Constraints

- **lm-assist-only** — NO LangMart hub (assist-api) change. Membership is the synced `node-clusters` dataset + local config.
- **Backward-compatible** — a node with no cluster is in cluster `"default"`; with everyone in `default`, cluster-scope ≡ fleet-wide (today's behavior, byte-for-byte). New `scope` defaults to `'cluster'`.
- **Cluster name normalization:** trim → lowercase → keep `[a-z0-9_-]`, collapse others to `-`, empty ⇒ `"default"`. One function `clusterName(raw)`, used everywhere.
- **Exactly one cluster per node.**
- **Fleet-wide (never cluster-filtered):** memory (`memory/mcp-transport.ts` `listPeers()`), knowledge (`knowledge/remote-sync.ts`), and the `node-clusters` + `cluster-meta` datasets (`scope:'fleet'`). Do NOT add cluster filtering to memory/knowledge paths.
- **Build dev with Node ≥ 20.9** (`source ~/.nvm/nvm.sh && nvm use 20`); rebuild core after TS changes with `./core.sh build`.
- `gatewayId` is this node's id (`gw4-…`), from `getHubConfig().gatewayId`; fall back to `machineId`.

## File structure

- Create `core/src/cluster/cluster-config.ts` — local identity (`~/.lm-assist/cluster.json`, dev `cluster-dev.json`).
- Create `core/src/cluster/cluster-map.ts` — pure resolvers (`clusterOf`, `sameClusterIds`, `clustersOverview`).
- Create `core/src/cluster/cluster-store.ts` — dataset I/O (ensure datasets, publish self, read records + meta).
- Modify `core/src/data/types.ts` — `scope` on `DatasetDescriptor` + `ManifestEntry`.
- Modify `core/src/data/dataset-registry.ts` + `core/src/data/data-service.ts` — carry/advertise `scope`.
- Modify `core/src/data/sync-engine.ts` — per-dataset cluster filter.
- Modify `core/src/data/peer-client.ts` — `listOnlineNodeIds()` cluster-scoped.
- Modify `core/src/mcp-server/tools/node-builds.ts` — `selectFleetNodes` cluster target.
- Create `core/src/routes/core/cluster.routes.ts` + register in `routes/core/index.ts`.
- Create `core/src/mcp-server/tools/cluster.ts` + register in `mcp-server/tools/expanded.ts` + scopes in `mcp-server/configure.ts`.
- Modify `core/src/routes/core/mission.routes.ts` + `core/src/mission/mission-controller.ts` — placement guard + prompt.
- Modify `core/src/mcp-server/tools/guide.ts` (bootstrap + `clusters` topic) + the `session_status` tool.

---

### Task 1: Local cluster identity — `cluster-config.ts`

**Files:**
- Create: `core/src/cluster/cluster-config.ts`
- Test: `core/src/__tests__/cluster-config.test.ts`

**Interfaces:**
- Produces: `clusterName(raw: string | null | undefined): string`; `getMyCluster(): string`; `setMyCluster(name: string): string` (returns the normalized name written).

- [ ] **Step 1: Confirm the test command.** `grep '"test"' core/package.json` — note the exact runner (assume `npm test` runs the `__tests__` suite). Use it verbatim below.

- [ ] **Step 2: Write the failing test**

```ts
// core/src/__tests__/cluster-config.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clusterName } from '../cluster/cluster-config';

describe('clusterName', () => {
  it('normalizes to lowercase [a-z0-9_-]', () => {
    assert.equal(clusterName('Release'), 'release');
    assert.equal(clusterName('  Dev Box! '), 'dev-box-');
    assert.equal(clusterName('a_b-2'), 'a_b-2');
  });
  it('empty / nullish → default', () => {
    assert.equal(clusterName(''), 'default');
    assert.equal(clusterName('   '), 'default');
    assert.equal(clusterName(null), 'default');
    assert.equal(clusterName(undefined), 'default');
  });
});
```

- [ ] **Step 3: Run test to verify it fails** — `cd core && npm test` → FAIL (module missing).

- [ ] **Step 4: Implement**

```ts
// core/src/cluster/cluster-config.ts
// A node's own cluster identity. Authoritative for THIS node; published into the
// fleet-wide `node-clusters` dataset by cluster-store.ts so peers learn it.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const IS_DEV_REPO = !__dirname.includes('node_modules');
const FILE = `cluster${IS_DEV_REPO ? '-dev' : ''}.json`;

export function clusterName(raw: string | null | undefined): string {
  const n = (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return n || 'default';
}

function configPath(): string {
  return path.join(os.homedir(), '.lm-assist', FILE);
}

export function getMyCluster(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
    return clusterName(raw?.cluster);
  } catch {
    return 'default';
  }
}

export function setMyCluster(name: string): string {
  const cluster = clusterName(name);
  const dir = path.join(os.homedir(), '.lm-assist');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ cluster }), 'utf-8');
  return cluster;
}
```

- [ ] **Step 5: Run test to verify it passes** — `cd core && npm test` → PASS.
- [ ] **Step 6: Commit**

```bash
git add core/src/cluster/cluster-config.ts core/src/__tests__/cluster-config.test.ts
git commit -m "feat(cluster): local cluster identity (cluster-config)"
```

---

### Task 2: Pure cluster-map resolvers — `cluster-map.ts`

**Files:**
- Create: `core/src/cluster/cluster-map.ts`
- Test: `core/src/__tests__/cluster-map.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `interface ClusterRecord { gatewayId: string; cluster: string; hostname?: string }`
  - `clusterOf(gatewayId: string, records: ClusterRecord[], selfId: string | null, selfCluster: string): string` — self always resolves to `selfCluster`; unknown → `'default'`.
  - `sameClusterIds(onlineIds: string[], records: ClusterRecord[], selfId: string | null, selfCluster: string): string[]` — the subset in self's cluster (self always included if in `onlineIds` or appended by caller).
  - `clustersOverview(records: ClusterRecord[], onlineIds: string[], selfId: string | null, selfCluster: string): Array<{ name: string; members: Array<{ gatewayId: string; online: boolean; hostname?: string }>; leader: string | null }>` — leader = lexicographically lowest ONLINE id in the cluster.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/cluster-map.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clusterOf, sameClusterIds, clustersOverview, ClusterRecord } from '../cluster/cluster-map';

const recs: ClusterRecord[] = [
  { gatewayId: 'gw4-a', cluster: 'release' },
  { gatewayId: 'gw4-b', cluster: 'release' },
  { gatewayId: 'gw4-c', cluster: 'dev' },
];

describe('clusterOf', () => {
  it('self resolves to local cluster even if the map is stale/missing', () => {
    assert.equal(clusterOf('gw4-a', [], 'gw4-a', 'release'), 'release');
  });
  it('peer resolves from records; unknown → default', () => {
    assert.equal(clusterOf('gw4-c', recs, 'gw4-a', 'release'), 'dev');
    assert.equal(clusterOf('gw4-z', recs, 'gw4-a', 'release'), 'default');
  });
});

describe('sameClusterIds', () => {
  it('keeps only same-cluster online ids (two clusters → disjoint)', () => {
    const online = ['gw4-a', 'gw4-b', 'gw4-c'];
    assert.deepEqual(sameClusterIds(online, recs, 'gw4-a', 'release').sort(), ['gw4-a', 'gw4-b']);
    assert.deepEqual(sameClusterIds(online, recs, 'gw4-c', 'dev'), ['gw4-c']);
  });
  it('all-default fleet (no records) → everyone same cluster', () => {
    const online = ['gw4-a', 'gw4-b', 'gw4-c'];
    assert.deepEqual(sameClusterIds(online, [], 'gw4-a', 'default').sort(), ['gw4-a', 'gw4-b', 'gw4-c']);
  });
});

describe('clustersOverview', () => {
  it('groups members + picks lowest online id as leader', () => {
    const ov = clustersOverview(recs, ['gw4-b', 'gw4-c'], 'gw4-b', 'release');
    const rel = ov.find((c) => c.name === 'release')!;
    assert.equal(rel.leader, 'gw4-b'); // gw4-a offline, gw4-b online
    assert.equal(ov.find((c) => c.name === 'dev')!.leader, 'gw4-c');
  });
});
```

- [ ] **Step 2: Run test → FAIL.**

- [ ] **Step 3: Implement**

```ts
// core/src/cluster/cluster-map.ts
// Pure resolvers over the (gatewayId → cluster) records synced via the
// fleet-wide `node-clusters` dataset. No I/O — trivially testable.

export interface ClusterRecord { gatewayId: string; cluster: string; hostname?: string }

function buildMap(records: ClusterRecord[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of records) if (r?.gatewayId) m.set(r.gatewayId, r.cluster || 'default');
  return m;
}

export function clusterOf(gatewayId: string, records: ClusterRecord[], selfId: string | null, selfCluster: string): string {
  if (selfId && gatewayId === selfId) return selfCluster;        // local identity is authoritative for self
  return buildMap(records).get(gatewayId) ?? 'default';
}

export function sameClusterIds(onlineIds: string[], records: ClusterRecord[], selfId: string | null, selfCluster: string): string[] {
  return onlineIds.filter((id) => clusterOf(id, records, selfId, selfCluster) === selfCluster);
}

export function clustersOverview(
  records: ClusterRecord[],
  onlineIds: string[],
  selfId: string | null,
  selfCluster: string,
): Array<{ name: string; members: Array<{ gatewayId: string; online: boolean; hostname?: string }>; leader: string | null }> {
  const onlineSet = new Set(onlineIds);
  // union of all known ids (records + online), resolved to a cluster
  const ids = new Set<string>([...records.map((r) => r.gatewayId), ...onlineIds]);
  const hostById = new Map(records.map((r) => [r.gatewayId, r.hostname]));
  const byCluster = new Map<string, Array<{ gatewayId: string; online: boolean; hostname?: string }>>();
  for (const id of ids) {
    const c = clusterOf(id, records, selfId, selfCluster);
    const arr = byCluster.get(c) ?? [];
    arr.push({ gatewayId: id, online: onlineSet.has(id), hostname: hostById.get(id) });
    byCluster.set(c, arr);
  }
  return [...byCluster.entries()].map(([name, members]) => ({
    name,
    members: members.sort((a, b) => a.gatewayId.localeCompare(b.gatewayId)),
    leader: members.filter((m) => m.online).map((m) => m.gatewayId).sort()[0] ?? null,
  })).sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Run test → PASS.**
- [ ] **Step 5: Commit** — `feat(cluster): pure cluster-map resolvers (clusterOf/sameClusterIds/clustersOverview)`.

---

### Task 3: Dataset `scope` field (types + registry + manifest)

**Files:**
- Modify: `core/src/data/types.ts`, `core/src/data/dataset-registry.ts`, `core/src/data/data-service.ts:279-288`
- Test: `core/src/__tests__/data/dataset-scope.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DatasetDescriptor.scope?: 'cluster' | 'fleet'`; `ManifestEntry.scope?: 'cluster' | 'fleet'`; `CreateDatasetInput.scope?`; `syncManifest()` returns `scope` per dataset (default `'cluster'`).

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/data/dataset-scope.test.ts  (node:test; create() is SYNC, returns DatasetDescriptor)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatasetRegistry } from '../../data/dataset-registry';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';

describe('dataset scope', () => {
  it('defaults to cluster and round-trips fleet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-scope-'));
    const reg = new DatasetRegistry(path.join(dir, 'reg.json'));   // confirm ctor arg vs dataset-registry.ts
    const a = reg.create({ id: 'plain', backend: 'cache', ownerNode: 'n1', visibility: 'private', config: { kind: 'cache' } } as any);
    const b = reg.create({ id: 'shared', backend: 'cache', ownerNode: 'n1', visibility: 'private', scope: 'fleet', config: { kind: 'cache' } } as any);
    assert.equal(a.scope, 'cluster');
    assert.equal(b.scope, 'fleet');
  });
});
```

(`DatasetRegistry.create(input): DatasetDescriptor` is **synchronous** (`dataset-registry.ts:72`). Confirm the constructor argument shape against the file; if the registry isn't directly constructable in a unit test, instead assert via `getDataService().createDataset` + `syncManifest` round-trip.)

- [ ] **Step 2: Run test → FAIL** (scope undefined).

- [ ] **Step 3: Implement**

In `core/src/data/types.ts`, add to `DatasetDescriptor` (after `syncMode?`):
```ts
  scope?: 'cluster' | 'fleet'; // sync reach: 'cluster' (default) only within-cluster; 'fleet' across all clusters
```
and add to `ManifestEntry`:
```ts
  scope?: 'cluster' | 'fleet';
```
In `core/src/data/dataset-registry.ts`, the `CreateDatasetInput` interface gains `scope?: 'cluster' | 'fleet';`, and the descriptor build (the `create` path, ~line 91) sets `scope: input.scope ?? 'cluster'`. The `upsertReplica` path (~line 143) should preserve `scope: input.scope ?? 'cluster'` too (so a pulled replica keeps the owner's scope — see Task 5 for where the value comes from).

In `core/src/data/data-service.ts` `syncManifest` (line 279-288), include scope:
```ts
  syncManifest(p: Principal): Array<{ id: string; syncMode: SyncMode; ownerNode: string; backend: BackendKind; scope: 'cluster' | 'fleet' }> {
    // …existing loop…
      out.push({ id: d.id, syncMode, ownerNode: d.ownerNode, backend: d.backend, scope: (d.scope ?? 'cluster') });
    // …
  }
```
And in `core/src/routes/core/data.routes.ts` create route (line 107), pass `scope: b.scope` through to `createDataset`.

- [ ] **Step 4: Run test → PASS.** Then `cd core && npx tsc --noEmit` clean for the touched files.
- [ ] **Step 5: Commit** — `feat(data): dataset scope field (cluster|fleet, default cluster) through registry + manifest`.

---

### Task 4: Cluster datasets + self-publish — `cluster-store.ts`

**Files:**
- Create: `core/src/cluster/cluster-store.ts`
- Test: `core/src/__tests__/cluster-store.test.ts` (pure helpers only; the I/O is integration-verified in Task 11 smoke)

**Interfaces:**
- Consumes: Task 1 (`getMyCluster`), Task 2 (`ClusterRecord`), Task 3 (`scope`), the data-service (`getDataService`, `systemCtx` pattern from `mission-store.ts:79`).
- Produces:
  - `ensureClusterDatasets(): Promise<void>` — create `node-clusters` + `cluster-meta` datasets (`backend:'cache'`, `system:true`, `syncMode:'full'`, `scope:'fleet'`) if absent (idempotent, mirror `mission-store.ts ensureDataset`).
  - `publishSelf(): Promise<void>` — `data_put` `{ id: <gatewayId>, fields: { gatewayId, cluster: getMyCluster(), hostname, ts: Date.now() } }` into `node-clusters`.
  - `getClusterRecords(): Promise<ClusterRecord[]>` — query `node-clusters`, map to `ClusterRecord[]`.
  - `getClusterMeta(): Promise<Array<{ name: string; description?: string; status?: string; ts?: number }>>`; `setClusterMeta(name, description, status): Promise<void>`.
  - `recordsToClusterRecords(rows): ClusterRecord[]` — pure mapper (exported for the test).

- [ ] **Step 1: Write the failing test** (pure mapper only)

```ts
// core/src/__tests__/cluster-store.test.ts
import { describe, it, expect } from 'vitest';
import { recordsToClusterRecords } from '../cluster/cluster-store';

describe('recordsToClusterRecords', () => {
  it('maps data rows to ClusterRecord, normalizing cluster + skipping junk', () => {
    const rows = [
      { id: 'gw4-a', fields: { gatewayId: 'gw4-a', cluster: 'Release', hostname: 'h1' } },
      { id: 'gw4-b', fields: { gatewayId: 'gw4-b', cluster: '', hostname: 'h2' } },
      { id: 'x', fields: { hostname: 'no-gw' } },
    ];
    const out = recordsToClusterRecords(rows as any);
    expect(out).toEqual([
      { gatewayId: 'gw4-a', cluster: 'release', hostname: 'h1' },
      { gatewayId: 'gw4-b', cluster: 'default', hostname: 'h2' },
    ]);
  });
});
```

- [ ] **Step 2: Run test → FAIL.**

- [ ] **Step 3: Implement** (read `mission/mission-store.ts:79-130` first for the exact `getDataService`/`systemCtx`/`createDataset`/`put`/`query` calls and mirror them)

```ts
// core/src/cluster/cluster-store.ts
import { getDataService, type CallCtx } from '../data/data-service';
import { getHubConfig } from '../hub-client/hub-config';
import { getMyCluster, clusterName } from './cluster-config';
import type { ClusterRecord } from './cluster-map';
import type { DataRecord } from '../data/types';

const NODE_CLUSTERS = 'node-clusters';
const CLUSTER_META = 'cluster-meta';

// EXACTLY the pattern mission-store.ts uses (mission-store.ts:60).
function systemCtx(): CallCtx { return { principal: { type: 'local' } } as CallCtx; }
function selfId(): string { const c = getHubConfig(); return c.gatewayId || c.machineId || ''; }
function rec(id: string, fields: Record<string, unknown>): DataRecord {
  const now = new Date().toISOString();
  return { id, version: 0, fields, createdAt: now, updatedAt: now };
}

export function recordsToClusterRecords(rows: Array<{ fields?: Record<string, unknown> }>): ClusterRecord[] {
  return (rows || [])
    .map((r) => r.fields || {})
    .filter((f) => typeof f.gatewayId === 'string' && f.gatewayId)
    .map((f) => ({ gatewayId: f.gatewayId as string, cluster: clusterName(f.cluster as string), hostname: f.hostname as string | undefined }));
}

let ensured = false;
export async function ensureClusterDatasets(): Promise<void> {
  const svc = getDataService();
  if (!svc.isEnabled() || ensured) return;
  for (const [id, title] of [[NODE_CLUSTERS, 'Node Clusters'], [CLUSTER_META, 'Cluster Meta']] as const) {
    try {
      // cross-node-readable so peers can pull it; syncMode:'full' + scope:'fleet' = converges across ALL clusters.
      await svc.createDataset(systemCtx(), { id, backend: 'cache', title, visibility: 'cross-node-readable', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' } } as any);
    } catch { /* already exists — fine (mirror mission-store ensureDataset) */ }
  }
  ensured = true;
}

export async function publishSelf(): Promise<void> {
  const svc = getDataService(); if (!svc.isEnabled()) return;
  await ensureClusterDatasets();
  const id = selfId(); if (!id) return;
  await svc.put(systemCtx(), NODE_CLUSTERS, rec(id, { gatewayId: id, cluster: getMyCluster(), hostname: getHubConfig().hostname || '', ts: Date.now() }));
}

export async function getClusterRecords(): Promise<ClusterRecord[]> {
  const svc = getDataService(); if (!svc.isEnabled()) return [];
  try {
    await ensureClusterDatasets();
    const r = await svc.query(systemCtx(), NODE_CLUSTERS, { limit: 1000 } as any);
    return r.ok ? recordsToClusterRecords(r.value.records) : [];
  } catch { return []; }
}

export async function getClusterMeta(): Promise<Array<{ name: string; description?: string; status?: string; ts?: number }>> {
  const svc = getDataService(); if (!svc.isEnabled()) return [];
  try {
    await ensureClusterDatasets();
    const r = await svc.query(systemCtx(), CLUSTER_META, { limit: 1000 } as any);
    return r.ok ? r.value.records.map((x) => ({ name: x.fields?.name as string, description: x.fields?.description as string | undefined, status: x.fields?.status as string | undefined, ts: x.fields?.ts as number | undefined })) : [];
  } catch { return []; }
}

export async function setClusterMeta(name: string, description?: string, status?: string): Promise<void> {
  const svc = getDataService(); if (!svc.isEnabled()) return;
  await ensureClusterDatasets();
  const n = clusterName(name);
  await svc.put(systemCtx(), CLUSTER_META, rec(n, { name: n, description, status, ts: Date.now() }));
}
```

(`getDataService`, `CallCtx`, `isEnabled()`, `createDataset/put/query` with `DataResult.ok/.value`, and the `DataRecord` `{id,version,fields,createdAt,updatedAt}` shape are all verified against `data/data-service.ts` + `mission/mission-store.ts`.)

- [ ] **Step 4: Run test → PASS** (pure mapper). `npx tsc --noEmit` clean.
- [ ] **Step 5: Wire startup:** call `publishSelf()` once after the hub authenticates + on the existing data-sync tick (find where `mission-store ensureDataset` / the sync tick is kicked — e.g. `data-service` start or the scheduled data-sync job — and add a `publishSelf().catch(()=>{})`). Show the exact 1-3 line insertion in the report.
- [ ] **Step 6: Commit** — `feat(cluster): node-clusters + cluster-meta datasets (fleet-scoped) + self-publish`.

---

### Task 5: Scope-aware sync-engine (cluster-filtered peers per dataset)

**Files:**
- Modify: `core/src/data/sync-engine.ts:42-75+`
- Test: `core/src/__tests__/data/sync-engine-scope.test.ts`

**Interfaces:**
- Consumes: Task 2 (`clusterOf`), Task 3 (`ManifestEntry.scope`), Task 4 (`getClusterRecords`), `getMyCluster`.
- Produces: the pull loop skips a peer's dataset when `entry.scope === 'cluster'` (or undefined) AND the peer is not in my cluster; `scope === 'fleet'` always pulls. The cluster map + my cluster are resolved ONCE per `pullAll` run and threaded in (so it's testable with injected values).

- [ ] **Step 1: Write the failing test** — assert the pure decision helper:

```ts
// core/src/__tests__/data/sync-engine-scope.test.ts
import { describe, it, expect } from 'vitest';
import { shouldPullDataset } from '../../data/sync-engine';

describe('shouldPullDataset', () => {
  const recs = [{ gatewayId: 'B', cluster: 'dev' }];
  it('fleet-scope datasets pull from any peer', () => {
    expect(shouldPullDataset('fleet', 'B', recs as any, 'A', 'release')).toBe(true);
  });
  it('cluster-scope pulls only same-cluster peers', () => {
    expect(shouldPullDataset('cluster', 'B', recs as any, 'A', 'release')).toBe(false); // B is dev, I am release
    expect(shouldPullDataset(undefined, 'B', recs as any, 'A', 'dev')).toBe(true);      // default→cluster, both dev
  });
});
```

- [ ] **Step 2: Run test → FAIL.**

- [ ] **Step 3: Implement** — add the exported pure helper + thread it into `pullAll`:

```ts
// in core/src/data/sync-engine.ts (top-level export)
import { clusterOf, type ClusterRecord } from '../cluster/cluster-map';

export function shouldPullDataset(
  scope: 'cluster' | 'fleet' | undefined,
  peerNode: string,
  records: ClusterRecord[],
  selfId: string | null,
  selfCluster: string,
): boolean {
  if (scope === 'fleet') return true;
  return clusterOf(peerNode, records, selfId, selfCluster) === selfCluster;
}
```
In `pullAll`, resolve `const records = await getClusterRecords(); const selfCluster = getMyCluster(); const selfId = this.deps.nodeId;` once (top of the run, after `listPeers`), and inside the `for (const m of entries)` loop add a guard at the top:
```ts
        if (!shouldPullDataset(m.scope, peer.node, records, selfId, selfCluster)) continue;
```
(Import `getClusterRecords` from `../cluster/cluster-store`, `getMyCluster` from `../cluster/cluster-config`.) Keep `upsertReplica({ … scope: m.scope ?? 'cluster' … })` so replicas remember their scope.

- [ ] **Step 4: Run test → PASS.** Also confirm the existing `sync-engine.test.ts` still passes (all-`default` ⇒ same-cluster ⇒ unchanged behavior).
- [ ] **Step 5: Commit** — `feat(data): sync-engine pulls cluster-scoped datasets only from same-cluster peers`.

---

### Task 6: Cluster-scoped leader election (`listOnlineNodeIds`)

**Files:**
- Modify: `core/src/data/peer-client.ts:234-243` (`listOnlineNodeIds`)
- Test: `core/src/__tests__/data/online-ids-cluster.test.ts` + reuse `electMonitor` from `monitor/stall-election.ts`

**Interfaces:**
- Consumes: Task 2 (`sameClusterIds`), Task 4 (`getClusterRecords`), `getMyCluster`, `getHubConfig().gatewayId`.
- Produces: `listOnlineNodeIds()` now returns ONLY online ids in this node's cluster (self included). Election (`amIMonitor` in `stall-election.ts`) is unchanged code → becomes per-cluster automatically. Add an exported pure `filterOnlineToCluster(allOnline, records, selfId, selfCluster)` for the test.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/data/online-ids-cluster.test.ts
import { describe, it, expect } from 'vitest';
import { filterOnlineToCluster } from '../../data/peer-client';
import { electMonitor } from '../../monitor/stall-election';

describe('per-cluster election', () => {
  const recs = [{ gatewayId: 'gw4-a', cluster: 'release' }, { gatewayId: 'gw4-b', cluster: 'release' }, { gatewayId: 'gw4-c', cluster: 'dev' }];
  it('each cluster elects its own lowest-id leader', () => {
    const all = ['gw4-a', 'gw4-b', 'gw4-c'];
    const relOnline = filterOnlineToCluster(all, recs as any, 'gw4-b', 'release');
    const devOnline = filterOnlineToCluster(all, recs as any, 'gw4-c', 'dev');
    expect(electMonitor(relOnline, 'gw4-a')).toBe(true);   // gw4-a lowest in release
    expect(electMonitor(relOnline, 'gw4-b')).toBe(false);
    expect(electMonitor(devOnline, 'gw4-c')).toBe(true);   // gw4-c alone in dev → its own leader
  });
});
```

- [ ] **Step 2: Run test → FAIL.**

- [ ] **Step 3: Implement** — split the existing fetch from the filter:

```ts
// core/src/data/peer-client.ts
import { sameClusterIds } from '../cluster/cluster-map';
import { getClusterRecords } from '../cluster/cluster-store';
import { getMyCluster } from '../cluster/cluster-config';

export function filterOnlineToCluster(allOnline: string[], records: import('../cluster/cluster-map').ClusterRecord[], selfId: string | null, selfCluster: string): string[] {
  return sameClusterIds(allOnline, records, selfId, selfCluster);
}

/** Online gateway-ids IN THIS NODE'S CLUSTER (including self). */
export async function listOnlineNodeIds(): Promise<string[]> {
  const json = (await hubFetch('/api/tier-agent/machines')) as any;
  const machines: any[] = Array.isArray(json) ? json : json.machines || json.data || [];
  const allOnline = machines
    .filter((m) => (m.status || '').toLowerCase() === 'online')
    .map((m) => (m.gatewayId || m.machineId || m.id) as string)
    .filter((id): id is string => typeof id === 'string' && !!id);
  const selfId = getHubConfig().gatewayId || getHubConfig().machineId || null;
  const records = await getClusterRecords().catch(() => []);
  return filterOnlineToCluster(allOnline, records, selfId, getMyCluster());
}
```

(If circular-import trouble arises between `peer-client` ↔ `cluster-store` ↔ `data-service`, inject `getClusterRecords` lazily via `await import('../cluster/cluster-store')` inside the function — note it in the report.)

- [ ] **Step 4: Run test → PASS.** Confirm `stall-election.test.ts` + mission-controller election tests still pass (all-default ⇒ unchanged).
- [ ] **Step 5: Commit** — `feat(cluster): leader election (stall-monitor + mission controller) scoped to the node's cluster`.

---

### Task 7: Build/upgrade fan-out cluster target (`selectFleetNodes`)

**Files:**
- Modify: `core/src/mcp-server/tools/node-builds.ts` (`selectFleetNodes` + the `node_builds`/`node_upgrade` tool args + routes)
- Test: `core/src/__tests__/node-builds-cluster.test.ts`

**Interfaces:**
- Consumes: Task 2 (`clusterOf`).
- Produces: `selectFleetNodes(machineList, selfId, selfHostname, clusterFilter?)` where `clusterFilter?: { records: ClusterRecord[]; selfCluster: string; target: 'self-cluster' | 'all' | string }` — default (omitted) = today's behavior (all online). With a filter: `target:'all'` → all; `target:'self-cluster'` → nodes in `selfCluster`; `target:'<name>'` → nodes in that cluster.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/node-builds-cluster.test.ts
import { describe, it, expect } from 'vitest';
import { selectFleetNodes } from '../mcp-server/tools/node-builds';

const machines = [
  { gatewayId: 'gw4-a', hostname: 'h-a', status: 'online' },
  { gatewayId: 'gw4-b', hostname: 'h-b', status: 'online' },
  { gatewayId: 'gw4-c', hostname: 'h-c', status: 'online' },
];
const records = [{ gatewayId: 'gw4-a', cluster: 'release' }, { gatewayId: 'gw4-b', cluster: 'release' }, { gatewayId: 'gw4-c', cluster: 'dev' }];

describe('selectFleetNodes cluster target', () => {
  it('no filter → all online (backward compatible)', () => {
    expect(selectFleetNodes(machines, 'gw4-a', 'h-a').map((n) => n.nodeId).sort()).toEqual(['gw4-a', 'gw4-b', 'gw4-c']);
  });
  it('self-cluster → only my cluster', () => {
    const out = selectFleetNodes(machines, 'gw4-a', 'h-a', { records: records as any, selfCluster: 'release', target: 'self-cluster' });
    expect(out.map((n) => n.nodeId).sort()).toEqual(['gw4-a', 'gw4-b']);
  });
  it('named cluster → that cluster', () => {
    const out = selectFleetNodes(machines, 'gw4-a', 'h-a', { records: records as any, selfCluster: 'release', target: 'dev' });
    expect(out.map((n) => n.nodeId)).toEqual(['gw4-c']);
  });
});
```

- [ ] **Step 2: Run test → FAIL.**

- [ ] **Step 3: Implement** — extend the function with the optional 4th arg (keep the existing body for the no-filter path):

```ts
import { clusterOf, type ClusterRecord } from '../../cluster/cluster-map';

export function selectFleetNodes(
  machineList: any[],
  selfId: string,
  selfHostname: string,
  clusterFilter?: { records: ClusterRecord[]; selfCluster: string; target: 'self-cluster' | 'all' | string },
): NodeEntry[] {
  const online: NodeEntry[] = (machineList || [])
    .filter((m: any) => String(m?.status || '').toLowerCase() === 'online')
    .map((m: any) => ({
      nodeId: String(m.gatewayId || m.machineId || m.id || ''),
      hostname: String(m.hostname || m.machineHostname || m.gatewayId || m.machineId || m.id || ''),
      isSelf: (m.gatewayId || m.machineId || m.id) === selfId,
    }))
    .filter((m: NodeEntry) => m.nodeId);
  if (!online.some((n) => n.isSelf)) online.unshift({ nodeId: selfId, hostname: selfHostname, isSelf: true });
  if (!clusterFilter || clusterFilter.target === 'all') return online;
  const want = clusterFilter.target === 'self-cluster' ? clusterFilter.selfCluster : clusterFilter.target;
  return online.filter((n) => clusterOf(n.nodeId, clusterFilter.records, selfId, clusterFilter.selfCluster) === want);
}
```

In the `node_builds`/`node_upgrade` tool defs add an optional `cluster` string arg (`"self-cluster" (default) | "all" | "<name>"`); at the call site (~line 90), build the `clusterFilter` from `getClusterRecords()` + `getMyCluster()` + the arg and pass it. Default arg value = `'self-cluster'` so the everyday call stays within your cluster — **the dev/release isolation use case**.

- [ ] **Step 4: Run test → PASS.**
- [ ] **Step 5: Commit** — `feat(cluster): node_builds/node_upgrade default to self-cluster (+ all/<name> target)`.

---

### Task 8: Cluster routes + MCP tools

**Files:**
- Create: `core/src/routes/core/cluster.routes.ts`; register in `core/src/routes/core/index.ts`
- Create: `core/src/mcp-server/tools/cluster.ts`; register in `core/src/mcp-server/tools/expanded.ts`; scopes in `core/src/mcp-server/configure.ts`
- Test: `core/src/__tests__/cluster-routes.test.ts`

**Interfaces:**
- Consumes: Task 1/2/4 (`setMyCluster`, `clustersOverview`, `getClusterRecords`, `getClusterMeta`, `setClusterMeta`, `publishSelf`), `listOnlineNodeIds` raw (the UNFILTERED online list for the overview — use a local fetch of `/api/tier-agent/machines`, not the now-cluster-scoped `listOnlineNodeIds`), the leader-anchor/proxy helpers (`proxyPost`).
- Produces: routes `GET /cluster/list`, `POST /cluster/assign`, `POST /cluster/unassign`, `POST /cluster/describe`, `POST /cluster/self`; MCP tools `cluster_list`(read), `cluster_assign`(write), `cluster_unassign`(write), `cluster_describe`(write).

- [ ] **Step 1: Write the failing test** — a pure node-resolver used by assign (gatewayId or hostname → gatewayId):

```ts
// core/src/__tests__/cluster-routes.test.ts
import { describe, it, expect } from 'vitest';
import { resolveNodeId } from '../routes/core/cluster.routes';
const recs = [{ gatewayId: 'gw4-a', cluster: 'release', hostname: 'alpha' }];
const online = ['gw4-a', 'gw4-b'];
describe('resolveNodeId', () => {
  it('passes a gatewayId through', () => expect(resolveNodeId('gw4-b', recs as any, online)).toBe('gw4-b'));
  it('resolves a hostname via records', () => expect(resolveNodeId('alpha', recs as any, online)).toBe('gw4-a'));
  it('unknown → null', () => expect(resolveNodeId('nope', recs as any, online)).toBeNull());
});
```

- [ ] **Step 2: Run test → FAIL.**

- [ ] **Step 3: Implement the routes** (mirror an existing small route file like `routes/core/node.routes.ts` for the `createXRoutes(ctx)` shape, `wrapResponse`, and registration in `index.ts`). Export `resolveNodeId` as a pure helper. Key handlers:
  - `GET /cluster/list` → fetch raw online ids (local `/api/tier-agent/machines`), `getClusterRecords()`, `getClusterMeta()`, build via `clustersOverview(...)`, attach each cluster's `description/status` + `myCluster: getMyCluster()`.
  - `POST /cluster/assign {node,cluster}` → `resolveNodeId`; `BAD_NODE` if null; `proxyPost(node, '/cluster/self', { cluster })` (so the TARGET node sets its own identity). If node === self, call the local setter directly.
  - `POST /cluster/unassign {node}` → assign `'default'`.
  - `POST /cluster/describe {cluster?,description,status?}` → `setClusterMeta(cluster ?? getMyCluster(), description, status)`.
  - `POST /cluster/self {cluster}` → **loopback/fleet-internal only** (copy the auth guard from `routes/core/memory-sync.routes.ts`): `setMyCluster(cluster)` + `await publishSelf()`.

- [ ] **Step 4: Implement the MCP tools** in `cluster.ts` (mirror a proxy-style tool in `expanded.ts`/`node-builds.ts` — each tool POSTs/GETs the local route via the in-process API). Register defs+handlers in `expanded.ts`. Add to `TOOL_SCOPES` in `configure.ts`: `cluster_list:'read', cluster_assign:'write', cluster_unassign:'write', cluster_describe:'write'`.

- [ ] **Step 5: Run test → PASS.** `npx tsc --noEmit` clean; `./core.sh build`.
- [ ] **Step 6: Commit** — `feat(cluster): cluster_list/assign/unassign/describe MCP tools + /cluster routes`.

---

### Task 9: Mission placement within cluster

**Files:**
- Modify: `core/src/mission/mission-controller.ts` (bind step ~line 311 + `CONTROLLER_SYSTEM_PROMPT`), `core/src/routes/core/mission.routes.ts` (`handleCreate`/`handleUpdate` env.host)
- Test: `core/src/__tests__/mission-placement-cluster.test.ts`

**Interfaces:**
- Consumes: Task 2 (`clusterOf`/`sameClusterIds`), Task 4 (`getClusterRecords`), `getMyCluster`.
- Produces: a pure `placementAllowed(host: string | undefined, records, selfId, selfCluster): boolean` — `true` for `undefined`/`'local'`/`'cloud'`/in-cluster host; `false` for an out-of-cluster/unknown host. The controller refuses a disallowed host (leaves unbound + `ctl:placement-error`); `handleCreate`/`handleUpdate` reject with `HOST_NOT_IN_CLUSTER`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/mission-placement-cluster.test.ts
import { describe, it, expect } from 'vitest';
import { placementAllowed } from '../mission/mission-controller';
const recs = [{ gatewayId: 'gw4-rel', cluster: 'release' }, { gatewayId: 'gw4-dev', cluster: 'dev' }];
describe('placementAllowed', () => {
  it('undefined/local/cloud always allowed', () => {
    for (const h of [undefined, 'local', 'cloud']) expect(placementAllowed(h, recs as any, 'gw4-rel', 'release')).toBe(true);
  });
  it('in-cluster host allowed; out-of-cluster refused', () => {
    expect(placementAllowed('gw4-rel', recs as any, 'gw4-rel', 'release')).toBe(true);
    expect(placementAllowed('gw4-dev', recs as any, 'gw4-rel', 'release')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test → FAIL.**

- [ ] **Step 3: Implement the pure guard** in `mission-controller.ts`:

```ts
import { clusterOf, type ClusterRecord } from '../cluster/cluster-map';
export function placementAllowed(host: string | undefined, records: ClusterRecord[], selfId: string | null, selfCluster: string): boolean {
  if (!host || host === 'local' || host === 'cloud') return true;
  return clusterOf(host, records, selfId, selfCluster) === selfCluster;
}
```
At the controller bind step (where `decision.host`/`m.env.host` is turned into a binding, ~line 215/311): before binding a node host, resolve `records = await getClusterRecords()`, `selfCluster = getMyCluster()`, `selfId = thisNode()`; if `!placementAllowed(host, records, selfId, selfCluster)` → do NOT spawn; instead `mission_tag` add `ctl:placement-error` and skip (log it in the pass summary). In `handleCreate`/`handleUpdate` (`mission.routes.ts`, where `env.host` is read ~line 111/170): if `env.host` set and `!placementAllowed(env.host, await getClusterRecords(), thisNode(), getMyCluster())` → return `fail('HOST_NOT_IN_CLUSTER', …)`. Add the prompt line to `CONTROLLER_SYSTEM_PROMPT` (spec §5.4 verbatim).

- [ ] **Step 4: Run test → PASS.**
- [ ] **Step 5: Commit** — `feat(cluster): mission controller places executors within its cluster only (+ HOST_NOT_IN_CLUSTER write guard)`.

---

### Task 10: Bootstrap + session_status + guide("clusters") awareness

**Files:**
- Modify: `core/src/mcp-server/tools/guide.ts` (bootstrap text + new `clusters` topic), the `session_status` tool handler
- Test: `core/src/__tests__/cluster-guide.test.ts` (the `clusters` topic returns the advisory norm string)

**Interfaces:**
- Consumes: `getMyCluster`, `getClusterMeta`, `clustersOverview`.
- Produces: `guide("clusters")` returns a topic covering the shared-vs-within table + `cluster_assign/unassign/list/describe` + "build/release one cluster at a time" + the **respect-other-clusters' scope** norm; `bootstrap`/`session_status` report `cluster: '<myCluster>'`, this cluster's description, and a one-line roster of other clusters' purposes.

- [ ] **Step 1: Write the failing test** — assert the topic registry contains `clusters` and the text includes the advisory norm + the four tool names. (Match `guide.ts`'s existing topic-registry test pattern.)
- [ ] **Step 2: Run test → FAIL.**
- [ ] **Step 3: Implement** — add the `clusters` topic to the guide registry (verbatim content from spec §4 + §5 + the shared-vs-within table) and the tool-group mapping; add `cluster: getMyCluster()` + the cluster roster (from `getClusterMeta()` + `clustersOverview`) to the `bootstrap` and `session_status` outputs.
- [ ] **Step 4: Run test → PASS.**
- [ ] **Step 5: Commit** — `feat(cluster): bootstrap/session_status report the cluster + guide("clusters") topic`.

---

### Task 11: Integration smoke + docs

**Files:** none new (verification + `CLAUDE.md` note).

- [ ] **Step 1:** `cd core && npm test` (full suite green) + `npx tsc --noEmit` (no NEW errors vs the pre-branch baseline) + `./core.sh build`.
- [ ] **Step 2: Dev rebuild + restart** (`source ~/.nvm/nvm.sh && nvm use 20 && ./core.sh restart`); confirm `:3200/health` + the dev worker still hub-connected.
- [ ] **Step 3: Multi-node smoke** (spec "Testing" → multi-node): on the prod fleet via the connector/routes — `cluster_assign` 117+123→`release`, 107→`dev`; verify (a) `cluster_list` shows two clusters + independent leaders, (b) a mission created in `release` is absent in `dev`, (c) memory written on 107 appears on 117 (shared), (d) `node_upgrade cluster:'dev'` lists only 107, (e) a `dev` mission with `env.host:107` binds but `env.host:117` is refused. Then reassign all → `default`, confirm fleet-wide behavior returns. Record results in the report.
- [ ] **Step 4:** Add a short "Node Clusters" section to `CLAUDE.md` (concept + the shared-vs-within table + the four MCP tools).
- [ ] **Step 5: Commit** — `docs: node clusters — CLAUDE.md + smoke results`.

---

## Final review & rollout (after all tasks)

- Whole-branch review (opus) over `git merge-base main HEAD`..HEAD — focus the cross-cutting risk: does any fleet-wide path get accidentally cluster-filtered (memory/knowledge MUST stay fleet-wide), and does the all-`default` fleet behave exactly as before?
- Full `core` test suite green; `tsc` no new errors.
- Bump 0.1.120 (package.json, .claude-plugin/plugin.json, .claude-plugin/marketplace.json lm-assist entry), merge `--no-ff`, push, deploy fleet (117/123/107) per the established procedure. After deploy, the fleet is one `default` cluster (no behavior change) until you `cluster_assign`.
