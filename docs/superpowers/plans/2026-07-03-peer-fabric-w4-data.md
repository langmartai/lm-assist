# Peer Fabric — Wave 4 (Data Service over Fabric) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the generic data service converge cross-node in ~1s instead of ~300s (spec §5 **S2** + **S3**) by (a) publishing a change-notify to the W3 bus on every write, (b) a per-node debounced sync listener that pulls the changed dataset, (c) carrying the sync manifest/export/fetch over the W2 fabric (with a hub-HTTPS fallback for legacy peers), (d) replacing minted per-dataset sync keys with a tightly-scoped **peer principal**, and (e) a CAS `ifVersion` write guard — all behind a new `dataSyncViaFabric` kill-switch, with `missions` as the first live consumer.

**Architecture:** W4 is the **first production data client of the fabric + bus**. `DataService.put/del` gain a `notify` hook that publishes `{type:'changed'|'deleted', ids}` to bus topic `data:<dataset>` — but ONLY for syncable datasets (`syncMode !== 'none'`), guarded to a no-op when the bus is off/not-ready. A new `SyncListener` observes the bus (`getBus().onLocalEvent`, which fires for local publishes AND cross-node ingests including catch-up first-sight), filters `data:*` events whose `origin !== self`, and drives a **bounded-debounce** `SyncEngine.pullDataset(fromNode, dataset)` — retiring the dead `dataset_updated`→hub push and the unbounded `SyncQueue`. The pull rides a new `FabricPeerClient` that sends manifest/export/fetch over `fabricRequestManaged({node}, …)` when `dataSyncViaFabric` is on AND the peer advertised the `data` HELLO feature AND a fabric link exists — else it falls back to the existing `HubPeerClient` hub-HTTPS + key-in-body path, so a mixed-version fleet keeps working. The peer RPC lands via the W2 rpc-server's loopback dispatch carrying `x-relay-source:'peer'` + `x-lm-peer-node`; `resolvePrincipal` (which today mis-classifies that loopback call as `local` root) is fixed to mint a read-only **peer principal** scoped to shareable datasets. The `/data/*` sync routes are added to the rpc-server allow-list under `dataSyncViaFabric` using the SAME URL-normalized `routedPath` guard W3 used for `/bus`, with an EXACT-shape regex (never a bare `/data/` prefix — the W3 CRITICAL traversal-bypass lesson). The 300s reconcile stays as the safety net. Spec: `docs/superpowers/specs/2026-07-02-peer-fabric-bus-data-design.md` (§5 S2/S3 + the W4 row of §6).

**Tech Stack:** TypeScript (CommonJS build), `node:test` + `assert/strict`. Reuses shipped `core/src/bus/` (W3: `getBus`, `Bus.publish/onLocalEvent/ingest`), `core/src/fabric/` (W2: `fabricRequestManaged`, `peerHasFeature`, `attachFabricLink`, `createRpcServer`), and `core/src/data/` (existing `DataService`, `SyncEngine`, `HubPeerClient`, `AccessManager`, `DatasetRegistry`). No new dependencies.

## Global Constraints

