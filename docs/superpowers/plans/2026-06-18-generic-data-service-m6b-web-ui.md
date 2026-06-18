# Generic Data Service — M6b: Web Management UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/data` page to the lm-assist web UI that lets a LOCAL operator view and manage the generic data service — datasets (list/create/drop), access keys (list/revoke), and cross-node sync (status/trigger) — with management actions gated and clearly explained when the session is not local, mirroring the MCP `you.canManage` capability signal.

**Architecture:** One new client React page (`DataPage`) talks to Core's existing REST `/data/*` routes via the app's `apiClient.fetchPath`. The only backend additions are (a) a `DataService.catalogView(principal)` method returning `{ you, datasets }` so the UI learns its capability in the same call it lists datasets, surfaced additively on `GET /data/catalog`, and (b) a new local-only `GET /data/keys` route exposing the already-built `DataService.listKeys` over REST (it was MCP-only). All management mutations (create/drop dataset, revoke key, trigger sync) already enforce local-only server-side; the UI mirrors that with `canManage` gating for legibility, not as the security boundary.

**Tech Stack:** Next.js 16 App Router, React 19 client components, `apiClient` from `@/contexts/AppModeContext`, lucide-react icons, the bespoke global CSS design system in `web/src/app/globals.css`. No web test framework — web tasks are verified visually on the dev server (`:3948`).

## Global Constraints

- **Local-only is server-enforced; the UI gates for UX only.** Never present `canManage` as a security control. The route/service layer remains the boundary: every management route already returns `FORBIDDEN` for a non-local principal. The UI disables those controls and explains why.
- **Never expose secrets.** The keys view shows metadata only (`keyId`, `principalType`, `node`, `grants`, `label`, `issuedAt`, `expiresAt`, `revoked`). `secretHash` is already stripped by `DataService.listKeys` (`PublicKey = Omit<AccessKey,'secretHash'>`); the UI must never render or request a secret.
- **API rule (project):** every new route handler wraps its result in `wrapResponse` / `wrapError`. Validate inputs. Never log credentials.
- **No browser modal dialogs.** Do NOT use `window.confirm`/`alert`/`prompt` for destructive actions — use an inline two-click confirm (a row enters a "Confirm?" state) so nothing blocks the page.
- **Port discipline:** verify on dev (`./core.sh restart` → `:3200` core, `:3948` web). Never touch prod (`:3100`/`:3848`).
- **Backend types (verbatim from `core/src/data/types.ts`):**
  - `BackendKind = 'vector' | 'sql' | 'cache' | 'knowledge' | 'vectors' | 'file'`
  - `DataAction = 'read' | 'query' | 'search' | 'write' | 'delete' | 'manage'`
  - `NodeVisibility = 'local-only' | 'synced' | 'cross-node-readable'`
  - `SyncMode = 'none' | 'full' | 'partial'`
  - Catalog entry: `{ id: string; backend: BackendKind; visibility: NodeVisibility; readOnly: boolean; actions: DataAction[] }`
  - `PublicKey` fields: `keyId, principalType, principalId?, node, grants: {dataset,actions}[], label?, issuedAt, expiresAt, revoked?`
  - `SyncStatus = { lastRun: string|null; peersChecked: number; datasetsReplicated: number; recordsApplied: number; recordsSkipped: number; errors: string[] }`

---

### Task 1: Backend — `catalogView` + capability on `/data/catalog` + new `GET /data/keys`

**Files:**
- Modify: `core/src/data/data-service.ts` (add `catalogView` method near `catalog`, ~line 42)
- Modify: `core/src/routes/core/data.routes.ts` (`GET /data/catalog` handler ~line 37; add `GET /data/keys` route)
- Test: `core/src/__tests__/data/data-management.test.ts` (add `catalogView` tests)

