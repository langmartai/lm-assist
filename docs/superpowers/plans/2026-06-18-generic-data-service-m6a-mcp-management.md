# Generic Data Service — M6a: MCP Management Tools (local-only, LLM-legible) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the data service's **management plane** (create/drop datasets, list/revoke access keys, trigger/view cross-node sync) through MCP — so an LLM can manage the data service, not just read/write records — with the management tools **local-only** and the local-vs-remote capability made **legible to the LLM** (clear descriptions, a `data_catalog` capability signal, and actionable denials when a remote session tries to manage).

**Architecture:** A few new local-only `DataService` methods (`createDataset`, `listKeys`, `sync`, `syncStatus`) so MCP and REST share one management surface, plus a `KeyStore.list()`. Six new `data_*` MCP management tools wrap them; each front-gates on the caller's principal (`local` from a same-host stdio session vs `cloud` from a hub-relayed/remote session) and returns a clear, actionable message when a remote session attempts management. `data_catalog` gains a `you: { principal, canManage }` field so the LLM can discover its capability up front.

**Tech Stack:** TypeScript (CommonJS), the existing access-key manager + sync engine, `node:test`.

## Global Constraints

- **Management is LOCAL-ONLY.** Create/drop datasets, list/revoke keys, and trigger/view sync are permitted ONLY for the `local` principal (a stdio MCP session running on the same host as the data service, or a loopback REST call). A `cloud` principal (hub-relayed / remote session) is REFUSED — consistent with the existing local-only management routes. There is no cloud-management path in M6a.
- **Legibility (the headline requirement):** the LLM must be able to tell whether THIS session can manage. Three mechanisms: (1) every management tool's `description` states it is local-only and how to check; (2) `data_catalog` returns `you: { principal: 'local'|'cloud', canManage: boolean }` (`canManage === principal === 'local'`); (3) a remote attempt returns a clear, actionable error — *"FORBIDDEN: data management is local-only; this MCP session is remote (cloud) — run it from a local session on the data-service host."* Not a bare code.
- **Principal threading unchanged.** Tools resolve the principal via `currentMcpContext()` (set at the MCP entry point), exactly like the existing `data_*` tools — a hub-relayed call is `cloud`, never silently escalated. The `local`-only gate is enforced BOTH in the tool (front-gate, for the friendly message) AND in the `DataService` method (defense-in-depth).
- **Secrets never leave.** `data_keys` / `listKeys` return key METADATA only — never `secretHash` (and obviously never a plaintext secret, which is shown once at mint and never stored).
- **Shared surface.** New `DataService` methods are the single implementation; the REST routes (`POST /data/datasets`, `DELETE /data/datasets/:id`, `POST /data/sync`, `GET /data/sync/status`, `DELETE /data/access/:keyId`) and the new MCP tools both call them. Where a REST route currently inlines logic (the `POST /data/datasets` create+init), refactor it to call the new `DataService.createDataset` so the two surfaces can't drift. `data_create_dataset` accepts the same `CreateDatasetInput` shape the route does.
- **`expanded.ts` needs no edit** — the new tools flow through the existing `...DATA_TOOL_DEFS`/`...DATA_HANDLERS` spreads. The hardcoded tool-count assertion in `data-tools.test.ts` is the only count to update (6 existing + `data_admin`... current is 8 → 14 after the 6 new tools).
- Tests: `node:test` + `node:assert/strict`, compiled via `tsc -p core/tsconfig.test.json`, hermetic (`LM_ASSIST_DATA_DIR` temp dir + `runWithMcpContext`).

## File Structure

- **Modify** `core/src/data/key-store.ts` — add `list()`.
- **Modify** `core/src/data/data-service.ts` — add `createDataset`, `listKeys`, `sync`, `syncStatus` (all local-only).
- **Modify** `core/src/routes/core/data.routes.ts` — `POST /data/datasets` calls `svc.createDataset` (retire the inline create+init); add `DELETE /data/access/:keyId` if not present (it is — keep). (Sync routes already exist.)
- **Modify** `core/src/mcp-server/tools/data-tools.ts` — `data_catalog` `you` field; add 6 management tools + handlers; the `requireLocal()` helper.
- **Modify** `core/src/__tests__/data/data-tools.test.ts` — tool-count → 14; capability + management tests.
- **Create** `core/src/__tests__/data/data-management.test.ts` — `DataService` management methods (service-level).