*(Every task's requirements implicitly include this section.)*

- Branch: `feat/peer-fabric-w4-data` (already checked out; work on it).
- **`dataSyncViaFabric` kill-switch (spec W4 row) — new `getProjectSettings().dataSyncViaFabric`, default `false` (opt-in).** JUSTIFICATION: it changes a **production sync transport** and the existing hub-HTTPS path already works; the wire-additive `data` HELLO feature + the `/data/*` fabric allow-list + the fabric pull are all gated on it, so `false` = pure legacy hub sync, **zero behaviour change**. The live e2e (Task 12) flips it on to prove the fabric path. (Contrast `busEnabled`/`fabricEnabled`, default `true`: those are new planes with no legacy path to preserve. This one replaces a working path, so it defaults off until proven on the fleet.) It gates: the fabric sync path in `FabricPeerClient`, the `/data/*` rpc-server allow-list, and the `data` HELLO feature advert. It does NOT gate change-notify or the SyncListener (those work over the hub path too).
- **Reuse W2 `fabricRequestManaged`** (retry/escalation) for every fabric sync RPC — NEVER bare `fabricRequest` (no retry). **Reuse the W3 bus** (`getBus().publish` / `onLocalEvent`) — do not invent a second event path.
- **NO hub (LangMartDesign) changes. NO `core/src/transport/` changes.** Reuse the frozen `Channel`, the shipped W2 `FabricLink`, and the W3 bus.
- **The `/data` fabric allow-list MUST use the URL-normalized `routedPath`** (`new URL(reqPath,'http://localhost').pathname`) and an **EXACT route-shape regex** — never a raw `startsWith('/data/')` prefix (the W3 CRITICAL bypass: a raw prefix let `/bus/../hub/config` through). The dispatched path MUST be the same normalized `routedPath` the allow-list validated (the rpc-server already does this). The allow-list matches ONLY: `GET /data/sync/manifest`, `POST /data/:ds/export`, `POST /data/:ds/fetch`.
- **Peer principal is READ-scoped to shareable datasets** (`visibility ∈ {synced, cross-node-readable}` AND NOT `sensitive`) and **WRITE-scoped to nothing** — a peer principal can only read/query/search via the sync routes and can NEVER write/delete/manage/create/drop/sql. The sync-merge write path (`importBatch`) runs on the PULLING node as its own **local** principal into a read-only replica — it is never a peer-driven write. Access keys are unchanged for cloud/connector callers. The peer principal is honored ONLY from a loopback origin carrying `x-relay-source:'peer'` (i.e. only the fabric rpc-server's loopbackDispatch can produce it); a non-loopback caller forging that header falls through to `cloud` (needs a key). This is the SECURITY CORE — Tasks 2, 3, 7 scope and test it.
- **Legacy/mixed-version:** a peer WITHOUT the `data` HELLO feature (older node, or `dataSyncViaFabric=false` on its side) syncs via the existing hub path unchanged. The Task 12 e2e includes a legacy-fallback node AND a fabric-path node.
- **Every new MCP tool MUST get a `TOOL_SCOPES` entry** in `core/src/mcp-server/configure.ts` or Core crashes on the first `/mcp` request (`assertScopesCoverTools`). **W4 adds NO new MCP tool** — it only adds an optional `ifVersion` arg to the existing `data_put` (already `TOOL_SCOPES: data_put: 'write'`). If a future step adds a tool, add its scope in the same commit.
- **Dev/prod-separated data dirs** (existing — `~/.lm-assist` vs `~/.lm-assist-dev` via `getDataDir`; `bus.lmdb` via `getCacheDir('bus')`). CommonJS build.
- **Build:** `cd /home/ubuntu/lm-assist && ./core.sh build` (core TS → `core/dist`).
- **Tests:** `cd /home/ubuntu/lm-assist/core && npm run build:test` compiles `tsconfig.test.json` → `dist-test/`; run a single file with the FULL node path:
  `~/.nvm/versions/node/v20.19.6/bin/node --test --test-reporter=spec dist-test/__tests__/data/<name>.test.js`
- Commit after every task. End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

### W3 whole-branch review follow-ups (addressed or explicitly deferred here)

- **(a) retention `eventsToEvict` — aged≥cap wipes fresh survivors: DEFERRED.** W4 does **not** wire `BusStore.sweep()` to any scheduler (no scheduler change in this wave), so the latent over-eviction is not newly triggered. It MUST be fixed before any future task schedules `sweep()`. A guard test is added in Task 5 to *document* the current behaviour without depending on it. (The one-line fix — `surplus = survivors.length - policy.maxEvents` instead of `events.length - …` — plus updating the one spec test that asserts the old behaviour is a follow-up, out of W4 scope.)
- **(b) add `busEnabled` + `dataSyncViaFabric` to the `PUT /project-settings` allowlist: DONE in Task 1** (so both kill-switches are API/UI-flippable).
- **(c) gate the `bus` HELLO feature on `busEnabled`, and the new `data` feature on `dataSyncViaFabric`: DONE in Task 10.**

## File Structure (what W4 creates/modifies)

```
core/src/project-settings.ts                     MOD  dataSyncViaFabric setting (default false) — 4 places
core/src/routes/core/project-settings.routes.ts  MOD  PUT allowlist: busEnabled + dataSyncViaFabric (follow-up b)
core/src/data/types.ts                           MOD  PrincipalType += 'peer'; Principal.node?; PutOptions{ifVersion}
core/src/data/access-manager.ts                  MOD  resolvePrincipal 'peer' branch (loopback+header); evaluateGrants + enforce peer read-only scoping
core/src/data/data-service.ts                    MOD  put/del change-notify (notify dep, syncable-only); CAS ifVersion; drop SyncQueue; FabricPeerClient wire
core/src/data/sync-listener.ts                   NEW  onLocalEvent(data:*) → bounded-debounce → pullDataset (replaces unbounded SyncQueue)
core/src/data/fabric-peer-client.ts              NEW  FabricPeerClient implements PeerClient: fabric path (managed) + HubPeerClient fallback
core/src/data/sync-boot.ts                        MOD  start SyncListener; drop flush timer + dataset_updated handler + flushNow; keep reconcile
core/src/data/sync-queue.ts                       DEL  retired (unbounded queue)
core/src/cluster/cluster-store.ts                 MOD  forceFlush() → no-op (write now self-publishes change-notify; flushNow retired)
core/src/fabric/rpc-server.ts                     MOD  /data/* allow-list under dataSyncEnabled (URL-normalized EXACT-shape regex)
core/src/fabric/index.ts                          MOD  fabricDataPeer + fabricDataRequest helpers; wire dataSyncEnabled into createRpcServer
core/src/fabric/peer-link.ts                      MOD  features dep — gate 'bus' on busEnabled, add 'data' on dataSyncViaFabric (follow-up c)
core/src/routes/core/data.routes.ts               MOD  PUT /data/:ds/records reads body.ifVersion → put opts (manifest/export/fetch unchanged)
core/src/mcp-server/tools/data-tools.ts           MOD  data_put: optional ifVersion arg → DataService.put opts
core/src/__tests__/data/*.test.ts                 NEW  unit + in-process two-node integration tests
```

---

### Task 1: `dataSyncViaFabric` kill-switch setting + PUT allowlist

**Files:**
- Modify: `core/src/project-settings.ts` (4 places, mirroring `busEnabled`)
- Modify: `core/src/routes/core/project-settings.routes.ts` (add `busEnabled` + `dataSyncViaFabric` to the `saveProjectSettings({…})` allowlist — follow-up b)
- Test: `core/src/__tests__/data/settings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `getProjectSettings().dataSyncViaFabric: boolean` (default `false`) — read by Tasks 7, 9, 10. `PUT /project-settings` accepts `busEnabled` + `dataSyncViaFabric`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/data/settings.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULTS, getProjectSettings, saveProjectSettings } from '../../project-settings';

test('dataSyncViaFabric defaults OFF (opt-in — replaces a working sync transport)', () => {
  assert.equal((DEFAULTS as Record<string, unknown>).dataSyncViaFabric, false);
});

test('load coerces a persisted dataSyncViaFabric=true', () => {
  const prev = getProjectSettings().dataSyncViaFabric;
  const updated = saveProjectSettings({ dataSyncViaFabric: true });
  assert.equal(updated.dataSyncViaFabric, true);
  saveProjectSettings({ dataSyncViaFabric: prev }); // restore
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test && ~/.nvm/versions/node/v20.19.6/bin/node --test --test-reporter=spec dist-test/__tests__/data/settings.test.js`
Expected: FAIL (`dataSyncViaFabric` undefined).

- [ ] **Step 3: Add `dataSyncViaFabric` in all four places of `core/src/project-settings.ts`**

In the `ProjectSettings` interface, after `busEnabled: boolean;`:
```ts
  /** Wave 4 (spec §5 S2): carry data-service sync (manifest/export/fetch) over the fabric with a
   *  peer principal, else the legacy hub-HTTPS path. Default false — opt-in; off = pure legacy sync. */
  dataSyncViaFabric: boolean;
```
In `DEFAULTS`, after `busEnabled: true,`:
```ts
  dataSyncViaFabric: false,
```
In the load/coerce block, after the `busEnabled:` coerce line:
```ts
      dataSyncViaFabric: typeof data.dataSyncViaFabric === 'boolean' ? data.dataSyncViaFabric : DEFAULTS.dataSyncViaFabric,
```
In the save/merge block, after the `busEnabled:` merge line:
```ts
    dataSyncViaFabric: typeof partial.dataSyncViaFabric === 'boolean' ? partial.dataSyncViaFabric : current.dataSyncViaFabric,
```

- [ ] **Step 4: Add both kill-switches to the PUT allowlist** — in `core/src/routes/core/project-settings.routes.ts`, extend the `saveProjectSettings({…})` object (after the `ruleSyncEnabled: body.ruleSyncEnabled,` line):
```ts
          busEnabled: body.busEnabled,
          dataSyncViaFabric: body.dataSyncViaFabric,
```

- [ ] **Step 5: Run test to verify it passes** (same command as Step 2). Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/project-settings.ts core/src/routes/core/project-settings.routes.ts core/src/__tests__/data/settings.test.ts && git commit -m "feat(data): dataSyncViaFabric kill-switch (default off) + PUT allowlist for bus/data toggles

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Peer principal — resolution (who the caller is)

**Files:**
- Modify: `core/src/data/types.ts` (widen `PrincipalType`; add `Principal.node`)
- Modify: `core/src/data/access-manager.ts` (`resolvePrincipal` — a `'peer'` branch, loopback+header gated, BEFORE the loopback→local branch)
- Test: `core/src/__tests__/data/peer-principal-resolve.test.ts`

**Interfaces:**
- Consumes: `ParsedRequest` (existing).
- Produces:
  - `type PrincipalType = 'local' | 'cloud' | 'peer'`
  - `interface Principal { type: PrincipalType; userId?: string; node?: string }`
  - `AccessManager.resolvePrincipal(req)` returns `{ type: 'peer', node }` ONLY when `x-relay-source === 'peer'` AND the client IP is loopback AND `x-lm-peer-node` is present; a `'peer'` source from any non-loopback origin returns `{ type: 'cloud' }`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/data/peer-principal-resolve.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AccessManager } from '../../data/access-manager';
import { DatasetRegistry } from '../../data/dataset-registry';
import { getKeyStore } from '../../data/key-store';

function mgr() {
  return new AccessManager({ datasets: new DatasetRegistry('/tmp/nope-datasets.json'), keys: getKeyStore(), nodeId: 'self' });
}
const req = (headers: Record<string, string>, clientIp?: string) =>
  ({ headers, clientIp } as unknown as import('../../routes/index').ParsedRequest);

test('a loopback peer RPC resolves to a scoped peer principal (NOT local root)', () => {
  const p = mgr().resolvePrincipal(req({ 'x-relay-source': 'peer', 'x-lm-peer-node': 'gw-b' }, '127.0.0.1'));
  assert.equal(p.type, 'peer');
  assert.equal(p.node, 'gw-b');
});

test('a forged x-relay-source:peer from a non-loopback origin falls to cloud (never local/peer)', () => {
  const p = mgr().resolvePrincipal(req({ 'x-relay-source': 'peer', 'x-lm-peer-node': 'gw-b' }, '10.0.1.42'));
  assert.equal(p.type, 'cloud');
});

test('a peer source with no node id is not honored as peer', () => {
  const p = mgr().resolvePrincipal(req({ 'x-relay-source': 'peer' }, '127.0.0.1'));
  assert.notEqual(p.type, 'peer');
});

test('hub relay still resolves to cloud; plain loopback still resolves to local', () => {
  assert.equal(mgr().resolvePrincipal(req({ 'x-relay-source': 'hub' }, '127.0.0.1')).type, 'cloud');
  assert.equal(mgr().resolvePrincipal(req({}, '127.0.0.1')).type, 'local');
});
```

- [ ] **Step 2: Run test to verify it fails** (Run the file per the Global Constraints command). Expected: FAIL (peer type not produced).

- [ ] **Step 3: Widen the types** in `core/src/data/types.ts`:

Replace:
```ts
export type PrincipalType = 'local' | 'cloud';

export interface Principal {
  type: PrincipalType;
  userId?: string; // present for cloud principals when the hub supplies one
}
```
with:
```ts
export type PrincipalType = 'local' | 'cloud' | 'peer';

export interface Principal {
  type: PrincipalType;
  userId?: string; // present for cloud principals when the hub supplies one
  node?: string;   // present for peer principals — the fabric gatewayId that issued the sync RPC
}
```

- [ ] **Step 4: Add the `'peer'` branch to `resolvePrincipal`** in `core/src/data/access-manager.ts`. Replace the method body:
```ts
  resolvePrincipal(req: ParsedRequest): Principal {
    // `x-relay-source` is set server-side by the hub relay, which strips any client-supplied copy
    // (see api-relay-handler) — so it is a trustworthy signal that this is a relayed (cloud) call.
    // `x-lm-user-id` is likewise relay-controlled (stripped from client input); it is unset in M1
    // until the hub injects a verified user id, so cloud callers get only '*'/cloud-class grants.
    if (header(req, 'x-relay-source') === 'hub') {
      return { type: 'cloud', userId: header(req, 'x-lm-user-id') };
    }
    // A fabric peer RPC arrives via the rpc-server's loopbackDispatch (127.0.0.1) carrying
    // x-relay-source:'peer' + x-lm-peer-node. Honor a peer principal ONLY from a genuine loopback
    // origin — that is the only path that can set this header (a non-loopback caller forging it must
    // NOT get peer trust). Checked BEFORE the loopback→local branch precisely because a peer RPC IS
    // loopback: without this, a peer sync call would resolve to LOCAL ROOT (the pre-W4 bug that made
    // the /data/* fabric allow-list a root-access hole).
    if (header(req, 'x-relay-source') === 'peer' && isLoopbackAddress(req.clientIp)) {
      const node = header(req, 'x-lm-peer-node');
      if (node) return { type: 'peer', node };
      return { type: 'cloud' }; // malformed peer header → untrusted, never local
    }
    // Not relayed: only a genuinely loopback caller (holding the local api-token) is trusted as
    // local root. Any other origin is treated as cloud (no userId) — never local root — which
    // defends the 0.0.0.0 bind if api-token auth is ever disabled.
    if (isLoopbackAddress(req.clientIp)) return { type: 'local' };
    return { type: 'cloud' };
  }
```

- [ ] **Step 5: Run test to verify it passes** (4 tests). Then `cd /home/ubuntu/lm-assist && ./core.sh build` (type-check the widened `Principal`).

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/data/types.ts core/src/data/access-manager.ts core/src/__tests__/data/peer-principal-resolve.test.ts && git commit -m "feat(data): peer principal resolution (loopback+header gated) — fix loopback peer RPC mis-resolving as local root

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Peer principal — authorization (what the peer can do)

**Files:**
- Modify: `core/src/data/access-manager.ts` (`evaluateGrants` + `enforce` — peer read-only, shareable-only, key-independent)
- Test: `core/src/__tests__/data/peer-principal-authz.test.ts`

**Interfaces:**
- Consumes: `Principal` (Task 2), `DatasetDescriptor`, `DataAction`.
- Produces (behaviour): for a `peer` principal —
  - `evaluateGrants(peer, d, requested)` returns the intersection of `requested` with `{read,query,search}` iff `d` is shareable (`visibility ∈ {synced,cross-node-readable}`) and NOT `sensitive`; else `[]`.
  - `enforce(peer, keyHeader, d, action)` → `{ok:true}` iff `action ∈ {read,query,search}` AND `d` shareable AND NOT `sensitive`; else a deny (`PEER_READ_ONLY` / `PEER_NOT_SHAREABLE` / `SENSITIVE`). The peer branch is evaluated BEFORE the key branch, so a peer can never widen its scope by presenting a key.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/data/peer-principal-authz.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AccessManager } from '../../data/access-manager';
import { DatasetRegistry } from '../../data/dataset-registry';
import { getKeyStore } from '../../data/key-store';
import type { DatasetDescriptor, Principal } from '../../data/types';

function mgr() {
  return new AccessManager({ datasets: new DatasetRegistry('/tmp/nope-authz.json'), keys: getKeyStore(), nodeId: 'self' });
}
const ds = (over: Partial<DatasetDescriptor>): DatasetDescriptor => ({
  id: 'd', backend: 'cache', ownerNode: 'self', visibility: 'cross-node-readable',
  syncMode: 'full', config: { kind: 'cache' }, acl: [], createdAt: '', updatedAt: '', ...over,
});
const peer: Principal = { type: 'peer', node: 'gw-b' };

test('peer may READ a shareable, non-sensitive dataset — no key needed', async () => {
  const r = await mgr().enforce(peer, undefined, ds({ visibility: 'cross-node-readable' }), 'read');
  assert.equal(r.ok, true);
  assert.deepEqual(mgr().evaluateGrants(peer, ds({ visibility: 'synced' }), ['read', 'query', 'search']).sort(), ['query', 'read', 'search']);
});

test('peer CANNOT read a local-only dataset', async () => {
  const r = await mgr().enforce(peer, undefined, ds({ visibility: 'local-only' }), 'read');
  assert.equal(r.ok, false);
  assert.deepEqual(mgr().evaluateGrants(peer, ds({ visibility: 'local-only' }), ['read']), []);
});

test('peer CANNOT read a sensitive dataset even if cross-node-readable', async () => {
  const r = await mgr().enforce(peer, undefined, ds({ sensitive: true }), 'read');
  assert.equal(r.ok, false);
  assert.deepEqual(mgr().evaluateGrants(peer, ds({ sensitive: true }), ['read']), []);
});

test('peer CANNOT write / delete / manage a shareable dataset (read-only)', async () => {
  for (const action of ['write', 'delete', 'manage'] as const) {
    const r = await mgr().enforce(peer, undefined, ds({}), action);
    assert.equal(r.ok, false, `peer must be denied ${action}`);
  }
  assert.deepEqual(mgr().evaluateGrants(peer, ds({}), ['write', 'delete', 'manage']), []);
});

test('a peer presenting a (bogus) key still cannot exceed read-only-shareable', async () => {
  const r = await mgr().enforce(peer, 'someid.somesecret', ds({}), 'write');
  assert.equal(r.ok, false); // peer branch decided BEFORE the key branch
});
```

- [ ] **Step 2: Run test to verify it fails** (peer not handled → falls through to `KEY_REQUIRED`/wrong result). Expected: FAIL.

- [ ] **Step 3: Add the peer branch to `evaluateGrants`** in `core/src/data/access-manager.ts`. Replace the method:
```ts
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
    if (p.type === 'peer') {
      // A fabric peer (trusted-by-construction gatewayId) may ONLY read a shareable, non-sensitive
      // dataset for sync — no ACL key, never write/delete/manage. This is what makes /data/sync/manifest
      // advertise exactly the shareable set to a peer (syncManifest calls evaluateGrants(peer, d, ['read'])).
      if (d.sensitive) return [];
      if (d.visibility !== 'synced' && d.visibility !== 'cross-node-readable') return [];
      allowed = new Set([...allowed].filter((a) => READ_ONLY_ACTIONS.includes(a)));
    }
    // readOnly is a HARD cap for everyone, incl. local root
    if (d.readOnly) allowed = new Set([...allowed].filter((a) => READ_ONLY_ACTIONS.includes(a)));
    return [...allowed];
  }
```

- [ ] **Step 4: Add the peer branch to `enforce`** in `core/src/data/access-manager.ts`. Insert the peer branch immediately AFTER the two hard-cap checks (`readOnly` + `sensitive && cloud`) and BEFORE the `if (keyHeader) {` block:
```ts
    // Peer principal (fabric sync RPC): authoritative + read-only, evaluated BEFORE the key branch
    // so a peer can never widen its scope by presenting a key. No key is required or consulted.
    if (p.type === 'peer') {
      if (d.sensitive) return await deny('SENSITIVE', 403, `dataset "${d.id}" is not shareable`);
      if (!READ_ONLY_ACTIONS.includes(action)) {
        return await deny('PEER_READ_ONLY', 403, `peers may only read via sync; "${action}" is denied`);
      }
      if (d.visibility !== 'synced' && d.visibility !== 'cross-node-readable') {
        return await deny('PEER_NOT_SHAREABLE', 403, `dataset "${d.id}" is not shareable cross-node`);
      }
      await this.deps.keys.appendAudit({ at: new Date().toISOString(), event: 'use',
        principalType: p.type, principalId: p.node, dataset: d.id, action });
      return { ok: true, principal: p };
    }
```

- [ ] **Step 5: Run test to verify it passes** (5 tests). Then `cd /home/ubuntu/lm-assist && ./core.sh build`.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/data/access-manager.ts core/src/__tests__/data/peer-principal-authz.test.ts && git commit -m "feat(data): peer principal authorization — read-only, shareable-only, key-independent (security core)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: CAS put — `ifVersion` optimistic-concurrency guard

**Files:**
- Modify: `core/src/data/types.ts` (add `PutOptions`)
- Modify: `core/src/data/data-service.ts` (`put` accepts `opts?: PutOptions`, returns `CONFLICT` on version mismatch)
- Test: `core/src/__tests__/data/cas-put.test.ts`

**Interfaces:**
- Consumes: `DataService`, `DataRecord`.
- Produces:
  - `interface PutOptions { ifVersion?: number }`
  - `DataService.put(ctx, datasetId, record, opts?: PutOptions)` — when `opts.ifVersion` is set and `!==` the stored record's version (absent ⇒ `0`), returns `{ ok:false, code:'CONFLICT', reason }`. LWW stays the SYNC merge rule; CAS guards only this direct write path.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/data/cas-put.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataService } from '../../data/data-service';
import { DatasetRegistry } from '../../data/dataset-registry';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { AccessManager } from '../../data/access-manager';
import { getKeyStore } from '../../data/key-store';
import type { DataRecord } from '../../data/types';

function svc() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-'));
  const datasets = new DatasetRegistry(path.join(dir, 'datasets.json'));
  const backends = new BackendRegistry();
  backends.register(new CacheBackend());
  const manager = new AccessManager({ datasets, keys: getKeyStore(), nodeId: 'self' });
  const s = new DataService({ datasets, backends, manager });
  datasets.create({ id: 'cas', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' } });
  return s;
}
const rec = (id: string): DataRecord => ({ id, version: 0, fields: {}, createdAt: '', updatedAt: '' });
const ctx = { principal: { type: 'local' as const } };

test('ifVersion:0 creates when absent; a second ifVersion:0 CONFLICTs', async () => {
  const s = svc();
  const r1 = await s.put(ctx, 'cas', rec('a'), { ifVersion: 0 });
  assert.equal(r1.ok, true);
  const r2 = await s.put(ctx, 'cas', rec('a'), { ifVersion: 0 }); // stored version is now 1
  assert.equal(r2.ok, false);
  assert.equal((r2 as { code: string }).code, 'CONFLICT');
});

test('ifVersion matching the stored version succeeds and bumps the version', async () => {
  const s = svc();
  await s.put(ctx, 'cas', rec('b'));                       // version → 1
  const r = await s.put(ctx, 'cas', rec('b'), { ifVersion: 1 });
  assert.equal(r.ok, true);
});

test('a plain put (no ifVersion) is unaffected by CAS', async () => {
  const s = svc();
  await s.put(ctx, 'cas', rec('c'));
  const r = await s.put(ctx, 'cas', rec('c'));             // no opts → always applies
  assert.equal(r.ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails** (`put` has no 4th param / no CONFLICT). Expected: FAIL.

- [ ] **Step 3: Add `PutOptions`** to `core/src/data/types.ts` (after the `Principal` interface):
```ts
export interface PutOptions {
  /** Optimistic-concurrency guard: the write applies only if the stored record's version equals
   *  this value (absent record ⇒ version 0). On mismatch DataService.put returns code 'CONFLICT'. */
  ifVersion?: number;
}
```

- [ ] **Step 4: Thread `ifVersion` through `DataService.put`** in `core/src/data/data-service.ts`. Update the import line 2-5 group to include `PutOptions`:
```ts
import type {
  Principal, DataAction, DataRecord, QuerySpec, SearchSpec, AccessRequest, BackendKind, NodeVisibility, SyncMode,
  PeerClient, NodeInfo, PutOptions,
} from './types';
```
Replace the `put` method signature + the CAS check (insert right after the replica guard, before `const existing`):
```ts
  async put(ctx: CallCtx, datasetId: string, record: DataRecord, opts?: PutOptions): Promise<DataResult<{ id: string }>> {
    const a = await this.authorize(ctx, datasetId, 'write');
    if (!a.ok) return a;
    const tooBig = recordTooLarge(record);
    if (tooBig) return { ok: false, code: 'RECORD_TOO_LARGE', reason: tooBig };
    const d = this.deps.datasets.get(datasetId)!;
    if ((d as any).origin) return { ok: false, code: 'READ_ONLY_REPLICA', reason: `dataset "${datasetId}" is a remote replica (read-only)` };
    const existing = await a.value.backend!.get(datasetId, record.id);
    if (opts?.ifVersion !== undefined) {
      const cur = existing?.version ?? 0;
      if (cur !== opts.ifVersion) {
        return { ok: false, code: 'CONFLICT', reason: `version mismatch on "${datasetId}/${record.id}": stored ${cur} != ifVersion ${opts.ifVersion}` };
      }
    }
    const now = new Date().toISOString();
    const versioned: DataRecord = {
      ...record,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      origin: undefined, // local-owned record (origin is stamped only on replicas)
    };
    const r = await a.value.backend!.put(datasetId, versioned);
    this.deps.onLocalWrite?.(datasetId, record.id);
    return { ok: true, value: r };
  }
```
(The `onLocalWrite` line is replaced by change-notify in Task 5 — leave it for now so this task builds green.)

- [ ] **Step 5: Run test to verify it passes** (3 tests). Then `cd /home/ubuntu/lm-assist && ./core.sh build`.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/data/types.ts core/src/data/data-service.ts core/src/__tests__/data/cas-put.test.ts && git commit -m "feat(data): CAS put via ifVersion — CONFLICT on version mismatch (LWW stays the sync merge rule)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Change-notify on put/del → bus (syncable-only, guarded)

**Files:**
- Modify: `core/src/data/data-service.ts` (add a `notify` dep; call it from `put`/`del` for syncable datasets only; drop the `onLocalWrite`/`SyncQueue` wiring in `getDataService`)
- Test: `core/src/__tests__/data/change-notify.test.ts`

**Interfaces:**
- Consumes: `DataService`, `DatasetDescriptor`.
- Produces:
  - `DataService` constructor dep `notify?: (dataset: string, type: 'changed' | 'deleted', ids: string[]) => void` (replaces `onLocalWrite`).
  - On a successful `put`, if the dataset's `syncMode` is `full`/`partial` (NOT `none`/undefined), calls `notify(datasetId, 'changed', [record.id])`. On a successful `del`, `notify(datasetId, 'deleted', [id])`. A `none`/local-only dataset never notifies (no bus churn).
  - `getDataService()` wires the production `notify` to `getBus().publish('data:'+dataset, type, { ids })`, guarded so a disabled/not-ready bus is a silent no-op.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/data/change-notify.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataService } from '../../data/data-service';
import { DatasetRegistry } from '../../data/dataset-registry';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { AccessManager } from '../../data/access-manager';
import { getKeyStore } from '../../data/key-store';
import type { DataRecord } from '../../data/types';

function svc(notify: (d: string, t: string, ids: string[]) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-'));
  const datasets = new DatasetRegistry(path.join(dir, 'datasets.json'));
  const backends = new BackendRegistry();
  backends.register(new CacheBackend());
  const manager = new AccessManager({ datasets, keys: getKeyStore(), nodeId: 'self' });
  const s = new DataService({ datasets, backends, manager, notify: notify as any });
  datasets.create({ id: 'synced', backend: 'cache', visibility: 'cross-node-readable', syncMode: 'full', config: { kind: 'cache' } });
  datasets.create({ id: 'localonly', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' } }); // syncMode defaults 'none'
  return s;
}
const rec = (id: string): DataRecord => ({ id, version: 0, fields: {}, createdAt: '', updatedAt: '' });
const ctx = { principal: { type: 'local' as const } };

test('put on a syncable dataset publishes a changed notify; del publishes deleted', async () => {
  const calls: Array<[string, string, string[]]> = [];
  const s = svc((d, t, ids) => calls.push([d, t, ids]));
  await s.put(ctx, 'synced', rec('x'));
  await s.del(ctx, 'synced', 'x');
  assert.deepEqual(calls, [['synced', 'changed', ['x']], ['synced', 'deleted', ['x']]]);
});

test('put on a syncMode:none dataset does NOT notify (no bus churn)', async () => {
  const calls: unknown[] = [];
  const s = svc((...a) => calls.push(a));
  await s.put(ctx, 'localonly', rec('y'));
  assert.equal(calls.length, 0);
});

test('a throwing notify (bus disabled) never breaks the write', async () => {
  const s = svc(() => { throw new Error('bus disabled'); });
  const r = await s.put(ctx, 'synced', rec('z'));
  assert.equal(r.ok, true); // put still succeeds
});
```

- [ ] **Step 2: Run test to verify it fails** (`notify` dep not wired). Expected: FAIL.

- [ ] **Step 3: Add the `notify` dep + call it** in `core/src/data/data-service.ts`. Update the constructor dep type:
```ts
  constructor(private deps: { datasets: DatasetRegistry; backends: BackendRegistry; manager: AccessManager; notify?: (dataset: string, type: 'changed' | 'deleted', ids: string[]) => void; peers?: PeerClient }) {}
```
Add a private helper (place it just above `put`):
```ts
  /** Fire a cross-node change-notify onto the bus — ONLY for syncable datasets, and wrapped so a
   *  disabled/not-ready bus (publish throws when busEnabled=false) is a silent no-op; the 300s
   *  reconcile is the safety net. A local-only ('none') dataset never churns the bus. */
  private notifyChange(d: DatasetDescriptor, type: 'changed' | 'deleted', ids: string[]): void {
    if (!d.syncMode || d.syncMode === 'none') return;
    try { this.deps.notify?.(d.id, type, ids); } catch { /* bus off / not ready — reconcile heals */ }
  }
```
Add `import type { DatasetDescriptor } from './types';` if not already present (it is imported transitively; add `DatasetDescriptor` to the type import group in Task 4's edit if the build complains).
In `put`, replace the `this.deps.onLocalWrite?.(datasetId, record.id);` line with:
```ts
    this.notifyChange(d, 'changed', [record.id]);
```
In `del`, replace the return line so it notifies on a real delete:
```ts
  async del(ctx: CallCtx, datasetId: string, id: string): Promise<DataResult<boolean>> {
    const a = await this.authorize(ctx, datasetId, 'delete');
    if (!a.ok) return a;
    const d = this.deps.datasets.get(datasetId)!;
    if ((d as any).origin) return { ok: false, code: 'READ_ONLY_REPLICA', reason: `dataset "${datasetId}" is a remote replica (read-only)` };
    const deleted = await a.value.backend!.delete(datasetId, id);
    if (deleted) this.notifyChange(d, 'deleted', [id]);
    return { ok: true, value: deleted };
  }
```

- [ ] **Step 4: Rewire `getDataService()`** in `core/src/data/data-service.ts` — remove the `SyncQueue` and wire the production bus `notify`. Delete the `import { getSyncQueue } from './sync-queue';` line. Replace the `getDataService` body's wiring block:
```ts
export function getDataService(): DataService {
  if (!instance) {
    const datasets = getDatasetRegistry();
    ensureSystemDatasets(datasets);
    ensureTrackedFiles(datasets);
    const backends = new BReg();
    backends.register(new CacheBackend());
    backends.register(new VectorBackend());
    backends.register(new KnowledgeBackend());
    backends.register(new VectorsBackend());
    backends.register(new FileBackend());
    backends.register(new SqlBackend());
    const manager = new AccessManager({ datasets, keys: getKeyStore(), nodeId: thisNodeId() });
    const nodeId = thisNodeId();
    const peers = new FabricPeerClient(nodeId);
    engineInstance = new SyncEngine({ datasets, backends, peers, nodeId });
    instance = new DataService({
      datasets, backends, manager, peers,
      // Production change-notify: publish to the W3 bus topic data:<dataset>. Guarded in notifyChange
      // (publish throws when busEnabled=false) so a disabled bus is a silent no-op.
      notify: (dataset, type, ids) => {
        const { getBus } = require('../bus') as typeof import('../bus');
        getBus().publish(`data:${dataset}`, type, { ids });
      },
    });
  }
  return instance;
}
```
Update the import at the top: replace `import { HubPeerClient } from './peer-client';` with `import { FabricPeerClient } from './fabric-peer-client';` (created in Task 7 — until then, temporarily keep `HubPeerClient` and use `new HubPeerClient(nodeId)` so this task builds; Task 7 swaps it). To keep THIS task green, use `new HubPeerClient(nodeId)` here and leave the `import { HubPeerClient }` line; the swap to `FabricPeerClient` happens in Task 7 Step 4.

- [ ] **Step 5: Run test to verify it passes** (3 tests). Then `cd /home/ubuntu/lm-assist && ./core.sh build`.

> NOTE (W3 review follow-up a): the bus `data:*` topics W4 introduces are higher-churn than any W3 topic, so retention matters more — but W4 does NOT schedule `BusStore.sweep()`, so the known `eventsToEvict` over-eviction (aged≥cap wiping fresh survivors) is not newly triggered. Deferred; must be fixed before any task wires `sweep()` to a scheduler.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/data/data-service.ts core/src/__tests__/data/change-notify.test.ts && git commit -m "feat(data): change-notify put/del -> bus data:<dataset> (syncable-only, guarded); retire SyncQueue wiring

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: SyncListener — bounded-debounce bus → pull

**Files:**
- Create: `core/src/data/sync-listener.ts`
- Test: `core/src/__tests__/data/sync-listener.test.ts`

**Interfaces:**
- Consumes: `BusEvent` (from `../bus`).
- Produces:
  - `interface SyncListenerDeps { selfNode: () => string; pull: (dataset: string, fromNode: string) => Promise<unknown>; onLocalEvent: (cb: (e: BusEvent) => void) => (() => void); debounceMs?: number; maxPending?: number }`
  - `class SyncListener { start(): void; stop(): void }` — on a `data:<dataset>` event whose `origin !== selfNode()`, schedules a debounced `pull(dataset, origin)`; coalesces rapid events per `(origin,dataset)`; bounds the pending map at `maxPending` (default 500) by firing the incoming key immediately instead of buffering when full; own-origin events are ignored (a local write needs no pull).

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/data/sync-listener.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SyncListener } from '../../data/sync-listener';
import type { BusEvent } from '../../bus/types';

function harness() {
  let cb: ((e: BusEvent) => void) | null = null;
  const pulls: Array<[string, string]> = [];
  const l = new SyncListener({
    selfNode: () => 'gw-self',
    pull: async (dataset, from) => { pulls.push([dataset, from]); },
    onLocalEvent: (fn) => { cb = fn; return () => { cb = null; }; },
    debounceMs: 5,
  });
  l.start();
  const emit = (e: Partial<BusEvent> & { topic: string; origin: string }) =>
    cb!({ seq: 1, type: 'changed', at: Date.now(), payload: { ids: ['r'] }, ...e } as BusEvent);
  return { l, pulls, emit };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a peer data event schedules one debounced pull(dataset, origin)', async () => {
  const { pulls, emit } = harness();
  emit({ topic: 'data:missions', origin: 'gw-b' });
  await wait(20);
  assert.deepEqual(pulls, [['missions', 'gw-b']]);
});

test('rapid same-key events coalesce into ONE pull', async () => {
  const { pulls, emit } = harness();
  for (let i = 0; i < 5; i++) emit({ topic: 'data:missions', origin: 'gw-b' });
  await wait(20);
  assert.equal(pulls.length, 1);
});

test('own-origin events are ignored (no self-pull)', async () => {
  const { pulls, emit } = harness();
  emit({ topic: 'data:missions', origin: 'gw-self' });
  await wait(20);
  assert.equal(pulls.length, 0);
});

test('non-data topics are ignored', async () => {
  const { pulls, emit } = harness();
  emit({ topic: 'mission:1', origin: 'gw-b' });
  await wait(20);
  assert.equal(pulls.length, 0);
});

test('stop() detaches and cancels pending timers', async () => {
  const { l, pulls, emit } = harness();
  emit({ topic: 'data:missions', origin: 'gw-b' });
  l.stop();
  await wait(20);
  assert.equal(pulls.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/data/sync-listener.ts
// Reactive cross-node convergence (spec §5 S2.1): observe the bus for data:<dataset> change-notify
// events and drive a debounced SyncEngine.pullDataset — the bounded replacement for the retired,
// unbounded SyncQueue + dead dataset_updated push. Uses getBus().onLocalEvent (fires for local
// publishes AND cross-node ingests, including catch-up first-sight), so a peer's change converges
// in ~1-2s; the 300s reconcile stays as the safety net. Own-origin events are skipped (a local write
// is already local). onLocalEvent teardown is a clean EventEmitter off() — chosen over Bus.subscribe()
// precisely to avoid W3's subscribe() trailing-delivery + failure-latch caveat (W4 is not a subscribe
// caller); at-least-once pull is instead provided by onLocalEvent re-firing on catch-up + the reconcile.
import type { BusEvent } from '../bus/types';

const DATA_PREFIX = 'data:';

export interface SyncListenerDeps {
  selfNode: () => string;
  pull: (dataset: string, fromNode: string) => Promise<unknown>;
  onLocalEvent: (cb: (e: BusEvent) => void) => (() => void);
  debounceMs?: number;
  maxPending?: number;
}

export class SyncListener {
  private timers = new Map<string, ReturnType<typeof setTimeout>>(); // `${origin}|${dataset}` → debounce timer
  private off: (() => void) | null = null;
  private readonly debounceMs: number;
  private readonly maxPending: number;

  constructor(private deps: SyncListenerDeps) {
    this.debounceMs = deps.debounceMs ?? 300;
    this.maxPending = deps.maxPending ?? 500;
  }

  start(): void {
    if (this.off) return;
    this.off = this.deps.onLocalEvent((e) => this.onEvent(e));
  }

  stop(): void {
    this.off?.();
    this.off = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private onEvent(e: BusEvent): void {
    if (!e || typeof e.topic !== 'string' || !e.topic.startsWith(DATA_PREFIX)) return;
    if (e.origin === this.deps.selfNode()) return; // our own write — nothing to pull
    const dataset = e.topic.slice(DATA_PREFIX.length);
    if (!dataset) return;
    this.schedule(dataset, e.origin);
  }

  private schedule(dataset: string, origin: string): void {
    const key = `${origin}|${dataset}`;
    const existing = this.timers.get(key);
    if (existing) { clearTimeout(existing); }
    else if (this.timers.size >= this.maxPending) {
      // Bound the buffer: rather than grow unboundedly under a flood of distinct (origin,dataset)
      // pairs, fire this one immediately (no debounce) — still idempotent, just less coalesced.
      void this.deps.pull(dataset, origin).catch(() => {});
      return;
    }
    const t = setTimeout(() => {
      this.timers.delete(key);
      void this.deps.pull(dataset, origin).catch(() => {});
    }, this.debounceMs);
    t.unref?.();
    this.timers.set(key, t);
  }
}
```

- [ ] **Step 4: Run test to verify it passes** (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/data/sync-listener.ts core/src/__tests__/data/sync-listener.test.ts && git commit -m "feat(data): SyncListener — bounded-debounce bus data:* -> pullDataset (replaces unbounded SyncQueue)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: FabricPeerClient — fabric sync path + hub fallback

**Files:**
- Create: `core/src/data/fabric-peer-client.ts`
- Modify: `core/src/data/data-service.ts` (swap `new HubPeerClient(nodeId)` → `new FabricPeerClient(nodeId)`)
- Test: `core/src/__tests__/data/fabric-peer-client.test.ts`

**Interfaces:**
- Consumes: `PeerClient`, `NodeInfo`, `ManifestEntry`, `DataRecord` (from `./types`); `HubPeerClient` (from `./peer-client`); the Task-8 fabric helpers `fabricDataPeer`/`fabricDataRequest` (injected for tests, defaulted to `require('../fabric')` in prod).
- Produces:
  - `class FabricPeerClient implements PeerClient` — `listPeers()` always via the hub roster; `manifest`/`exportFrom`/`getFrom` go over the fabric (`fabricDataRequest`, which uses `fabricRequestManaged`) when `dataSyncViaFabric` is on AND `fabricEligible(node)` (link exists + peer advertises `data`), unwrapping the `{success,data}` envelope; otherwise delegate to `HubPeerClient` (legacy hub-HTTPS + key-in-body). A fabric attempt that throws falls back to the hub path for that call.
  - Constructor test seam: `new FabricPeerClient(nodeId, hub?, deps?)` where `deps = { eligible?: (node)=>boolean; request?: (node, init)=>Promise<{status:number;data?:unknown}>; settings?: ()=>{dataSyncViaFabric:boolean} }`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/data/fabric-peer-client.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { FabricPeerClient } from '../../data/fabric-peer-client';
import type { NodeInfo, ManifestEntry, DataRecord } from '../../data/types';

const hubStub = (over: Partial<Record<string, (...a: any[]) => any>> = {}) => ({
  listPeers: async (): Promise<NodeInfo[]> => [{ node: 'gw-b', hostname: 'b', platform: 'linux' }],
  manifest: async (): Promise<{ node: string; datasets: ManifestEntry[] }> => ({ node: 'gw-b', datasets: [{ id: 'HUB', syncMode: 'full', ownerNode: 'gw-b', backend: 'cache' }] }),
  exportFrom: async (): Promise<DataRecord[]> => [{ id: 'hub', version: 1, fields: {}, createdAt: '', updatedAt: '' }],
  getFrom: async (): Promise<DataRecord | null> => null,
  ...over,
}) as any;

test('when eligible, manifest goes over the fabric and unwraps {success,data}', async () => {
  const c = new FabricPeerClient('self', hubStub(), {
    settings: () => ({ dataSyncViaFabric: true }),
    eligible: () => true,
    request: async (_n, init) => {
      assert.equal(init.path, '/data/sync/manifest');
      return { status: 200, data: { success: true, data: { node: 'gw-b', datasets: [{ id: 'FAB', syncMode: 'full', ownerNode: 'gw-b', backend: 'cache' }] } } };
    },
  });
  const m = await c.manifest('gw-b');
  assert.equal(m.datasets[0].id, 'FAB'); // fabric path, not hub
});

test('when dataSyncViaFabric is off, everything uses the hub fallback', async () => {
  const c = new FabricPeerClient('self', hubStub(), { settings: () => ({ dataSyncViaFabric: false }), eligible: () => true, request: async () => { throw new Error('must not be called'); } });
  const m = await c.manifest('gw-b');
  assert.equal(m.datasets[0].id, 'HUB');
});

test('when the peer lacks the data feature (ineligible), uses the hub fallback', async () => {
  const c = new FabricPeerClient('self', hubStub(), { settings: () => ({ dataSyncViaFabric: true }), eligible: () => false, request: async () => { throw new Error('must not be called'); } });
  const rows = await c.exportFrom('gw-b', 'd');
  assert.equal(rows[0].id, 'hub');
});

test('a fabric error falls back to the hub path for that call', async () => {
  const c = new FabricPeerClient('self', hubStub(), { settings: () => ({ dataSyncViaFabric: true }), eligible: () => true, request: async () => { throw new Error('link dropped'); } });
  const rows = await c.exportFrom('gw-b', 'd');
  assert.equal(rows[0].id, 'hub'); // fell back
});

test('listPeers always uses the hub roster', async () => {
  const c = new FabricPeerClient('self', hubStub(), { settings: () => ({ dataSyncViaFabric: true }), eligible: () => true, request: async () => ({ status: 200, data: {} }) });
  assert.deepEqual((await c.listPeers()).map((p) => p.node), ['gw-b']);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/data/fabric-peer-client.ts
// PeerClient that carries data-service sync over the W2 fabric (spec §5 S2.2) with a HubPeerClient
// fallback for legacy/ineligible peers. Fabric eligibility = dataSyncViaFabric on AND a fabric link
// to the peer exists AND the peer advertised the 'data' HELLO feature (Task 10). The sync RPCs land
// on the peer as a read-only PEER principal (Tasks 2/3) — no minted access key, no 1MB body cap
// (fabric chunks; >8MB responses ride a bulk handle transparently via fabricRequest).
import { HubPeerClient } from './peer-client';
import type { PeerClient, NodeInfo, ManifestEntry, DataRecord } from './types';

interface FabricPeerDeps {
  eligible?: (node: string) => boolean;
  request?: (node: string, init: { method: string; path: string; body?: unknown }) => Promise<{ status: number; data?: unknown }>;
  settings?: () => { dataSyncViaFabric: boolean };
}

/** Unwrap the Core route envelope `{ success, data, meta }` (also tolerates a raw payload). */
function unwrap(data: unknown): any {
  if (data && typeof data === 'object' && 'success' in (data as any) && 'data' in (data as any)) return (data as any).data;
  return data;
}

export class FabricPeerClient implements PeerClient {
  private eligible: (node: string) => boolean;
  private request: (node: string, init: { method: string; path: string; body?: unknown }) => Promise<{ status: number; data?: unknown }>;
  private settings: () => { dataSyncViaFabric: boolean };

  constructor(private nodeId: string, private hub: HubPeerClient = new HubPeerClient(nodeId), deps?: FabricPeerDeps) {
    this.settings = deps?.settings ?? (() => {
      const { getProjectSettings } = require('../project-settings') as typeof import('../project-settings');
      return { dataSyncViaFabric: getProjectSettings().dataSyncViaFabric };
    });
    this.eligible = deps?.eligible ?? ((node) => {
      const { fabricDataPeer } = require('../fabric') as typeof import('../fabric');
      return fabricDataPeer(node);
    });
    this.request = deps?.request ?? (async (node, init) => {
      const { fabricDataRequest } = require('../fabric') as typeof import('../fabric');
      return fabricDataRequest(node, init);
    });
  }

  /** The hub roster is the only source of the online-peer list (no fabric equivalent). */
  listPeers(): Promise<NodeInfo[]> { return this.hub.listPeers(); }

  private useFabric(node: string): boolean {
    return this.settings().dataSyncViaFabric && this.eligible(node);
  }

  async manifest(node: string): Promise<{ node: string; datasets: ManifestEntry[] }> {
    if (this.useFabric(node)) {
      try {
        const res = await this.request(node, { method: 'GET', path: '/data/sync/manifest' });
        const raw = unwrap(res.data);
        return { node: raw?.node ?? node, datasets: Array.isArray(raw?.datasets) ? raw.datasets : [] };
      } catch { /* fall through to hub */ }
    }
    return this.hub.manifest(node);
  }

  async exportFrom(node: string, dataset: string, since?: string): Promise<DataRecord[]> {
    if (this.useFabric(node)) {
      try {
        const res = await this.request(node, { method: 'POST', path: `/data/${dataset}/export`, body: since ? { since } : {} });
        const raw = unwrap(res.data);
        return Array.isArray(raw) ? raw : (raw?.records ?? []);
      } catch { /* fall through to hub */ }
    }
    return this.hub.exportFrom(node, dataset, since);
  }

  async getFrom(node: string, dataset: string, id: string): Promise<DataRecord | null> {
    if (this.useFabric(node)) {
      try {
        const res = await this.request(node, { method: 'POST', path: `/data/${dataset}/fetch`, body: { id } });
        const raw = unwrap(res.data);
        return raw ?? null;
      } catch { /* fall through to hub */ }
    }
    return this.hub.getFrom(node, dataset, id);
  }
}
```
(Dataset ids are URL-safe by construction — `DATASET_ID_RE` = `[a-z0-9][a-z0-9_-]{0,63}` — so the path needs no `encodeURIComponent`, and `[^/]+` in the allow-list/route matches it directly.)

- [ ] **Step 4: Swap the production client** in `core/src/data/data-service.ts`: change the import `import { HubPeerClient } from './peer-client';` to `import { FabricPeerClient } from './fabric-peer-client';`, and in `getDataService()` change `const peers = new HubPeerClient(nodeId);` to `const peers = new FabricPeerClient(nodeId);`.

- [ ] **Step 5: Run test to verify it passes** (5 tests). Then `cd /home/ubuntu/lm-assist && ./core.sh build` (Task 8 provides `fabricDataPeer`/`fabricDataRequest`; if building this task standalone before Task 8, the production defaults `require('../fabric')` still type-check as `any` via the lazy require — the injected-deps tests pass regardless).

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/data/fabric-peer-client.ts core/src/data/data-service.ts core/src/__tests__/data/fabric-peer-client.test.ts && git commit -m "feat(data): FabricPeerClient — sync over fabric (managed) with hub fallback for legacy peers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Fabric data helpers — `fabricDataPeer` + `fabricDataRequest`

**Files:**
- Modify: `core/src/fabric/index.ts` (two exported helpers, mirroring `fabricBusPeers`/`fabricBusCatchup`)
- Test: `core/src/__tests__/data/fabric-data-helpers.test.ts`

**Interfaces:**
- Consumes: the fabric internals `fabricLinks`, `peerLinks` (module state); `fabricRequestManaged` (from `./retry`).
- Produces:
  - `fabricDataPeer(node: string): boolean` — true iff a `FabricLink` to `node` exists AND its `PeerLink.peerHasFeature('data')`.
  - `fabricDataRequest(node: string, init: { method: string; path: string; body?: unknown; query?: Record<string,string> }): Promise<FabricResponse>` — `fabricRequestManaged({ node }, init)` (retry/escalation; NOT bare `fabricRequest`).

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/data/fabric-data-helpers.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fabric from '../../fabric';

test('fabricDataPeer is false when no fabric link exists', () => {
  assert.equal(fabric.fabricDataPeer('nobody'), false);
});

test('fabricDataRequest is exported and callable (rejects with no link)', async () => {
  assert.equal(typeof (fabric as Record<string, unknown>).fabricDataRequest, 'function');
  await assert.rejects(() => fabric.fabricDataRequest('nobody', { method: 'GET', path: '/data/sync/manifest' }));
});
```

- [ ] **Step 2: Run test to verify it fails** (`fabricDataPeer`/`fabricDataRequest` not exported).

- [ ] **Step 3: Implement** — in `core/src/fabric/index.ts`, add after the existing `fabricBusCatchup` export (near line 389):
```ts
/** True iff we have a fabric link to `node` AND it advertised the `data` HELLO feature (Task 10).
 *  Mirrors fabricBusPeers()'s peerHasFeature('bus') gate — a mixed-version peer without the data
 *  feature is simply ineligible and the caller (FabricPeerClient) falls back to the hub path. */
export function fabricDataPeer(node: string): boolean {
  const link = peerLinks.get(node);
  return !!(fabricLinks.has(node) && link?.peerHasFeature('data'));
}

/** Reliable data-service sync RPC over the fabric (spec §5 S2.2: fabricRequestManaged, NOT bare
 *  fabricRequest). The RPC lands on the peer's route table as a read-only peer principal. */
export async function fabricDataRequest(
  node: string,
  init: { method: string; path: string; body?: unknown; query?: Record<string, string> },
): Promise<FabricResponse> {
  const { fabricRequestManaged } = require('./retry') as typeof import('./retry');
  return fabricRequestManaged({ node }, init);
}
```

- [ ] **Step 4: Run test to verify it passes** (2 tests). Then `cd /home/ubuntu/lm-assist && ./core.sh build`.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/index.ts core/src/__tests__/data/fabric-data-helpers.test.ts && git commit -m "feat(fabric): fabricDataPeer + fabricDataRequest (managed data sync RPC, data-feature gated)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: `/data/*` fabric rpc-server allow-list (security-critical)

**Files:**
- Modify: `core/src/fabric/rpc-server.ts` (add `dataSyncEnabled` dep + a URL-normalized EXACT-shape `/data` allow-list, generalizing the W3 `/bus` entry)
- Modify: `core/src/fabric/index.ts` (`attachFabricLink` → `createRpcServer({ …, dataSyncEnabled: () => settings().dataSyncViaFabric })`)
- Test: `core/src/__tests__/data/rpc-allowlist.test.ts`

**Interfaces:**
- Consumes: `RpcServerDeps`, `Envelope`, `encodeBody`.
- Produces: `RpcServerDeps.dataSyncEnabled?: () => boolean`. The allow-list dispatches a peer `req` even when `fabricRpcEnabled` is false iff the URL-normalized `routedPath` matches EXACTLY `GET|POST /data/sync/manifest`, `/data/:ds/export`, or `/data/:ds/fetch` AND `dataSyncEnabled()` is true. A bare `/data/` prefix, a write/create/sql route, or a `..`-traversal that normalizes out of `/data/sync|export|fetch` is REJECTED (503). The dispatched path is the same `routedPath` the allow-list validated.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/data/rpc-allowlist.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRpcServer } from '../../fabric/rpc-server';
import { IdempotencyCache } from '../../fabric/idempotency';
import { encodeBody, decodeBody, type Envelope } from '../../fabric/envelope';

async function ask(path: string, method = 'GET', opts: { rpc?: boolean; data?: boolean } = {}) {
  const dispatched: string[] = [];
  const server = createRpcServer({
    dispatch: async (r) => { dispatched.push(r.path); return { status: 200, data: { ok: true } }; },
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => opts.rpc ?? false,
    busEnabled: () => false,
    dataSyncEnabled: () => opts.data ?? false,
    peerNodeOf: () => 'gw-b',
  });
  const env: Envelope = { kind: 'req', id: 'x', headers: { method, path }, payload: encodeBody({}) };
  const res: Envelope = await new Promise((resolve) => server(env, resolve));
  return { status: (res.headers as any).status, code: (res.headers as any).code, dispatched };
}

test('sync routes dispatch under dataSyncEnabled even when fabricRpcEnabled is false', async () => {
  for (const [p, m] of [['/data/sync/manifest', 'GET'], ['/data/missions/export', 'POST'], ['/data/missions/fetch', 'POST']] as const) {
    const r = await ask(p, m, { data: true });
    assert.deepEqual(r.dispatched, [p], `${p} should dispatch`);
    assert.equal(r.status, 200);
  }
});

test('sync routes are REFUSED when dataSyncEnabled is false', async () => {
  const r = await ask('/data/sync/manifest', 'GET', { data: false });
  assert.equal(r.status, 503);
  assert.deepEqual(r.dispatched, []);
});

test('non-sync /data routes are REFUSED even with dataSyncEnabled (no bare prefix)', async () => {
  for (const p of ['/data/missions/records', '/data/datasets', '/data/missions/sql', '/data/missions/admin', '/data/sync']) {
    const r = await ask(p, 'POST', { data: true });
    assert.equal(r.status, 503, `${p} must be refused`);
  }
});

test('a traversal that normalizes out of the sync shape is REFUSED', async () => {
  const r = await ask('/data/../hub/config', 'GET', { data: true, rpc: false });
  assert.equal(r.status, 503);
  assert.deepEqual(r.dispatched, []);
});

test('general RPC (fabricRpcEnabled) still dispatches anything', async () => {
  const r = await ask('/data/missions/records', 'PUT', { rpc: true });
  assert.equal(r.status, 200);
});
```

- [ ] **Step 2: Run test to verify it fails** (`dataSyncEnabled` unknown; sync routes refused). Expected: FAIL.

- [ ] **Step 3: Add the dep + allow-list** in `core/src/fabric/rpc-server.ts`. Add to `RpcServerDeps` (after the `busEnabled?` field):
```ts
  /** When true, the EXACT data-sync routes (manifest/export/fetch) dispatch even if rpcEnabled()
   *  is false (spec §5 S2 — gated by dataSyncViaFabric, not the general RPC class). W4's analogue
   *  of the busEnabled allow-list; same URL-normalized routedPath guard. */
  dataSyncEnabled?: () => boolean;
```
Add a module-scope constant (after `const DEFAULT_OFFLOAD = …`):
```ts
// EXACT shape of the only /data routes a peer may reach for sync — NEVER a bare `/data/` prefix
// (the W3 CRITICAL lesson: a raw prefix let `/bus/../hub/config` normalize past a naive startsWith).
// Matched against the URL-normalized `routedPath`, so a `..`/`%2e%2e` segment has already collapsed.
const DATA_SYNC_ROUTES = /^\/data\/(?:sync\/manifest|[^/]+\/(?:export|fetch))$/;
```
Replace the `const allowed = …` line:
```ts
      const allowed =
        deps.rpcEnabled()
        || (/^\/bus\/[^/]+\/since$/.test(routedPath) && (deps.busEnabled?.() ?? false))
        || (DATA_SYNC_ROUTES.test(routedPath) && (deps.dataSyncEnabled?.() ?? false));
```

- [ ] **Step 4: Wire the dep in production** — in `core/src/fabric/index.ts`, in `attachFabricLink`'s `createRpcServer({…})` call, add after the `busEnabled: () => settings().busEnabled,` line:
```ts
    dataSyncEnabled: () => settings().dataSyncViaFabric,
```

- [ ] **Step 5: Run test to verify it passes** (5 tests). Then `cd /home/ubuntu/lm-assist && ./core.sh build`.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/rpc-server.ts core/src/fabric/index.ts core/src/__tests__/data/rpc-allowlist.test.ts && git commit -m "feat(fabric): /data/* sync allow-list under dataSyncViaFabric (URL-normalized EXACT shape; no bare prefix)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: HELLO feature gating — `bus` on busEnabled, `data` on dataSyncViaFabric

**Files:**
- Modify: `core/src/fabric/peer-link.ts` (add `features?: () => string[]` dep; `hello()` uses it)
- Modify: `core/src/fabric/index.ts` (`makeLink` passes `features` computed from settings)
- Test: `core/src/__tests__/data/hello-features.test.ts`

**Interfaces:**
- Consumes: `PeerLinkDeps`.
- Produces: `PeerLinkDeps.features?: () => string[]` — read live at hello-build time; default `['status','rpc','comp-gzip','bus']` (unchanged behaviour when omitted, so existing peer-link tests stay green). Production computes: always `['status','rpc','comp-gzip']`, plus `'bus'` iff `busEnabled`, plus `'data'` iff `dataSyncViaFabric`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/data/hello-features.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PeerLink } from '../../fabric/peer-link';
import { parseFabricControl } from '../../fabric/protocol';

// Capture the HELLO the PeerLink emits on open() by driving a fake channel.
function helloFeaturesFrom(features: () => string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const ch = {
      mode: 'relay' as const, via: null, rtt: null,
      sendControl: (b: Buffer) => {
        // First control frame is our hello. Parse the framed control payload.
        const { FrameReader } = require('../../file-transfer/frame');
        const fr = new FrameReader();
        for (const f of fr.push(b)) if (f.kind === 'control') {
          const msg = parseFabricControl(f.msg);
          if (msg?.kind === 'hello') resolve(msg.features ?? []);
        }
        chunks.push(b);
      },
      onData: () => {}, onClose: () => {}, close: () => {},
    };
    const link = new PeerLink('gw-b', {
      openChannel: async () => ch as any, selfNode: 'self', now: () => Date.now(), helloTimeoutMs: 1, features,
    });
    void link.open();
  });
}

test('features dep gates bus/data in the HELLO advert', async () => {
  assert.deepEqual((await helloFeaturesFrom(() => ['status', 'rpc', 'comp-gzip', 'data'])), ['status', 'rpc', 'comp-gzip', 'data']);
  assert.deepEqual((await helloFeaturesFrom(() => ['status', 'rpc', 'comp-gzip'])), ['status', 'rpc', 'comp-gzip']);
});
```

- [ ] **Step 2: Run test to verify it fails** (`features` dep ignored → always the static list). Expected: FAIL.

- [ ] **Step 3: Add the `features` dep** in `core/src/fabric/peer-link.ts`. In `PeerLinkDeps` (after `selfTcp?`):
```ts
  /** Capability list advertised in the HELLO, read live at hello-build time so a mid-session
   *  busEnabled/dataSyncViaFabric flip is reflected on the next (re)connect. Defaults to the W1/W2/W3
   *  static set when omitted (keeps existing peer-link unit tests unchanged). */
  features?: () => string[];
```
In `hello()`, replace the `features: ['status', 'rpc', 'comp-gzip', 'bus']` literal:
```ts
  private hello(kind: FabricHello['kind']): Buffer {
    const tcp = this.deps.selfTcp?.() ?? undefined;
    const features = this.deps.features?.() ?? ['status', 'rpc', 'comp-gzip', 'bus'];
    return encodeFabricControl({ type: FABRIC_TAG, kind, version: FABRIC_VERSION, features, node: this.deps.selfNode, ...(tcp ? { tcp } : {}) });
  }
```

- [ ] **Step 4: Compute features from settings in production** — in `core/src/fabric/index.ts`, in `initFabric`'s `makeLink`, add `features` to the `new PeerLink(peer, {…})` deps (after `selfTcp: () => selfTcpEndpoint,`):
```ts
        features: () => {
          const { getProjectSettings } = require('../project-settings') as typeof import('../project-settings');
          const s = getProjectSettings();
          const f = ['status', 'rpc', 'comp-gzip'];
          if (s.busEnabled) f.push('bus');            // follow-up (c): advertise bus only when enabled
          if (s.dataSyncViaFabric) f.push('data');    // spec §5 S2.2: peer must advertise data to be fabric-eligible
          return f;
        },
```

- [ ] **Step 5: Run test to verify it passes** (1 test, 2 asserts). Then `cd /home/ubuntu/lm-assist && ./core.sh build`.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/peer-link.ts core/src/fabric/index.ts core/src/__tests__/data/hello-features.test.ts && git commit -m "feat(fabric): gate bus HELLO feature on busEnabled + advertise data feature on dataSyncViaFabric (follow-up c)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Wire the runtime — sync-boot, SyncQueue retirement, CAS surfaces

**Files:**
- Modify: `core/src/data/sync-boot.ts` (start `SyncListener`; drop the flush timer, the `dataset_updated` handler, and `flushNow`; keep reconcile + initial reconcile)
- Modify: `core/src/cluster/cluster-store.ts` (`forceFlush()` → no-op; the DataService write now self-publishes change-notify)
- Delete: `core/src/data/sync-queue.ts`
- Modify: `core/src/routes/core/data.routes.ts` (`PUT /data/:ds/records` reads `body.ifVersion` → `put` opts)
- Modify: `core/src/mcp-server/tools/data-tools.ts` (`data_put` accepts optional `ifVersion`)
- Test: `core/src/__tests__/data/sync-boot-wiring.test.ts`

**Interfaces:**
- Consumes: `SyncListener` (Task 6), `getBus` (W3), `getSyncEngine` (existing), `DataService.put` opts (Task 4).
- Produces: `startDataSync()` attaches a `SyncListener` (bus → debounced pull) + keeps the reconcile safety net; `flushNow`/`SyncQueue` removed; `PUT /data/:ds/records` and `data_put` forward `ifVersion`.

- [ ] **Step 1: Write the failing test** (proves the dead `dataset_updated`/`flushNow`/`SyncQueue` surface is gone and the boot module still loads):

```ts
// core/src/__tests__/data/sync-boot-wiring.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';

test('SyncQueue file is retired', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '../../data/sync-queue.js')), false);
});

test('sync-boot no longer references the dead dataset_updated push or flushNow', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../src/data/sync-boot.ts'), 'utf8');
  assert.equal(/dataset_updated|flushNow|getSyncQueue|sendDatasetUpdated/.test(src), false);
  assert.equal(/SyncListener/.test(src), true);
});

test('sync-boot exports start/stop and loads without throwing', async () => {
  const mod = await import('../../data/sync-boot');
  assert.equal(typeof mod.startDataSync, 'function');
  assert.equal(typeof mod.stopDataSync, 'function');
});
```

- [ ] **Step 2: Run test to verify it fails** (`sync-queue.js` still present; `flushNow` still referenced).

- [ ] **Step 3: Rewrite `core/src/data/sync-boot.ts`**:
```ts
// core/src/data/sync-boot.ts
// Boot wiring for cross-node data sync (W4 §5 S2). Reactive convergence now rides the W3 bus:
// DataService.put/del publish data:<dataset> change-notify; a SyncListener debounces that into
// SyncEngine.pullDataset. The old dataset_updated→hub push + unbounded SyncQueue are retired; the
// 300s reconcile stays as the safety net (and covers cross-cluster, where bus fan-out doesn't reach).
import { getProjectSettings } from '../project-settings';
import { getSyncEngine } from './data-service';
import { SyncListener } from './sync-listener';
import { getBus } from '../bus';
import { thisNodeId } from './paths';
import { publishSelf } from '../cluster/cluster-store';

let _started = false;
let _listener: SyncListener | null = null;
let _reconcileTimer: NodeJS.Timeout | null = null;
let _initTimer: NodeJS.Timeout | null = null;

export function startDataSync(): void {
  if (_started) return;
  const s = getProjectSettings();
  if (!s.dataServiceEnabled) return; // dormant unless enabled
  _started = true;

  const reconcileMs = Math.max(1, s.dataReconcileSec ?? 300) * 1000;

  // Reactive: bus data:<dataset> change-notify → debounced pull (idempotent; own-origin skipped).
  // onLocalEvent fires for local publishes AND cross-node ingests (incl. catch-up first-sight), so a
  // peer's write converges in ~1-2s. Attaching even when busEnabled=false is harmless (no events fire).
  _listener = new SyncListener({
    selfNode: () => thisNodeId(),
    pull: (dataset, fromNode) => getSyncEngine().pullDataset(fromNode, dataset),
    onLocalEvent: (cb) => getBus().onLocalEvent(cb),
  });
  _listener.start();

  // Periodic reconcile (self-heal / cross-cluster / missed pulls) + republish self cluster membership.
  _reconcileTimer = setInterval(() => {
    getSyncEngine().reconcile().catch(() => {});
    publishSelf().catch(() => {});
  }, reconcileMs);
  if (_reconcileTimer.unref) _reconcileTimer.unref();

  // Initial reconcile shortly after boot so a fresh node converges quickly.
  _initTimer = setTimeout(() => {
    getSyncEngine().reconcile().catch(() => {});
    publishSelf().catch(() => {});
  }, 2000);
  if (_initTimer.unref) _initTimer.unref();
}

export function stopDataSync(): void {
  _listener?.stop();
  _listener = null;
  if (_reconcileTimer) clearInterval(_reconcileTimer);
  if (_initTimer) clearTimeout(_initTimer);
  _reconcileTimer = _initTimer = null;
  _started = false;
}
```

- [ ] **Step 4: Neutralize the retired `flushNow` caller** in `core/src/cluster/cluster-store.ts`. Replace the `forceFlush` function body:
```ts
/** Historically flushed the dirty-record queue so a cluster change converged fast. W4 retired the
 *  SyncQueue + the (already-dead) dataset_updated push: the DataService.put that writes node-clusters
 *  now self-publishes a data:node-clusters change-notify onto the bus (within-cluster convergence),
 *  and the 300s reconcile covers cross-cluster. So this is a no-op kept only for call-site stability. */
async function forceFlush(): Promise<void> {
  /* no-op — change-notify + reconcile replace the retired flushNow */
}
```

- [ ] **Step 5: Delete the retired queue** and forward `ifVersion` on both write surfaces:

Delete the file:
```bash
cd /home/ubuntu/lm-assist && git rm core/src/data/sync-queue.ts
```
In `core/src/routes/core/data.routes.ts`, the `PUT /data/:dataset/records` handler — pass `ifVersion` from the body:
```ts
        const rec = recordFromBody(req.body);
        if (!rec.id) return wrapError('BAD_REQUEST', 'record id is required', start);
        const ifVersion = typeof (req.body as any)?.ifVersion === 'number' ? (req.body as any).ifVersion : undefined;
        const r = await svc().put(ctxOf(req), req.params.dataset, rec, ifVersion !== undefined ? { ifVersion } : undefined);
```
In `core/src/mcp-server/tools/data-tools.ts`, add `ifVersion` to the `data_put` input schema:
```ts
    inputSchema: { type: 'object' as const, properties: { dataset: STR('Dataset id.'), record: { type: 'object' as const, description: 'Record: { id, fields, text?, metadata? }.' }, ifVersion: { type: 'number' as const, description: 'Optimistic-concurrency guard: write only if the stored version equals this (absent record ⇒ 0); else CONFLICT.' }, key: STR('Access key granting write (omit if local).') }, required: ['dataset', 'record'] },
```
and in `handleDataPut`, thread it into the call:
```ts
  const ifVersion = typeof args.ifVersion === 'number' ? (args.ifVersion as number) : undefined;
  const r = await svc.put(ctx, dataset, record, ifVersion !== undefined ? { ifVersion } : undefined);
```
(`data_put` is already `TOOL_SCOPES: data_put: 'write'` — no new scope entry needed.)

- [ ] **Step 6: Run tests + build.** Run the wiring test (3 tests) and re-run Tasks 4–7 tests to confirm no regression, then `cd /home/ubuntu/lm-assist && ./core.sh build`.

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/data/sync-boot.ts core/src/cluster/cluster-store.ts core/src/routes/core/data.routes.ts core/src/mcp-server/tools/data-tools.ts core/src/__tests__/data/sync-boot-wiring.test.ts && git commit -m "feat(data): wire SyncListener in boot; retire SyncQueue/flushNow/dataset_updated; expose CAS ifVersion on route + data_put

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: In-process two-node convergence e2e (+ live-fleet procedure)

**Files:**
- Test: `core/src/__tests__/data/two-node-convergence.test.ts`

**Interfaces:**
- Consumes: everything above — `DataService` (change-notify), `Bus` (fan-out via injected bridge), `SyncListener`, `SyncEngine`, `FabricPeerClient` (with injected fabric deps), CAS.
- Produces: a deterministic, port-free proof that a write on node A converges on node B in ~1s through the change-notify → bus → debounced-pull path (with `missions` — already a `full`/`cross-node-readable` dataset — as the named consumer), plus a legacy-fallback assertion and a CAS-conflict assertion. Then a documented live-fleet e2e procedure (the deploy-time proof).

- [ ] **Step 1: Write the two-node convergence test** — wire two full data stacks (A, B) with two Bus instances bridged synchronously (A.publish fanout → B.ingest), B's SyncListener pulling from A via a `FabricPeerClient` whose `request` is a direct in-process call into A's export route logic. This mirrors the W3 injected-fanout idiom (no live fabric/ports).

```ts
// core/src/__tests__/data/two-node-convergence.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataService } from '../../data/data-service';
import { SyncEngine } from '../../data/sync-engine';
import { SyncListener } from '../../data/sync-listener';
import { DatasetRegistry } from '../../data/dataset-registry';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { AccessManager } from '../../data/access-manager';
import { getKeyStore } from '../../data/key-store';
import { Bus } from '../../bus/bus';
import { BusStore } from '../../bus/bus-store';
import type { PeerClient, NodeInfo, ManifestEntry, DataRecord, Principal } from '../../data/types';
import type { BusEvent } from '../../bus/types';

function node(id: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `n-${id}-`));
  const datasets = new DatasetRegistry(path.join(dir, 'datasets.json'));
  const backends = new BackendRegistry();
  backends.register(new CacheBackend());
  const manager = new AccessManager({ datasets, keys: getKeyStore(), nodeId: id });
  const bus = new Bus({ store: new BusStore(dir), selfNode: id, enabled: () => true });
  const svc = new DataService({ datasets, backends, manager, notify: (ds, type, ids) => bus.publish(`data:${ds}`, type, { ids }) });
  // 'missions' is a full, cross-node-readable dataset (exactly as mission-store.ts registers it).
  datasets.create({ id: 'missions', backend: 'cache', visibility: 'cross-node-readable', syncMode: 'full', config: { kind: 'cache' } });
  return { id, datasets, backends, manager, bus, svc, dir };
}
const local: Principal = { type: 'local' };
const ctx = { principal: local };
const rec = (id: string, f: Record<string, unknown> = {}): DataRecord => ({ id, version: 0, fields: f, createdAt: '', updatedAt: '' });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('write on A converges on B in ~1s via change-notify → bus → debounced pull (missions)', async () => {
  const A = node('gw-a');
  const B = node('gw-b');
  // Bridge A's fan-out into B's bus (the fabric pub path, in-process + synchronous).
  A.bus.onLocalEvent((e: BusEvent) => { if (e.origin === 'gw-a') B.bus.ingest(e); });
  // B pulls from A directly (the fabric export path, in-process): a PeerClient backed by A's service.
  const peers: PeerClient = {
    listPeers: async (): Promise<NodeInfo[]> => [{ node: 'gw-a', hostname: 'a', platform: 'linux' }],
    manifest: async (): Promise<{ node: string; datasets: ManifestEntry[] }> => ({ node: 'gw-a', datasets: A.svc.syncManifest({ type: 'peer', node: 'gw-b' }) as ManifestEntry[] }),
    exportFrom: async (_n, ds, since): Promise<DataRecord[]> => {
      const r = await A.svc.exportDataset({ principal: { type: 'peer', node: 'gw-b' } }, ds, since);
      return r.ok ? r.value : [];
    },
    getFrom: async () => null,
  };
  const engineB = new SyncEngine({ datasets: B.datasets, backends: B.backends, peers, nodeId: 'gw-b' });
  const listenerB = new SyncListener({ selfNode: () => 'gw-b', pull: (ds, from) => engineB.pullDataset(from, ds), onLocalEvent: (cb) => B.bus.onLocalEvent(cb), debounceMs: 20 });
  listenerB.start();

  // Act: A writes a mission.
  await A.svc.put(ctx, 'missions', rec('m-1', { title: 'ship W4' }));

  // Assert: B has it within ~1s (debounce 20ms + a couple of ticks).
  await wait(200);
  const got = await B.svc.get(ctx, 'missions', 'm-1');
  assert.equal(got.ok, true);
  assert.equal((got as { value: DataRecord | null }).value?.fields.title, 'ship W4');
  listenerB.stop();
});

test('legacy fallback: a peer principal cannot read a local-only dataset (denied), proving scope', async () => {
  const A = node('gw-a');
  A.datasets.create({ id: 'secrets', backend: 'cache', visibility: 'local-only', syncMode: 'none', config: { kind: 'cache' } });
  await A.svc.put(ctx, 'secrets', rec('s1'));
  const asPeer = { principal: { type: 'peer' as const, node: 'gw-b' } };
  const r = await A.svc.exportDataset(asPeer, 'secrets');
  assert.equal(r.ok, false); // peer cannot export a local-only dataset
});

test('CAS conflict surfaces on a stale ifVersion', async () => {
  const A = node('gw-a');
  await A.svc.put(ctx, 'missions', rec('m-2'));            // version → 1
  const stale = await A.svc.put(ctx, 'missions', rec('m-2'), { ifVersion: 0 });
  assert.equal(stale.ok, false);
  assert.equal((stale as { code: string }).code, 'CONFLICT');
});
```

- [ ] **Step 2: Run test to verify it passes** (3 tests). Then `cd /home/ubuntu/lm-assist && ./core.sh build && cd core && npm run build:test && ~/.nvm/versions/node/v20.19.6/bin/node --test --test-reporter=spec dist-test/__tests__/data/` (run the whole `data` suite — all Task 1–12 tests green).

- [ ] **Step 3: Document + run the live-fleet e2e** (the deploy-time proof; record results in the commit body). On the real LAN fleet with dev Cores on two nodes (e.g. 123 + 107), `dataServiceEnabled=true`:
  1. Set `dataSyncViaFabric=true` on BOTH via `PUT /project-settings` (now allowlisted — Task 1); confirm each `GET /fabric/status` shows the peer link up and (after a reconnect) the HELLO carries `data`.
  2. On node A: `PUT /data/missions/records { id:"e2e-<ts>", fields:{...} }` (or create a mission). Within ~1-2s, `GET /data/missions/records/e2e-<ts>` on node B returns it. Confirm `data:missions` appears in `bus_topics` on both.
  3. Mixed-version: set `dataSyncViaFabric=false` on node B only → B advertises no `data` feature → A's pull of B falls back to the hub path; convergence still works (slower, via reconcile/hub). Re-enable.
  4. CAS: two writers `PUT` the same `missions` id with a stale `ifVersion` → one gets `CONFLICT`.
  5. Kill-switch: set `dataSyncViaFabric=false` fleet-wide → `GET /fabric/status` shows no `data` feature, `/data/*` fabric RPCs return 503 (allow-list closed), sync silently reverts to the hub path (zero errors). Prod (`:3100`/117) stays UNTOUCHED (dev ports only).

- [ ] **Step 4: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/__tests__/data/two-node-convergence.test.ts && git commit -m "test(data): in-process two-node convergence e2e (missions) + legacy-scope + CAS; live-fleet procedure documented

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

### 1. Spec coverage (§5 S2 + S3 + W4 row of §6)

| Spec item | Task(s) |
|---|---|
| S2.1 change-notify → bus; peer sync listeners run debounced pull; retire dead dirty-flush→hub + unbounded SyncQueue; 300s reconcile stays | Tasks 5 (change-notify), 6 (SyncListener debounce), 11 (retire SyncQueue/flushNow/dataset_updated; keep reconcile) |
| S2.2 sync manifest/export/fetch via `fabric.request({node})` — retry, compression, no 1MB cap (>8MB → bulk); legacy peers keep hub + key-in-body via fallback | Tasks 7 (FabricPeerClient fabric+fallback), 8 (fabricDataRequest = fabricRequestManaged), 10 (data feature gate for mixed-version) |
| S2.3 peer principal replaces minted sync keys; authorize against `synced`/`cross-node-readable`; access keys remain for cloud/connector | Tasks 2 (resolve), 3 (authorize) |
| S2.4 CAS `put(record,{ifVersion})` → CONFLICT; LWW stays the sync merge rule | Task 4 (+ surfaces in Task 11) |
| S2.5 hygiene: bound the debounce buffer; replica GC + LanceDB compaction flagged (not built) | Task 6 (bounded `maxPending`); GC/compaction listed under Deferred below |
| S3 first consumers: `missions` converges fleet-wide (+ `mission-workflows` to follow) | Tasks 5/11 wire it at the DataService layer (missions is already `full`/`cross-node-readable`); Task 12 proves it |
| §6 W4 row: change-notify→bus, sync-over-fabric, peer-principal ACL, CAS, retire dirty-flush; e2e (mission on non-leader visible ~1s; CAS conflict; mixed-version fleet syncs); kill-switch `dataSyncViaFabric` | All tasks; Task 12 e2e; Task 1 kill-switch |
| W3 review follow-ups (a)/(b)/(c) | (a) DEFERRED w/ justification (Global Constraints + Task 5 note); (b) Task 1; (c) Task 10 |

**S3 decision — WIRE `missions` (not a demonstrator).** Rationale grounded in the code: `core/src/mission/mission-store.ts:86` registers `missions` via `getDataService().createDataset(...)` with `visibility:'cross-node-readable', syncMode:'full'`. Because change-notify is added at the **DataService.put/del layer** (Task 5), NOT per-dataset, missions (and `mission-views`, also `full`) get it with **zero mission-code changes** — the one-line hook is already there (every mission write goes through `DataService.put`). Task 12 proves `missions` specifically converges. `mission-workflows` follows automatically once its paused registry design resumes and registers its dataset as `full` — no further W4 work. Documented one-liner: nothing to add; a mission write already flows put → notifyChange → `data:missions` → SyncListener → pull.

### 2. Placeholder scan
No `TBD`/`TODO`/"implement later"/"add error handling"/"similar to Task N"/"write tests for the above" appears. Every implementation step carries complete code; every test step carries the full test body; every command is exact with an expected result. Deferred items (retention fix (a), replica GC, LanceDB compaction, cross-cluster bus fan-out) are explicitly named as out-of-scope, not left as in-code placeholders.

### 3. Type consistency
- `Principal` widened once (Task 2): `type: 'local'|'cloud'|'peer'`, `node?: string`; used consistently in `resolvePrincipal`/`evaluateGrants`/`enforce` (Tasks 2/3), the fabric export ctx (Task 12), and `data-service` (peer path). `PrincipalType` widening is safe for `AclRule.principal`/`AccessKey.principalType` (no dataset declares a `peer` rule; peers never mint keys).
- `PutOptions { ifVersion?: number }` defined once (Task 4), consumed identically by `DataService.put` (Task 4), the route (Task 11), and `data_put` (Task 11).
- `DataService` constructor dep renamed `onLocalWrite` → `notify(dataset, type, ids)` in Task 5; the only two production wire sites (`getDataService`, tests) are updated in the same task; no stale `onLocalWrite`/`getSyncQueue` references remain after Task 11 (guarded by the Task 11 regex test).
- `notify` signature (`(dataset: string, type: 'changed'|'deleted', ids: string[]) => void`) matches `notifyChange`'s call and the production bus wiring (`getBus().publish('data:'+dataset, type, {ids})`) — event `type` is the string `'changed'|'deleted'`, payload `{ids}`, consumed by `SyncListener` which reads `e.topic`/`e.origin` (not the payload) to pull. Consistent.
- `SyncEngine.pullDataset(node, datasetId)` arg order (existing) is honored at every call site: `SyncListener.pull(dataset, fromNode)` maps to `pullDataset(fromNode, dataset)` in sync-boot (Task 11) and Task 12. Verified against `sync-engine.ts:139`.
- `FabricPeerClient implements PeerClient` matches the interface (`listPeers/manifest/exportFrom/getFrom`) in `types.ts:130`. `fabricDataPeer`/`fabricDataRequest` (Task 8) match the shapes `FabricPeerClient` calls (Task 7) and `FabricResponse {status,data?}` (fabric/index.ts).
- rpc-server `dataSyncEnabled?: () => boolean` (Task 9) matches the production wire `() => settings().dataSyncViaFabric` (Task 9 Step 4) and the `busEnabled` sibling shape.
- `PeerLinkDeps.features?: () => string[]` (Task 10) matches the production computation and the test's injected `features` fn.

### 4. SECURITY sub-section — every path a peer could read/write, and how each is scoped + tested

**How the peer principal is scoped (two independent gates):**
- **Transport gate (rpc-server allow-list, Task 9):** the ONLY `/data/*` routes a peer `req` can dispatch (when `fabricRpcEnabled=false`, the fleet default) are `GET /data/sync/manifest`, `POST /data/:ds/export`, `POST /data/:ds/fetch`, matched against the URL-normalized `routedPath` with the EXACT-shape `DATA_SYNC_ROUTES` regex — never a bare `/data/` prefix. Everything else → 503 before `begin()`/dispatch.
- **Authorization gate (access-manager, Tasks 2/3):** a peer principal is minted ONLY from a loopback origin carrying `x-relay-source:'peer'` + `x-lm-peer-node` (only `loopbackDispatch` produces this). It is **read-only** (`read`/`query`/`search`), **shareable-only** (`synced`/`cross-node-readable`), **non-sensitive**, and the peer branch is evaluated BEFORE the key branch so a key can't widen it. No key is minted or consulted.

**How the `/data` allow-list is bounded:** `/^\/data\/(?:sync\/manifest|[^/]+\/(?:export|fetch))$/` over the URL-normalized `routedPath` (`..`/`%2e%2e` already collapsed), gated on `dataSyncEnabled()`; the dispatched path is the same validated `routedPath`.

**Enumerated read/write paths for a peer:**

| Path a peer could attempt | Reachable over fabric? | Authorization verdict | Test |
|---|---|---|---|
| `GET /data/sync/manifest` | Yes (allow-list) | `syncManifest(peer)` → only shareable, non-sensitive datasets listed | Task 3 (evaluateGrants), Task 12 (manifest as peer) |
| `POST /data/:ds/export` (shareable) | Yes | `enforce(peer,'read')` ok → redacted records | Tasks 3, 12 |
| `POST /data/:ds/export` (local-only) | Yes (transport) | `enforce(peer,'read')` → `PEER_NOT_SHAREABLE` deny | Tasks 3, 12 (secrets denied) |
| `POST /data/:ds/export` (sensitive) | Yes (transport) | `enforce(peer,'read')` → `SENSITIVE` deny | Task 3 |
| `POST /data/:ds/fetch` | Yes | same read scope as export (`getRecordRaw` authorizes `read`) | Task 3 |
| `PUT /data/:ds/records` (write) | **No** (allow-list 503) | AND `enforce(peer,'write')` → `PEER_READ_ONLY` | Tasks 9, 3 |
| `DELETE /data/:ds/records/:id` | **No** (allow-list 503) | AND `enforce(peer,'delete')` → `PEER_READ_ONLY` | Tasks 9, 3 |
| `POST /data/:ds/admin` (manage) | **No** (allow-list 503) | AND `enforce(peer,'manage')` → `PEER_READ_ONLY` | Tasks 9, 3 |
| `POST /data/datasets` (create), `DELETE …`, `/data/:ds/sql`, `/data/keys`, `/data/sync` | **No** (allow-list 503) | AND route/service is `local`-only (`p.type!=='local'` → FORBIDDEN) | Task 9 |
| `/data/../hub/config` or `/bus/../data/x/records` (traversal) | **No** — normalizes to `/hub/config` / `/data/x/records`, neither in `DATA_SYNC_ROUTES` → 503 | n/a | Task 9 |
| Forged `x-relay-source:'peer'` from a non-loopback origin | Reaches the server only with the api-token; principal resolves to **cloud** (needs a key), never peer/local | cloud ACL/key path | Task 2 |
| The sync-merge WRITE (`importBatch`) | Runs on the PULLING node as its own **local** principal into a read-only replica descriptor — never a peer-driven write; `put`/`del` refuse replicas (`READ_ONLY_REPLICA`) | existing replica guard | existing behaviour (unchanged) |

Every write path is closed at BOTH gates (allow-list AND peer-read-only), and every read path is scoped to shareable-non-sensitive and tested. The pre-W4 hole — a loopback peer RPC resolving to `local` root — is closed by Task 2 and asserted directly.

### Deferred (out of W4 scope — do NOT build here)
- W3 review follow-up (a): the `eventsToEvict` over-eviction fix — required before any future task schedules `BusStore.sweep()`; W4 schedules none.
- Replica GC for departed peers; LanceDB compaction (spec S2.5 — flagged, low priority).
- True cross-cluster bus fan-out (W3 deferral): fleet-scoped datasets converge cross-cluster via the 300s reconcile, unchanged; within-cluster rides the bus.
- Migrating `mission-workflows` and the other S3 later-wave consumers (session mailboxes, worker→`mission:<id>` reporting, supervisor-as-bus-consumer, leader-anchor retirement).
- Removing the now-unused `dataset_updated`/`sendDatasetUpdated` symbols from `hub-client` (dead but harmless; a later cleanup).

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-03-peer-fabric-w4-data.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