**Interfaces:**
- Consumes: existing `DataService.catalog(p)`, `DataService.listKeys(ctx)` (local-only, returns `PublicKey[]`), `resolvePrincipal(req)`, `ctxOf(req)`, `wrapResponse`/`wrapError`.
- Produces (later tasks rely on these exact response shapes):
  - `GET /data/catalog` → `{ you: { principal: 'local'|'cloud'; canManage: boolean }, datasets: CatalogEntry[] }`
  - `GET /data/keys` → `{ keys: PublicKey[] }` (local-only; `FORBIDDEN` otherwise)
  - `DataService.catalogView(p: Principal): { you: { principal: Principal['type']; canManage: boolean }; datasets: ReturnType<DataService['catalog']> }`

- [ ] **Step 1: Write the failing test**

Add to `core/src/__tests__/data/data-management.test.ts` (uses the existing `svc()`, `LOCAL`, `CLOUD` defined at the top of that file):

```ts
test('catalogView: reports caller capability (canManage) alongside visible datasets', async () => {
  const { s, datasets } = svc();
  datasets.create({ id: 'cv1', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [{ principal: '*', actions: ['read'] }] });

  const local = s.catalogView(LOCAL.principal);
  assert.equal(local.you.principal, 'local');
  assert.equal(local.you.canManage, true);
  assert.ok(Array.isArray(local.datasets));
  assert.ok(local.datasets.some((d) => d.id === 'cv1'));

  const cloud = s.catalogView(CLOUD.principal);
  assert.equal(cloud.you.principal, 'cloud');
  assert.equal(cloud.you.canManage, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd /home/ubuntu/lm-assist && npx tsc -p core/tsconfig.test.json && node --test dist-test/__tests__/data/data-management.test.js
```
Expected: FAIL — `s.catalogView is not a function` (or a compile error that `catalogView` does not exist).

- [ ] **Step 3: Implement `catalogView`**

In `core/src/data/data-service.ts`, immediately after the `catalog(p: Principal)` method (~line 42), add:

```ts
  /** Catalog plus the caller's management capability — one call for the web UI / MCP catalog.
   *  canManage mirrors the local-only management boundary (local principal only). */
  catalogView(p: Principal): { you: { principal: Principal['type']; canManage: boolean }; datasets: ReturnType<DataService['catalog']> } {
    return {
      you: { principal: p.type, canManage: p.type === 'local' },
      datasets: this.catalog(p),
    };
  }
```

(If `Principal` is not already imported in this file, it is — `catalog(p: Principal)` already uses it. Do not add a duplicate import.)

- [ ] **Step 4: Run test to verify it passes**

```
cd /home/ubuntu/lm-assist && npx tsc -p core/tsconfig.test.json && node --test dist-test/__tests__/data/data-management.test.js
```
Expected: PASS (the new test plus the existing management tests).

- [ ] **Step 5: Wire the routes**

In `core/src/routes/core/data.routes.ts`:

(a) Replace the `GET /data/catalog` handler body so it returns the capability view:

```ts
    // GET /data/catalog — datasets visible to caller + the caller's management capability
    {
      method: 'GET',
      pattern: /^\/data\/catalog$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        return wrapResponse(svc().catalogView(svc().resolvePrincipal(req)), start);
      },
    },
```

(b) Add a new local-only `GET /data/keys` route. Place it directly AFTER the `DELETE /data/access/:keyId` route (~line 68) so the key-management routes sit together:

```ts
    // GET /data/keys — list issued access keys (metadata only; NEVER secretHash). LOCAL-ONLY.
    {
      method: 'GET',
      pattern: /^\/data\/keys$/,
      handler: async (req) => {
        const start = Date.now();
        if (!svc().isEnabled()) return disabled(start);
        const r = await svc().listKeys(ctxOf(req));
        if (!r.ok) return wrapError(r.code, r.reason, start);
        return wrapResponse({ keys: r.value }, start);
      },
    },
```

(`ctxOf`, `disabled`, `wrapResponse`, `wrapError`, `svc` are all already defined/imported at the top of this file — do not re-import.)

- [ ] **Step 6: Full data suite + build**