**Base commit before Task 1:** the current branch HEAD (M3 tip). Record it in the ledger.

---

### Task 1: `DataService` management methods + `KeyStore.list()`

**Files:**
- Modify: `core/src/data/key-store.ts`
- Modify: `core/src/data/data-service.ts`
- Modify: `core/src/routes/core/data.routes.ts` (`POST /data/datasets` → `svc.createDataset`)
- Test: `core/src/__tests__/data/data-management.test.ts`

**Interfaces:**
- Produces: `KeyStore.list(): AccessKey[]`; `DataService.createDataset(ctx: CallCtx, input: CreateDatasetInput): Promise<DataResult<DatasetDescriptor>>` (local-only); `DataService.listKeys(ctx: CallCtx): Promise<DataResult<PublicKey[]>>` (local-only; `PublicKey = Omit<AccessKey,'secretHash'>`); `DataService.sync(ctx): Promise<DataResult<SyncStatus>>` + `DataService.syncStatus(ctx): Promise<DataResult<SyncStatus>>` (local-only). Task 2 + the web UI consume these.

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/data/data-management.test.ts`:

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
  const datasets = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-mgmt-reg-')), 'd.json'));
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-mgmt-keys-')));
  const backends = new BackendRegistry();
  backends.register(new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-mgmt-cache-'))));
  const manager = new AccessManager({ datasets, keys, nodeId: 'n1' });
  const s = new DataService({ datasets, backends, manager });
  (s as any).enabledOverride = true;
  return { s, datasets, keys };
}
const LOCAL = { principal: { type: 'local' as const } };
const CLOUD = { principal: { type: 'cloud' as const, userId: 'u' } };

test('createDataset: local creates + allocates; cloud is FORBIDDEN', async () => {
  const { s, datasets } = svc();
  const r = await s.createDataset(LOCAL, { id: 'md1', backend: 'cache', config: { kind: 'cache' }, acl: [] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.id, 'md1');
  assert.ok(datasets.get('md1'));
  // a write works (storage allocated)
  const put = await s.put(LOCAL, 'md1', { id: 'a', version: 0, fields: { n: 1 }, createdAt: 't', updatedAt: 't' });
  assert.equal(put.ok, true);
  const denied = await s.createDataset(CLOUD, { id: 'md2', backend: 'cache', config: { kind: 'cache' }, acl: [] });
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.code, 'FORBIDDEN');
  assert.equal(datasets.get('md2'), undefined); // not created on a denied call
});

test('listKeys: local lists key metadata WITHOUT secretHash; cloud FORBIDDEN', async () => {
  const { s } = svc();
  const issued = await s.requestAccess({ type: 'local' }, { grants: [{ dataset: 'x', actions: ['read'] }], intent: 'test' });
  assert.equal(issued.ok, true);
  const r = await s.listKeys(LOCAL);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.value.length >= 1);
  for (const k of r.value) {
    assert.ok(k.keyId);
    assert.equal((k as any).secretHash, undefined); // NEVER expose the hash
    assert.ok(Array.isArray(k.grants));
  }
  const denied = await s.listKeys(CLOUD);
  assert.equal(denied.ok, false);
});

test('sync + syncStatus are local-only', async () => {
  const { s } = svc();
  const st = await s.syncStatus(LOCAL);
  assert.equal(st.ok, true);
  const denied = await s.syncStatus(CLOUD);
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.code, 'FORBIDDEN');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/data-management.test.js`
Expected: FAIL — `s.createDataset`/`s.listKeys`/`s.syncStatus` are not functions.

- [ ] **Step 3: Add `KeyStore.list()`**

In `core/src/data/key-store.ts`, after `get` (line 37):
```typescript
  /** All issued keys (metadata + secretHash). Callers that expose keys MUST strip secretHash. */
  list(): AccessKey[] {
    const out: AccessKey[] = [];
    for (const { value } of this.keys.getRange()) out.push(value as AccessKey);
    return out;
  }
```

- [ ] **Step 4: Add the `DataService` management methods**

In `core/src/data/data-service.ts`:
1. Add a `PublicKey` type near the top (after the `DataResult` type):
```typescript
export type PublicKey = Omit<import('./types').AccessKey, 'secretHash'>;
```
2. Add the methods (place after `dropDataset`). They depend on `getKeyStore`, `getDatasetRegistry`/the registry dep, and `getSyncEngine`. The `DataService` already holds `this.deps.datasets` + `this.deps.manager` + a `keys` store via the manager; for `listKeys` use `getKeyStore()` (the same singleton the service was built with) — or thread the keystore in. SIMPLEST: import `getKeyStore` and `getSyncEngine` lazily.

```typescript
  /** Create a dataset + allocate its backend storage (local-only). Single impl shared by REST + MCP. */
  async createDataset(ctx: CallCtx, input: import('./dataset-registry').CreateDatasetInput): Promise<DataResult<import('./types').DatasetDescriptor>> {
    if (ctx.principal.type !== 'local') return { ok: false, code: 'FORBIDDEN', reason: 'dataset creation is local-only' };
    let d: import('./types').DatasetDescriptor;
    try {
      d = this.deps.datasets.create(input);
    } catch (e) {
      return { ok: false, code: 'BAD_REQUEST', reason: e instanceof Error ? e.message : String(e) };
    }
    const init = await this.initDataset(ctx, d.id);
    if (!init.ok) { this.deps.datasets.drop(d.id); return init; } // roll back the descriptor on alloc failure
    return { ok: true, value: d };
  }

  /** List issued access keys (metadata only — NEVER secretHash). Local-only. */
  async listKeys(ctx: CallCtx): Promise<DataResult<PublicKey[]>> {
    if (ctx.principal.type !== 'local') return { ok: false, code: 'FORBIDDEN', reason: 'key listing is local-only' };
    const { getKeyStore } = require('./key-store');
    const keys = (getKeyStore().list() as import('./types').AccessKey[]).map((k) => {
      const { secretHash, ...pub } = k; // strip the hash
      return pub as PublicKey;
    });
    return { ok: true, value: keys };
  }

  /** Trigger a cross-node reconcile (local-only). */
  async sync(ctx: CallCtx): Promise<DataResult<import('./types').SyncStatus>> {
    if (ctx.principal.type !== 'local') return { ok: false, code: 'FORBIDDEN', reason: 'sync is local-only' };
    const { getSyncEngine } = require('./data-service');
    const status = await getSyncEngine().reconcile();
    return { ok: true, value: status };
  }

  /** Current sync engine status (local-only). */
  async syncStatus(ctx: CallCtx): Promise<DataResult<import('./types').SyncStatus>> {
    if (ctx.principal.type !== 'local') return { ok: false, code: 'FORBIDDEN', reason: 'sync status is local-only' };
    const { getSyncEngine } = require('./data-service');
    return { ok: true, value: getSyncEngine().status() };
  }
```

> NOTE: `require('./data-service')` from within `data-service.ts` is a self-require to reach the module-level `getSyncEngine` — this works (CommonJS returns the in-progress module exports; `getSyncEngine` is hoisted as a function declaration). If the implementer finds it cleaner, call the module-level `getSyncEngine()` directly (it is defined in the same file, so a direct call works without the require). Prefer the direct call if `getSyncEngine` is in scope.

- [ ] **Step 5: Refactor `POST /data/datasets` to use `createDataset`**