```
cd /home/ubuntu/lm-assist && node --test dist-test/__tests__/data/*.test.js 2>&1 | tail -5
cd /home/ubuntu/lm-assist && ./core.sh build 2>&1 | tail -5
```
Expected: all data tests pass (was 160 after the M6a fix-wave → 161 now), build clean.

- [ ] **Step 7: Commit**

```bash
git add core/src/data/data-service.ts core/src/routes/core/data.routes.ts core/src/__tests__/data/data-management.test.ts
git commit -m "feat(data): catalogView capability + local-only GET /data/keys for the web UI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Web — `/data` route, Sidebar nav, DataPage shell + Datasets tab

**Files:**
- Create: `web/src/app/(dashboard)/data/page.tsx`
- Create: `web/src/components/data/DataPage.tsx`
- Modify: `web/src/components/layout/Sidebar.tsx` (import `Database`; add nav entry to `baseNavItems`)

**Interfaces:**
- Consumes: `useAppMode()` → `{ apiClient, proxy }`; `apiClient.fetchPath<T>(path, { method?, body?, machineId? })` (throws on non-2xx, returns unwrapped `.data`); routes from Task 1 (`GET /data/catalog`) and existing `POST /data/datasets`, `DELETE /data/datasets/:id`.
- Produces: `export function DataPage()`; the shared in-component `apiFetch`, `tab` state, `canManage`/`principal` state, and `fetchCatalog`/`datasets` that Task 3 extends with Keys/Sync tabs.

- [ ] **Step 1: Add the Sidebar nav entry**

In `web/src/components/layout/Sidebar.tsx`, add `Database` to the existing `lucide-react` import, then add one entry to the `baseNavItems` array (match the existing shape `{ href, icon, label }`). Place it right after the Knowledge entry:

```ts
{ href: '/data', icon: Database, label: 'Data' },
```

- [ ] **Step 2: Create the page route wrapper**

Create `web/src/app/(dashboard)/data/page.tsx`:

```tsx
'use client';

import { DataPage } from '@/components/data/DataPage';

export default function DataRoute() {
  return <DataPage />;
}
```

- [ ] **Step 3: Create `DataPage` with the shell + Datasets tab**

Create `web/src/components/data/DataPage.tsx`:

```tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import { Database, Plus, Trash2, KeyRound, RefreshCw, Loader2, ShieldAlert, X } from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';

type BackendKind = 'vector' | 'sql' | 'cache' | 'knowledge' | 'vectors' | 'file';
type DataAction = 'read' | 'query' | 'search' | 'write' | 'delete' | 'manage';
type NodeVisibility = 'local-only' | 'synced' | 'cross-node-readable';

interface CatalogEntry { id: string; backend: BackendKind; visibility: NodeVisibility; readOnly: boolean; actions: DataAction[]; }
interface CatalogResponse { you: { principal: 'local' | 'cloud'; canManage: boolean }; datasets: CatalogEntry[]; }
interface PublicKey {
  keyId: string; principalType: string; principalId?: string; node: string;
  grants: { dataset: string; actions: DataAction[] }[]; label?: string;
  issuedAt: string; expiresAt: string; revoked?: boolean;
}
interface SyncStatus {
  lastRun: string | null; peersChecked: number; datasetsReplicated: number;
  recordsApplied: number; recordsSkipped: number; errors: string[];
}

type Tab = 'datasets' | 'keys' | 'sync';

export function DataPage() {
  const { apiClient, proxy } = useAppMode();

  const apiFetch = useCallback(
    async <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> =>
      apiClient.fetchPath<T>(path, { method: opts?.method, body: opts?.body, machineId: proxy.machineId || undefined }),
    [apiClient, proxy.machineId],
  );

  const [tab, setTab] = useState<Tab>('datasets');
  const [principal, setPrincipal] = useState<'local' | 'cloud' | ''>('');
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Datasets tab state
  const [datasets, setDatasets] = useState<CatalogEntry[]>([]);
  const [loadingDs, setLoadingDs] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<{ id: string; backend: BackendKind; visibility: NodeVisibility; syncMode: string }>({
    id: '', backend: 'cache', visibility: 'local-only', syncMode: 'none',
  });
  const [creating, setCreating] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null);

  const fetchCatalog = useCallback(async () => {
    setLoadingDs(true);
    try {
      const r = await apiFetch<CatalogResponse>('/data/catalog');
      setDatasets(r.datasets || []);
      setPrincipal(r.you?.principal ?? '');
      setCanManage(!!r.you?.canManage);
      setError(null);
    } catch (e) {
      console.error('fetchCatalog failed', e);
      setError(e instanceof Error ? e.message : 'failed to load catalog');
    } finally {
      setLoadingDs(false);
    }
  }, [apiFetch]);

  useEffect(() => { fetchCatalog(); }, [fetchCatalog]);

  const createDataset = useCallback(async () => {
    if (!form.id.trim()) return;
    setCreating(true);
    try {
      await apiFetch('/data/datasets', {
        method: 'POST',
        body: { id: form.id.trim(), backend: form.backend, visibility: form.visibility, syncMode: form.syncMode, config: { kind: form.backend } },
      });
      setShowCreate(false);
      setForm({ id: '', backend: 'cache', visibility: 'local-only', syncMode: 'none' });
      await fetchCatalog();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create failed');
    } finally {
      setCreating(false);
    }
  }, [apiFetch, form, fetchCatalog]);

  const dropDataset = useCallback(async (id: string) => {
    try {
      await apiFetch(`/data/datasets/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setConfirmDrop(null);
      await fetchCatalog();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'drop failed');
    }
  }, [apiFetch, fetchCatalog]);

  const badgeForBackend = (b: BackendKind) =>
    b === 'sql' ? 'badge-blue' : b === 'vector' ? 'badge-purple' : b === 'cache' ? 'badge-cyan'
      : b === 'file' ? 'badge-orange' : 'badge-default';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--color-bg-root)' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border-default)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Database size={20} style={{ color: 'var(--color-accent)' }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>Data Service</div>
        <div style={{ flex: 1 }} />
        {principal && (
          <span className={`badge ${canManage ? 'badge-green' : 'badge-default'}`}>
            {canManage ? 'local · can manage' : `${principal} · read-only`}
          </span>
        )}
      </div>

      {/* Tab bar */}
      <div className="tab-bar" style={{ padding: '0 20px' }}>
        <button className={`tab-item ${tab === 'datasets' ? 'active' : ''}`} onClick={() => setTab('datasets')}>Datasets</button>
        <button className={`tab-item ${tab === 'keys' ? 'active' : ''}`} onClick={() => setTab('keys')}>Access Keys</button>
        <button className={`tab-item ${tab === 'sync' ? 'active' : ''}`} onClick={() => setTab('sync')}>Sync</button>
      </div>

      {/* Capability banner for non-local sessions */}
      {!canManage && principal === 'cloud' && (
        <div style={{ margin: '12px 20px 0', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)' }}>
          <ShieldAlert size={16} style={{ color: 'var(--color-status-orange)' }} />
          <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
            This session is remote. Data management (create/drop datasets, keys, sync) is local-only — open this page from a Claude Code / browser session on the data-service host to manage it.
          </span>
        </div>
      )}

      {error && (
        <div style={{ margin: '12px 20px 0', padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-status-red)', color: 'var(--color-status-red)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setError(null)}><X size={12} /></button>
        </div>
      )}

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
        {tab === 'datasets' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>{datasets.length} dataset{datasets.length === 1 ? '' : 's'}</div>
              <div style={{ flex: 1 }} />
              <button className="btn btn-primary btn-sm" disabled={!canManage} onClick={() => setShowCreate((v) => !v)} title={canManage ? 'Create dataset' : 'Local-only'}>
                <Plus size={14} /> New dataset
              </button>
            </div>

            {showCreate && canManage && (
              <div className="card" style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
                <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>id<br />
                  <input className="input" value={form.id} placeholder="my-dataset" onChange={(e) => setForm({ ...form, id: e.target.value })} />
                </label>
                <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>backend<br />
                  <select className="input" value={form.backend} onChange={(e) => setForm({ ...form, backend: e.target.value as BackendKind })}>
                    <option value="cache">cache</option><option value="vector">vector</option><option value="sql">sql</option>
                  </select>
                </label>
                <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>visibility<br />
                  <select className="input" value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value as NodeVisibility })}>
                    <option value="local-only">local-only</option><option value="synced">synced</option><option value="cross-node-readable">cross-node-readable</option>
                  </select>
                </label>
                <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>syncMode<br />
                  <select className="input" value={form.syncMode} onChange={(e) => setForm({ ...form, syncMode: e.target.value })}>
                    <option value="none">none</option><option value="full">full</option><option value="partial">partial</option>
                  </select>
                </label>
                <button className="btn btn-primary btn-sm" disabled={creating || !form.id.trim()} onClick={createDataset}>
                  {creating ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : 'Create'}
                </button>
              </div>
            )}

            {loadingDs ? (
              <div className="empty-state"><Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} /><span style={{ fontSize: 12 }}>Loading…</span></div>
            ) : datasets.length === 0 ? (
              <div className="empty-state"><Database size={32} className="empty-state-icon" /><div>No datasets</div></div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {datasets.map((d) => (
                  <div key={d.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12 }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-text-primary)', minWidth: 160 }}>{d.id}</div>
                    <span className={`badge ${badgeForBackend(d.backend)}`}>{d.backend}</span>
                    <span className="badge badge-outline">{d.visibility}</span>
                    {d.readOnly && <span className="badge badge-default">read-only</span>}
                    <div style={{ flex: 1, fontSize: 11, color: 'var(--color-text-tertiary)' }}>{d.actions.join(' · ')}</div>
                    {confirmDrop === d.id ? (
                      <>
                        <button className="btn btn-destructive btn-sm" onClick={() => dropDataset(d.id)}>Confirm drop</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDrop(null)}>Cancel</button>
                      </>
                    ) : (
                      <button className="btn btn-ghost btn-sm" disabled={!canManage} onClick={() => setConfirmDrop(d.id)} title={canManage ? 'Drop dataset' : 'Local-only'}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'keys' && <KeysTab apiFetch={apiFetch} canManage={canManage} setError={setError} />}
        {tab === 'sync' && <SyncTab apiFetch={apiFetch} canManage={canManage} setError={setError} />}
      </div>
    </div>
  );
}

// Placeholder implementations replaced in Task 3:
function KeysTab(_props: { apiFetch: <T,>(p: string, o?: { method?: string; body?: unknown }) => Promise<T>; canManage: boolean; setError: (s: string | null) => void }) {
  return <div className="empty-state"><KeyRound size={32} className="empty-state-icon" /><div>Keys tab (Task 3)</div></div>;
}
function SyncTab(_props: { apiFetch: <T,>(p: string, o?: { method?: string; body?: unknown }) => Promise<T>; canManage: boolean; setError: (s: string | null) => void }) {
  return <div className="empty-state"><RefreshCw size={32} className="empty-state-icon" /><div>Sync tab (Task 3)</div></div>;
}
```

(`PublicKey` and `SyncStatus` are declared here now so Task 3 only fills the two tab bodies. The `_props` underscore-prefixes avoid an unused-var lint until Task 3 wires them.)

- [ ] **Step 4: Build the web app**

```
cd /home/ubuntu/lm-assist/web && npx next build 2>&1 | tail -15
```
Expected: build succeeds (the `/data` route compiles, no type errors).

- [ ] **Step 5: Visual verification on dev**

```
cd /home/ubuntu/lm-assist && ./core.sh restart 2>&1 | tail -3
hostname -I | awk '{print $1}'   # use this IP for the browser
```
Open `http://<IP>:3948/data`. Confirm: the **Data** nav item appears in the sidebar; the page header shows a `local · can manage` badge (the dev box is local); three tabs render; the **Datasets** tab lists the system datasets (`knowledge`, `vectors`, any tracked files) with backend/visibility badges; **New dataset** opens the inline form; creating `cache` dataset `ui-smoke-1` adds a row; the drop button shows the inline **Confirm drop** → dropping removes the row. The Keys and Sync tabs show their Task-3 placeholders.

- [ ] **Step 6: Commit**

```bash
git add web/src/app/\(dashboard\)/data/page.tsx web/src/components/data/DataPage.tsx web/src/components/layout/Sidebar.tsx
git commit -m "feat(web): /data management page — shell, Datasets tab, sidebar nav (capability-gated)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Web — Keys tab + Sync tab

**Files:**
- Modify: `web/src/components/data/DataPage.tsx` (replace the two placeholder `KeysTab`/`SyncTab` functions)

**Interfaces:**
- Consumes: the `apiFetch`, `canManage`, `setError` props already passed from `DataPage`; routes `GET /data/keys` (Task 1), `DELETE /data/access/:keyId`, `GET /data/sync/status`, `POST /data/sync`; the `PublicKey`/`SyncStatus` types declared in Task 2.
- Produces: nothing downstream (final task).

- [ ] **Step 1: Replace `KeysTab`**

In `web/src/components/data/DataPage.tsx`, replace the placeholder `KeysTab` function with:

```tsx
function KeysTab({ apiFetch, canManage, setError }: { apiFetch: <T,>(p: string, o?: { method?: string; body?: unknown }) => Promise<T>; canManage: boolean; setError: (s: string | null) => void }) {
  const [keys, setKeys] = useState<PublicKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch<{ keys: PublicKey[] }>('/data/keys');
      setKeys(r.keys || []);
    } catch (e) {
      console.error('fetchKeys failed', e);
      setError(e instanceof Error ? e.message : 'failed to load keys');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, setError]);

  useEffect(() => { if (canManage) fetchKeys(); else setLoading(false); }, [canManage, fetchKeys]);

  const revoke = useCallback(async (keyId: string) => {
    try {
      await apiFetch(`/data/access/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
      setConfirmRevoke(null);
      await fetchKeys();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'revoke failed');
    }
  }, [apiFetch, fetchKeys, setError]);

  if (!canManage) {
    return <div className="empty-state"><KeyRound size={32} className="empty-state-icon" /><div>Access-key management is local-only</div></div>;
  }
  if (loading) return <div className="empty-state"><Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} /><span style={{ fontSize: 12 }}>Loading…</span></div>;
  if (keys.length === 0) return <div className="empty-state"><KeyRound size={32} className="empty-state-icon" /><div>No access keys issued</div></div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {keys.map((k) => {
        const expired = new Date(k.expiresAt).getTime() < Date.now();
        return (
          <div key={k.keyId} className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-primary)', minWidth: 150 }}>{k.keyId}</div>
            <span className="badge badge-default">{k.principalType}{k.principalId ? `:${k.principalId}` : ''}</span>
            {k.revoked ? <span className="badge badge-red">revoked</span> : expired ? <span className="badge badge-orange">expired</span> : <span className="badge badge-green">active</span>}
            <div style={{ flex: 1, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              {k.label ? `${k.label} · ` : ''}{k.grants.map((g) => `${g.dataset}[${g.actions.join(',')}]`).join(' ')} · exp {new Date(k.expiresAt).toLocaleString()}
            </div>
            {!k.revoked && (confirmRevoke === k.keyId ? (
              <>
                <button className="btn btn-destructive btn-sm" onClick={() => revoke(k.keyId)}>Confirm revoke</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmRevoke(null)}>Cancel</button>
              </>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmRevoke(k.keyId)}>Revoke</button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Replace `SyncTab`**

Replace the placeholder `SyncTab` function with:

```tsx
function SyncTab({ apiFetch, canManage, setError }: { apiFetch: <T,>(p: string, o?: { method?: string; body?: unknown }) => Promise<T>; canManage: boolean; setError: (s: string | null) => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await apiFetch<SyncStatus>('/data/sync/status'));
    } catch (e) {
      console.error('fetchStatus failed', e);
      setError(e instanceof Error ? e.message : 'failed to load sync status');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, setError]);

  useEffect(() => { if (canManage) fetchStatus(); else setLoading(false); }, [canManage, fetchStatus]);

  const runSync = useCallback(async () => {
    setRunning(true);
    try {
      setStatus(await apiFetch<SyncStatus>('/data/sync', { method: 'POST' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'sync failed');
    } finally {
      setRunning(false);
    }
  }, [apiFetch, setError]);

  if (!canManage) {
    return <div className="empty-state"><RefreshCw size={32} className="empty-state-icon" /><div>Cross-node sync is local-only</div></div>;
  }
  if (loading) return <div className="empty-state"><Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} /><span style={{ fontSize: 12 }}>Loading…</span></div>;

  const stat = (label: string, value: string | number) => (
    <div className="card" style={{ padding: 12, minWidth: 120 }}>
      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-text-primary)' }}>{value}</div>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>Last run: {status?.lastRun ? new Date(status.lastRun).toLocaleString() : 'never'}</div>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary btn-sm" disabled={running} onClick={runSync}>
          {running ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={14} />} Reconcile now
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {stat('Peers checked', status?.peersChecked ?? 0)}
        {stat('Datasets', status?.datasetsReplicated ?? 0)}
        {stat('Records applied', status?.recordsApplied ?? 0)}
        {stat('Records skipped', status?.recordsSkipped ?? 0)}
      </div>
      {status && status.errors.length > 0 && (
        <div className="card" style={{ marginTop: 12, borderColor: 'var(--color-status-red)' }}>
          <div style={{ fontSize: 12, color: 'var(--color-status-red)', marginBottom: 6 }}>Errors</div>
          {status.errors.map((er, i) => <div key={i} style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)' }}>{er}</div>)}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Build the web app**

```
cd /home/ubuntu/lm-assist/web && npx next build 2>&1 | tail -15
```
Expected: build succeeds, no unused-var or type errors (the `_props` placeholders are gone).

- [ ] **Step 4: Visual verification on dev**

```
cd /home/ubuntu/lm-assist && ./core.sh restart 2>&1 | tail -3
```
Open `http://<IP>:3948/data`. Confirm: **Access Keys** tab — issue a key first (e.g. via the MCP `data_request_access` or `curl -s -XPOST :3200/data/access -d '{"grants":[{"dataset":"knowledge","actions":["read"]}],"intent":"ui smoke"}'`), reload the tab, see the key row with `active` badge + grants; the inline **Revoke** → **Confirm revoke** flips it to `revoked`. **Sync** tab — shows the stat cards (peers/datasets/applied/skipped) and last-run; **Reconcile now** runs and updates the numbers without error.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/data/DataPage.tsx
git commit -m "feat(web): /data Keys + Sync tabs (list/revoke keys, sync status/reconcile)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Post-plan (controller, after all tasks reviewed)

- Whole-branch review of M6b (the `/data` page + Task 1 routes) on the most capable model.
- **Fleet deploy (M6a + M6b together, to minimize touches on the flagged-unstable prod 117):**
  - **core/dist sync** (117/123/107) carries the M6a `createDataset` strip + Task-1 routes (`catalogView`, `GET /data/keys`) + serves Core's HTTP `/mcp` data tools.
  - **web build + restart** per node carries the `/data` page.
  - **plugin-cache refresh** is required for LOCAL Claude Code sessions to *see* the 6 M6a management tools (the stdio MCP server advertises `LM_ASSIST_TOOL_DEFS` from the plugin-cache build, then forwards execution to Core). A core/dist sync alone exposes the tools only on Core's HTTP `/mcp` surface, not to local stdio sessions. Decide per node whether local MCP management is needed before refreshing the cache.