In `core/src/routes/core/data.routes.ts`, replace the body of the `POST /data/datasets` handler's `try` block (the `getDatasetRegistry().create({...})` + `initDataset` + rollback) with a single call:
```typescript
        const r = await svc().createDataset({ principal: p }, {
          id: b.id, backend: b.backend ?? 'cache', title: b.title,
          visibility: b.visibility, readOnly: b.readOnly, sensitive: b.sensitive,
          config: b.config ?? { kind: 'cache' }, acl: b.acl, syncMode: b.syncMode, system: b.system,
        });
        if (!r.ok) return wrapError(r.code, r.reason, start);
        return wrapResponse({ dataset: r.value }, start);
```
(Keep the outer `if (p.type !== 'local') FORBIDDEN` guard — it gives the route's clear local-only error before calling; `createDataset` re-checks as defense-in-depth. Drop the now-unused `recordFromBody({id:'__init__'})` usage if it has no other caller — check first.)

- [ ] **Step 6: Run tests + the data-routes suite**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/data-management.test.js dist-test/__tests__/data/data-routes.test.js`
Expected: PASS — management methods (create local+cloud-denied, listKeys no-secretHash, sync local-only) green; the existing `data-routes.test.ts` create-dataset test still green (the route now routes through `createDataset`, same end-state).

- [ ] **Step 7: Commit**

```bash
git add core/src/data/key-store.ts core/src/data/data-service.ts core/src/routes/core/data.routes.ts core/src/__tests__/data/data-management.test.ts
git commit -m "feat(data): DataService management methods (createDataset/listKeys/sync/syncStatus, local-only) + KeyStore.list; route shares createDataset"
```

---

### Task 2: `data_catalog` capability signal + 6 MCP management tools (local-only, LLM-legible)

**Files:**
- Modify: `core/src/mcp-server/tools/data-tools.ts`
- Modify: `core/src/__tests__/data/data-tools.test.ts`

**Interfaces:**
- Consumes: the Task 1 `DataService` methods.
- Produces: `data_catalog` output gains `you: { principal, canManage }`; new tools `data_create_dataset`, `data_drop_dataset`, `data_keys`, `data_revoke_key`, `data_sync`, `data_sync_status` (all in `DATA_TOOL_DEFS` + `DATA_HANDLERS`).

- [ ] **Step 1: Write the failing test**

Update the tool-count assertion in `data-tools.test.ts` (currently 8 → now 14, sorted):

```typescript
test('data tools: the 14 expected tools are defined and mapped', () => {
  const names = DATA_TOOL_DEFS.map((d) => d.name).sort();
  assert.deepEqual(names, [
    'data_admin', 'data_catalog', 'data_create_dataset', 'data_delete', 'data_drop_dataset',
    'data_get', 'data_keys', 'data_put', 'data_query', 'data_request_access',
    'data_revoke_key', 'data_search', 'data_sync', 'data_sync_status',
  ]);
  for (const n of names) assert.equal(typeof DATA_HANDLERS[n], 'function');
});
```

Append behavior tests (mirror the existing data-tools test style — `enable()`, `runWithMcpContext`, `textOf`):

```typescript
test('data tools: catalog reports the caller capability (you.canManage)', async () => {
  enable();
  const local = await runWithMcpContext({ principal: { type: 'local' } }, () => DATA_HANDLERS.data_catalog({}));
  const lj = JSON.parse(textOf(local));
  assert.equal(lj.you.principal, 'local');
  assert.equal(lj.you.canManage, true);
  const cloud = await runWithMcpContext({ principal: { type: 'cloud', userId: 'u' } }, () => DATA_HANDLERS.data_catalog({}));
  const cj = JSON.parse(textOf(cloud));
  assert.equal(cj.you.principal, 'cloud');
  assert.equal(cj.you.canManage, false);
});

test('data tools: local can create + drop a dataset; list keys; sync status', async () => {
  enable();
  const id = `mgmt_${Date.now()}`;
  const create = await runWithMcpContext({ principal: { type: 'local' } }, () =>
    DATA_HANDLERS.data_create_dataset({ id, backend: 'cache', config: { kind: 'cache' } }));
  assert.equal(create.isError ?? false, false);
  assert.match(textOf(create), new RegExp(id));
  const keys = await runWithMcpContext({ principal: { type: 'local' } }, () => DATA_HANDLERS.data_keys({}));
  assert.equal(keys.isError ?? false, false);
  assert.ok(!textOf(keys).includes('secretHash'));
  const ss = await runWithMcpContext({ principal: { type: 'local' } }, () => DATA_HANDLERS.data_sync_status({}));
  assert.equal(ss.isError ?? false, false);
  const drop = await runWithMcpContext({ principal: { type: 'local' } }, () =>
    DATA_HANDLERS.data_drop_dataset({ dataset: id }));
  assert.equal(drop.isError ?? false, false);
});

test('data tools: a REMOTE (cloud) session is refused management with an actionable message', async () => {
  enable();
  for (const tool of ['data_create_dataset', 'data_drop_dataset', 'data_keys', 'data_revoke_key', 'data_sync', 'data_sync_status']) {
    const r = await runWithMcpContext({ principal: { type: 'cloud', userId: 'u' } }, () =>
      DATA_HANDLERS[tool]({ id: 'x', dataset: 'x', keyId: 'k' }));
    assert.equal(r.isError, true, `${tool} should refuse cloud`);
    assert.match(textOf(r), /local-only/i, `${tool} message should explain local-only`);
    assert.match(textOf(r), /remote|cloud|local session/i, `${tool} message should be actionable`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/data-tools.test.js`
Expected: FAIL — the 6 management handlers are undefined; the 14-tool deepEqual fails; `you` is absent from catalog.

- [ ] **Step 3: Add the capability signal to `data_catalog`**

In `handleDataCatalog`, change the return to include `you`:
```typescript
  return ok(pretty({
    you: { principal: c.principal.type, canManage: c.principal.type === 'local' },
    servedBy,
    datasets: svc.catalog(c.principal),
  }));
```

- [ ] **Step 4: Add the `requireLocal` helper + the 6 management handlers**

In `core/src/mcp-server/tools/data-tools.ts`, add the helper (after `ctxFromArgs`):

```typescript
const LOCAL_ONLY_MSG =
  'FORBIDDEN: data management is local-only. This MCP session is remote (a cloud principal), so it cannot create/drop datasets, manage access keys, or trigger sync. Run management from a Claude Code session on the data-service host (a local session). Tip: call data_catalog and check you.canManage.';

/** Front-gate management tools on a LOCAL principal, returning a clear, actionable message for remote sessions. */
function requireLocalCtx(): CallCtx | { error: string } {
  const c = currentMcpContext();
  if (!c) return { error: 'no MCP principal context (tool invoked outside an MCP entry point)' };
  if (c.principal.type !== 'local') return { error: LOCAL_ONLY_MSG };
  return { principal: c.principal };
}
```

Add the handlers:

```typescript
async function handleDataCreateDataset(args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = requireLocalCtx(); if ('error' in ctx) return err(ctx.error);
  const svc = getDataService(); if (!svc.isEnabled()) return err('data service is disabled');
  const id = String(args.id || ''); if (!id) return err('id is required');
  const r = await svc.createDataset(ctx, {
    id,
    backend: (args.backend as any) || 'cache',
    title: typeof args.title === 'string' ? args.title : undefined,
    visibility: args.visibility as any,
    readOnly: args.readOnly === true ? true : undefined,
    sensitive: args.sensitive === true ? true : undefined,
    syncMode: args.syncMode as any,
    config: (args.config && typeof args.config === 'object' ? args.config : { kind: (args.backend as any) || 'cache' }) as any,
    acl: Array.isArray(args.acl) ? (args.acl as any) : undefined,
  });
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  return ok(pretty(r.value));
}

async function handleDataDropDataset(args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = requireLocalCtx(); if ('error' in ctx) return err(ctx.error);
  const svc = getDataService(); if (!svc.isEnabled()) return err('data service is disabled');
  const dataset = String(args.dataset || ''); if (!dataset) return err('dataset is required');
  const r = await svc.dropDataset(ctx, dataset);
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  return ok(pretty(r.value));
}

async function handleDataKeys(_args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = requireLocalCtx(); if ('error' in ctx) return err(ctx.error);
  const svc = getDataService(); if (!svc.isEnabled()) return err('data service is disabled');
  const r = await svc.listKeys(ctx);
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  return ok(pretty(r.value));
}

async function handleDataRevokeKey(args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = requireLocalCtx(); if ('error' in ctx) return err(ctx.error);
  const svc = getDataService(); if (!svc.isEnabled()) return err('data service is disabled');
  const keyId = String(args.keyId || ''); if (!keyId) return err('keyId is required');
  const revoked = await svc.revoke(ctx.principal, keyId);
  return ok(pretty({ revoked }));
}

async function handleDataSync(_args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = requireLocalCtx(); if ('error' in ctx) return err(ctx.error);
  const svc = getDataService(); if (!svc.isEnabled()) return err('data service is disabled');
  const r = await svc.sync(ctx);
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  return ok(pretty(r.value));
}

async function handleDataSyncStatus(_args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = requireLocalCtx(); if ('error' in ctx) return err(ctx.error);
  const svc = getDataService(); if (!svc.isEnabled()) return err('data service is disabled');
  const r = await svc.syncStatus(ctx);
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  return ok(pretty(r.value));
}
```

> `CallCtx` is already imported (`import { getDataService, type CallCtx } from '../../data/data-service'`). `requireLocalCtx` returns a `CallCtx` (the `{ principal }` shape) or `{ error }`.

- [ ] **Step 5: Add the 6 tool defs + handler-map entries**

Add to `DATA_TOOL_DEFS` (after `data_admin`). Descriptions MUST state local-only + the capability tip:

```typescript
  {
    name: 'data_create_dataset',
    description: 'Create a new data-service dataset (cache/vector/sql). LOCAL-ONLY: works only from a Claude Code session running on the data-service host; a remote/hub session is refused. Check data_catalog -> you.canManage first. Body: { id, backend, visibility?, syncMode?, config?, acl?, readOnly?, sensitive? }.',
    annotations: { readOnlyHint: false },
    inputSchema: { type: 'object' as const, properties: {
      id: STR('Dataset id (^[a-z0-9][a-z0-9_-]{0,63}$; not a reserved name).'),
      backend: STR('Backend: cache | vector | sql.'),
      visibility: STR('local-only | synced | cross-node-readable.'),
      syncMode: STR('none | full | partial.'),
      config: { type: 'object' as const, description: 'BackendConfig, e.g. { kind:"sql", indexedFields:[...] }.' },
      acl: { type: 'array' as const, description: 'AclRule[]: [{ principal, actions[] }].', items: { type: 'object' as const } },
      title: STR('Optional title.'),
    }, required: ['id', 'backend'] },
  },
  {
    name: 'data_drop_dataset',
    description: 'Drop a dataset and its backend storage. LOCAL-ONLY (remote sessions refused). Refuses system datasets + remote replicas. Check data_catalog -> you.canManage.',
    annotations: { readOnlyHint: false },
    inputSchema: { type: 'object' as const, properties: { dataset: STR('Dataset id to drop.') }, required: ['dataset'] },
  },
  {
    name: 'data_keys',
    description: 'List issued access keys (metadata only — keyId, principal, grants, expiry, revoked; NEVER secrets). LOCAL-ONLY (remote sessions refused).',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'data_revoke_key',
    description: 'Revoke an access key by keyId. LOCAL-ONLY (remote sessions refused).',
    annotations: { readOnlyHint: false },
    inputSchema: { type: 'object' as const, properties: { keyId: STR('The keyId to revoke (from data_keys).') }, required: ['keyId'] },
  },
  {
    name: 'data_sync',
    description: 'Trigger a cross-node reconcile (pull synced datasets from peers). LOCAL-ONLY (remote sessions refused). Returns the sync run summary.',
    annotations: { readOnlyHint: false },
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'data_sync_status',
    description: 'Report the cross-node sync status (last run, peers checked, records applied/skipped, errors). LOCAL-ONLY (remote sessions refused).',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
```

Add to `DATA_HANDLERS`:
```typescript
  data_create_dataset: handleDataCreateDataset,
  data_drop_dataset: handleDataDropDataset,
  data_keys: handleDataKeys,
  data_revoke_key: handleDataRevokeKey,
  data_sync: handleDataSync,
  data_sync_status: handleDataSyncStatus,
```

- [ ] **Step 6: Run the full data suite + production build**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/`
Expected: PASS — 14-tool assertion; catalog `you.canManage`; local create/drop/keys/sync-status; the remote-refused-with-actionable-message test for all 6.
Then: `cd /home/ubuntu/lm-assist && ./core.sh build`
Expected: tsc clean.

- [ ] **Step 7: Commit**

```bash
git add core/src/mcp-server/tools/data-tools.ts core/src/__tests__/data/data-tools.test.ts
git commit -m "feat(data): 6 MCP management tools (create/drop dataset, keys, revoke, sync, sync-status) — local-only + data_catalog you.canManage capability signal"
```

---

## Post-Plan: Controller Verification (folded into the M6 deploy)

After both tasks pass review, the controller verifies on dev `:3200` via the local stdio MCP path (local principal): `data_catalog` shows `you.canManage: true`; `data_create_dataset` → `data_put` → `data_query` → `data_drop_dataset` round-trips; `data_keys` shows no secretHash; `data_sync_status` returns. Then a hub-relayed (`x-relay-source: hub`) call to a management tool returns the local-only refusal. The MCP tools ship with the lightweight `core/dist` sync (same as M3) — deployable to the fleet immediately; the web UI (M6b) is a separate plan.
