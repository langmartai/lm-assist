# Generic Data Backends + Access-Key Control for lm-assist

**Date:** 2026-06-17
**Status:** Design proposal (brainstormed with user; no code changed yet)
**Topic:** A generic, multi-backend data service (vector / sql / cache) fronted by an access-key
manager, node-aware with cross-node sync, exposed over REST **and** MCP so an LLM can request scoped
access and use it. The existing knowledge/document system is preserved intact and exposed as a
reserved **system dataset**.

---

## 1. Goals / Non-goals

### Goals
1. **Three pluggable storage backends** behind one common contract:
   - **vector** — semantic retrieval (RAG), reusing the existing LanceDB + local embedder.
   - **sql** — structured records, queryable, backed by SQLite.
   - **cache** — compressed object store, backed by LMDB (the existing compressed-KV pattern).
2. **No "app" layer.** Data lives directly in the backends, addressed as named **datasets**.
3. **Access-key manager ("mgr")** — a caller states *what it wants to do on which data*; the mgr
   checks ACL/policy and mints a **scoped, expiring access key**; every data-plane call is enforced
   against that key. (User's phrasing: "ask and say what you want to do → get a role-based access
   key → use it within its privileges.")
4. **Two principal classes**, mapped onto auth paths lm-assist already distinguishes:
   - **local** authed user (local api-token, direct HTTP) → full access to all local data.
   - **cloud** authed user (hub `user_id`, via `mcp.langmart.ai → hub → worker` relay) → cross-node
     access, **gated per node**: data a node marks not-cross-node-visible is invisible to cloud users.
5. **Node-aware data + cross-node sync** as a first-class feature: a dataset is **local-only**,
   **synced** (replicated to other nodes), or **cross-node-readable** (readable by cloud users,
   possibly via relay without replication). This **generalizes the existing knowledge remote-sync**.
6. **Exposed on both surfaces** — REST endpoints and MCP tools — using the existing single MCP
   registry so a new tool appears on stdio + HTTP `/mcp` at once.
7. **Care for the existing implementation.** The knowledge store, its `/knowledge/*` routes, and the
   `search` / `detail` / `feedback` MCP tools keep working **byte-for-byte unchanged**. The knowledge
   and vector systems are exposed as reserved **system datasets** via *adapters* over their existing
   store classes — not a migration, and normal flows are never rerouted through them.
8. **Break-glass management of existing DB data.** The same generic interface lets an **LLM directly
   manage the existing databases (knowledge, vectors, …) from API/MCP when needed** — full
   read/write/delete plus store-specific admin ops — but this is an **out-of-band, gated** path. In
   normal operation the existing codebase manages its own data; the management interface is *never* a
   dependency of a normal flow, and every management write **delegates to the existing store methods**
   so invariants are preserved. (Human management UI is M6; this goal is the LLM/API/MCP path.)
9. **Sensitivity guard.** Secrets and credentials are **structurally unexposable**: a hard exclusion
   list (OAuth token, hub apiKey, claude.ai cookies, `.env`, the access-key store) can never be
   registered or tracked; an always-on **redaction** pass scrubs secret-looking fields from every
   returned record; and `sensitive` datasets are invisible to cloud principals and excluded from sync.
   (Structurally enforces the global "never expose LIVE tokens/credentials" rule.)

### Non-goals (YAGNI for v1)
- No per-dataset embedding-model configuration — vector datasets reuse the global 384-dim embedder.
- No arbitrary raw SQL for cloud/LLM callers — only a constrained, parameterized query API. (Raw SQL
  is a local-admin-only escape hatch.)
- No multi-writer / CRDT sync — synced datasets are **single-writer** (owned by their origin node);
  other nodes hold **read-only replicas** (exactly the knowledge model today).
- No per-record ACL — ACL is **per-dataset** in v1 (plus the per-record `origin` already present).
- No new public/unauthenticated surface — the new data plane sits **inside** existing auth.

---

## 2. Terminology

| Term | Meaning |
|---|---|
| **Backend** | A storage engine implementing the common `StorageBackend` contract. One of `vector`, `sql`, `cache`. |
| **Dataset** | A named, isolated collection of records bound to exactly one backend on one owner node. The unit ACL and sync flags attach to. (Replaces the rejected "app" concept.) |
| **Record** | A uniform envelope `{ id, fields, text?, metadata?, origin? }` stored in a dataset. |
| **Principal** | The authenticated caller, classified `local` or `cloud` by arrival path. |
| **Access key** | A minted, opaque, expiring secret carrying **grants**; required by the data plane. (Deliberately *not* called "capability" — that word names platform ports in `platform/capabilities.ts`.) |
| **Grant** | `{ dataset, actions[] }` — one slice of a key's authority. |
| **mgr / Access Manager** | The only component that mints keys; owns the ACL/policy and the key store + audit. |
| **Node** | An lm-assist worker (identified by `machineId`), connected to the hub. |

---

## 3. Existing implementation we build on (and must not break)

| Existing piece | Where | How we reuse it |
|---|---|---|
| LanceDB vector store, 384-dim local embedder (Xenova/all-MiniLM-L6-v2, worker thread), hybrid vector+FTS (RRF) | `core/src/vector/` (`getVectorStore()`, `VectorStore`, `embedder.ts`) | **vector backend** wraps the embedder + LanceDB connection; new vector datasets get their **own LanceDB tables** `ds_<id>` so the existing global `vectors` table is untouched. |
| LMDB compressed KV (msgpack + LZ4, multi-sub-DB) | `session-cache-store.ts`, `memory-cache-store.ts` | **cache backend** + the **key store** reuse this exact pattern. |
| Knowledge store (`K001.md` + `index.json` + `comments/` + `remote/`), dedup, LLM review | `core/src/knowledge/` (`getKnowledgeStore()`) | exposed **unchanged** as the reserved `knowledge` **system dataset** via a read-mostly adapter. |
| Node/sync infra: `origin: 'local'\|'remote'` + `machineId/hostname/os`, `remote/{machineId}/`, `POST /knowledge/remote-sync`, hub-client WS | `core/src/knowledge/`, `core/src/hub-client/` | the **generic cross-node sync engine** generalizes this; synced datasets land under `data/remote/{machineId}/`. |
| MCP single registry: `configureMcpServer(server, dispatch)`, `LM_ASSIST_TOOL_DEFS`, `EXPANDED_TOOL_DEFS`, `EXPANDED_HANDLERS`, `TOOL_SCOPES`; `node` param auto-injected; `list_nodes` | `core/src/mcp-server/` | new tools added via the **4-file pattern**; auto-appear on stdio + HTTP `/mcp`; node-targeting is free. |
| Route factories `create*Routes(ctx): RouteHandler[]`, registered in `routes/core/index.ts`; `wrapResponse`/`wrapError`; `ApiResponse<T>` | `core/src/routes/core/` | new `data.routes.ts` follows the same shape. |
| Auth boundaries: `lmAuthHeaders()` (local api-token), `api-relay-handler` allow-list (hub relay carries `user_id`) | `core/src/mcp-server/api-client.ts`, `core/src/hub-client/api-relay-handler.ts` | **principal classification** reads the arrival path; we extend the relay allow-list, we don't replace auth. |

**Native-dep note:** the repo already ships native NAPI modules with prebuilt binaries (`lmdb`,
`@lancedb/lancedb`). `better-sqlite3` is the same category (prebuilds for win32/darwin/linux), so it
preserves the "single `npm install` / single build artifact, runtime-resolved" property the
cross-platform doc relies on. (`node:sqlite` is the future no-dep path once workers move to Node 22+.)

---

## 4. Architecture overview

```
                         ┌──────────────────────── node (worker, machineId=N) ───────────────────────┐
  requester              │                                                                            │
  (LLM via MCP,          │   ┌─ ACCESS MANAGER (mgr) ────────────────┐                                │
   local/cloud) ──1─────▶│   │  resolve principal (local|cloud)       │      ┌─ DATA PLANE ──────────┐ │
   "read+query 'tickets'"│   │  evaluate ACL ∩ requested ∩ visibility │      │  enforce(key,ds,action)│ │
                         │   │  mint scoped AccessKey  ──2──▶ key      │      │   │                    │ │
                         │   │  key store (LMDB) + audit              │      │   ▼                    │ │
                         │   └────────────────────────────────────────┘      │  StorageBackend         │ │
   requester ──3(key)───────────────────────────────────────────────────────▶│   vector | sql | cache  │ │
                         │                                                    │   + system: knowledge   │ │
                         │                                                    └───────────┬────────────┘ │
                         │                                            sync (synced datasets)│             │
                         └────────────────────────────────────────────────────────────────┼──────────────┘
                                                          hub  ◀───────────────────────────┘
                                                          (publish/pull replicas → data/remote/{machineId})
```

Two planes, one node-local enforcement point:
- **Control plane (mgr):** request → grant → key. Owns ACL, key lifecycle, audit.
- **Data plane:** every op carries a key (or a local root token); the backend runs only after
  `enforce()` passes.

Each node enforces **its own** ACL. There is **no fleet-wide master key**; "cloud" is a recognized
cross-node *identity*, but every node gates it locally.

---

## 5. Data model (contracts)

```ts
type BackendKind = 'vector' | 'sql' | 'cache';
type DataAction  = 'read' | 'query' | 'search' | 'write' | 'delete' | 'manage';
type NodeVisibility = 'local-only' | 'synced' | 'cross-node-readable';
type PrincipalType  = 'local' | 'cloud';

interface NodeOrigin { machineId: string; hostname: string; os: string; }

/** The unit ACL + sync attach to. Lives in the dataset registry. */
interface DatasetDescriptor {
  id: string;                  // slug, unique on the owner node, e.g. "tickets"
  backend: BackendKind;
  title?: string;
  ownerNode: string;           // machineId that created/owns it
  visibility: NodeVisibility;  // governs CLOUD principals (local always sees local data)
  system?: boolean;            // reserved datasets (e.g. "knowledge") — not user-deletable
  readOnly?: boolean;          // HARD cap to read/query/search for EVERY principal (script-owned / tracked files)
  sensitive?: boolean;         // never exposed to cloud, never synced; extra redaction (secrets)
  config: VectorConfig | SqlConfig | CacheConfig;
  acl: AclRule[];
  createdAt: string; updatedAt: string;
}

interface AclRule {
  // who: a principal class, a specific cloud user, or any
  principal: PrincipalType | { userId: string } | '*';
  actions: DataAction[];       // what they may REQUEST (the cap on grants)
}

/** Uniform record envelope across all three backends. */
interface DataRecord {
  id: string;
  fields: Record<string, unknown>;   // structured data
  text?: string;                     // optional — FTS (sql) / embedding (vector)
  metadata?: Record<string, unknown>;
  origin?: NodeOrigin;               // stamped on sync landing; absent = local
  createdAt: string; updatedAt: string;
}

/** Backend-neutral query — compiled per backend (full in sql, filtered in cache, alongside search in vector). */
interface QuerySpec {
  filter?: Array<{ field: string; op: 'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'in'|'contains'; value: unknown }>;
  fts?: string;                      // full-text match against `text`
  sort?: Array<{ field: string; dir: 'asc'|'desc' }>;
  limit?: number; offset?: number;
}
interface SearchSpec { query: string; limit?: number; filter?: QuerySpec['filter']; } // vector only

/** Issued key — opaque secret returned once; only the hash is stored. */
interface AccessKey {
  keyId: string;               // public handle
  secretHash: string;          // hash(secret); secret shown once at issue
  principalType: PrincipalType;
  principalId?: string;        // cloud user_id when cloud
  node: string;                // machineId this key is valid on (per-node keys)
  grants: Grant[];             // RESOLVED grants (ACL-bounded)
  label?: string;              // the requester's stated intent (audited)
  issuedAt: string; expiresAt: string; revoked?: boolean;
}
interface Grant { dataset: string; actions: DataAction[]; }

interface AccessRequest {
  intent?: string;                                   // free-text "what I want to do" (audited)
  grants: Array<{ dataset: string; actions: DataAction[] }>;
  ttlSeconds?: number;                               // requested lifetime (server caps it)
}
```

---

## 6. The Access Manager (mgr)

### 6.1 Principal resolution (reuses existing auth boundaries)
The **arrival path** classifies the principal — no new credential type:
- Request arrived on **direct local HTTP** with a valid local api-token → `local`.
- Request arrived via the **hub `api_relay`** (carries `user_id`) → `cloud`, `principalId = user_id`.

This is decided in one helper (`resolvePrincipal(req)`) and threaded into both planes. We extend the
`api-relay-handler` allow-list to include the new `/data/*` paths; we change no existing auth.

### 6.2 Grant evaluation (dynamic, ACL-bounded — decision #1)
For each requested `{ dataset, actions }`:
```
allowed_actions = ∩ of:
   requested.actions
   actions permitted to this principal by dataset.acl   (match class, userId, or '*')
   visibility filter:
     - local principal  → no restriction (full local access)
     - cloud principal  → dataset.visibility ∈ {synced, cross-node-readable}, else ∅
   read-only cap:
     - dataset.readOnly → ∩ {read, query, search}   (applies to local root too)
   sensitivity:
     - dataset.sensitive AND cloud principal → ∅ (denied outright)
drop the grant if allowed_actions is empty
```
Mint a key carrying the surviving grants. If **all** grants are empty → deny (`403`, with the reason).
The key's privileges *are* "the role" the user described — computed per request, capped by ACL.

### 6.3 Local fast-path ("local = full access", zero friction)
A request bearing a valid **local api-token** and **no access key** is treated as
`local`-principal-root: full access to all **local** datasets. The explicit request→key flow remains
available to local callers who want to **mint a reduced key to delegate** (e.g. hand a narrow,
short-TTL key to a sub-agent). **Cloud requests must always carry a minted key.** Result: one uniform
`enforce()` path; the principal class only changes what the mgr is willing to grant.

### 6.4 Key lifecycle (decision #3 — opaque, revocable, audited)
- Secret = 32 random bytes, base64url; presented as `keyId.secret` once at issue.
- Stored: `AccessKey` with `secretHash` only, in an **LMDB-backed `KeyStore`** (same pattern as
  `session-cache-store.ts`), plus an **append-only audit log** (issue + each use).
- `expiresAt` enforced; `revoked` flag honored; `DELETE /data/access/:keyId` revokes.
- Reaper sweeps expired keys (reusing the chunked-timer approach from the api-token rotation fix).

### 6.5 Enforcement (data plane)
`enforce(req, dataset, action)`:
1. local api-token + no key → allow if dataset is local. 2. else read key from `X-LM-Access-Key`
header → look up → verify `secretHash`, not expired, not revoked, `key.node === thisNode` →
grant covers `(dataset, action)` → allow; else `403`. Cloud principals additionally re-checked against
current `visibility` (defense in depth if a dataset was re-flagged after issue).

**Hard caps applied before principal/ACL logic:** if `dataset.readOnly`, `action` must be in
{read,query,search} else `403` for *everyone* (incl. local root); if `dataset.sensitive`, cloud
principals are denied outright. **Every returned record passes the redaction filter (§12.1)** before it
leaves the data plane.

---

## 7. Backends

### 7.1 Common contract
```ts
interface StorageBackend {
  kind: BackendKind;
  createDataset(d: DatasetDescriptor): Promise<void>;
  dropDataset(id: string): Promise<void>;
  put(dataset: string, record: DataRecord): Promise<{ id: string }>;
  get(dataset: string, id: string): Promise<DataRecord | null>;
  query(dataset: string, q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }>;
  search?(dataset: string, s: SearchSpec): Promise<Array<DataRecord & { score: number }>>; // vector
  delete(dataset: string, id: string): Promise<boolean>;
  admin?(dataset: string, op: string, args?: Record<string, unknown>): Promise<unknown>; // store-specific maintenance (manage)
  // sync hooks (generalize knowledge remote-sync)
  exportSince(dataset: string, since?: string): AsyncIterable<DataRecord>;
  importBatch(dataset: string, records: DataRecord[], origin: NodeOrigin): Promise<number>;
}
```
A `BackendRegistry` maps `BackendKind → StorageBackend`. Routes/mgr never branch on backend except to
expose `search` only where present.

### 7.2 cache backend (LMDB, compressed) — *first to build*
- One LMDB env per dataset at `data/cache/<id>.lmdb`, `compression: true`, msgpack encoding.
- `put/get/delete` = direct KV; `query` = key-prefix scan + in-memory `QuerySpec.filter`/`sort`/`limit`
  (small/medium datasets; documented limit). No `search`.
- This is the literal "cache backend for compressed object db" — and validates the whole control
  plane against the simplest engine first.

### 7.3 vector backend (LanceDB + shared embedder)
- Each vector dataset is its **own LanceDB table** `ds_<id>` in the existing `~/.lm-assist/lance-store/`
  store — the global `vectors` table is left exactly as-is.
- `put`: embed `record.text` via the **existing global embedder** (384-dim) → upsert row
  `{ id, vector, text, fields(json), metadata(json), origin… }`.
- `search`: reuse the existing **hybrid vector+FTS RRF** logic (lifted/shared from `vector-store.ts`).
- `query`: metadata filter (no embedding). `VectorConfig` v1 = `{}` (embedder fixed).

### 7.4 sql backend (better-sqlite3) — structured + constrained (decision #2)
- One SQLite file per dataset at `data/sql/<id>.sqlite`. Fixed physical schema:
  ```sql
  CREATE TABLE records(
    id TEXT PRIMARY KEY, fields TEXT /*json*/, text TEXT, metadata TEXT /*json*/,
    origin_machine TEXT, created_at TEXT, updated_at TEXT);
  CREATE VIRTUAL TABLE records_fts USING fts5(text, content='records', content_rowid='rowid');
  -- plus generated columns + indexes for SqlConfig.indexedFields (JSON paths)
  ```
- `SqlConfig = { indexedFields?: Array<{ path: string; type: 'text'|'number' }> }` — declared fields
  become indexed generated columns so `QuerySpec.filter/sort` on them is fast and **parameterized**.
- `query` compiles `QuerySpec` → parameterized SQL (filters on indexed/JSON fields, FTS via
  `records_fts MATCH ?`, sort, limit/offset). **No raw SQL accepted from callers.**
- Local-admin-only escape hatch: a `manage`-gated `POST /data/:id/sql` for raw read-only SQL (never
  exposed to cloud principals).

### 7.5 System datasets: management adapters over existing stores (goal 8)
Reserved `system: true` datasets expose the **existing databases** through the generic interface so an
LLM can manage them via API/MCP **when needed** — without rerouting normal flows. Each adapter is
`StorageBackend`-shaped and delegates to the store's **own methods**, so invariants (index.json
consistency, knowledge↔vector linkage) hold exactly as the existing routes maintain them.

- **`knowledge`** — over `getKnowledgeStore()` (+ `getVectorStore()` for search):
  `search`→ existing hybrid knowledge search; `get`→ `K00x` doc/part; `query`→ list/filter;
  `write`→ `createKnowledge`/`updateKnowledge`/`addComment`; `delete`→ `deleteKnowledge`;
  `admin` ops → `regenerate`, `dedup`, `review`, `remote-sync` (the existing pipeline entry points).
- **`vectors`** — over `getVectorStore()`: `query`/`search`→ hybrid/vector search, `getStats`;
  `write`→ `addVectors`; `delete`→ `deleteKnowledge`/`deleteSession`/`deleteAllByType`;
  `admin` ops → `rebuild-fts`, reindex.
- *(optional)* **`session-cache`** — read/inspect + `admin` `warm`/`clear` over the session cache.

**Gating (the "not in normal cases" rule):** system datasets default to
`acl: [{ principal:'*', actions:['read','query','search'] }, { principal:'local', actions:['write','delete','manage'] }]`
— **read open, mutate/admin local-only by default.** A cloud LLM gets management only if the operator
explicitly adds a `{ userId, actions:['manage',…] }` rule; a `local` principal (incl. the local stdio
MCP) manages directly via the root fast-path. The existing `/knowledge/*` routes and
`search`/`detail`/`feedback` tools stay **byte-stable** — a system dataset is an *additional caller* of
the same store methods, not a rewrite.

**Read-only tracked datasets (script-owned data + generated artifacts).** Data whose lifecycle a
script/codebase owns is exposed `readOnly: true` — a *hard cap* to `read/query/search` for **every**
principal (incl. local root), because the owning script is the only legitimate writer:
- script-managed JSON stores — `learning-signals`, `project-summaries`, `prompt-queue` — read/inspect only.
- tracked generated files — `*.md` artifacts and logs (`context-inject-hook.log`, `mcp-calls.jsonl`,
  `upgrade.log`) surfaced for read/search via a read-only file-source adapter; never mutated, and run
  through the redaction pass (§12.1) since logs can contain secrets.
Tracking is **allow-list only** — a file/dir is exposed only when explicitly registered; the storage
system never auto-walks the home dir.

---

## 8. Node-awareness & cross-node sync

Generalizes the knowledge remote-sync; **single-writer, read-only replicas** (no conflict resolution).

- **local-only** — never leaves its node. Cloud principals can't be granted it (empty grant).
- **synced** — the owner node publishes record batches over the hub; subscribing nodes pull and store
  read-only replicas under `data/remote/{machineId}/<dataset>` via `importBatch(... origin)`; vector
  datasets are re-indexed locally. Reads served locally. (Exactly today's `remote/{machineId}` knowledge.)
- **cross-node-readable** — not physically replicated; a cloud caller reaches it by **targeting the
  owner node** (MCP `node` param / hub relay), where that node's mgr+ACL gate the read.

Sync engine `data-sync.ts` mirrors `knowledge` remote-sync: `POST /data/:id/sync` (trigger),
`GET /data/sync/status`; transport over the existing hub-client WebSocket. Replicas carry `origin`
and a `stale` tombstone on source deletion (same mechanism vectors already use).

---

## 9. REST API surface (`core/src/routes/core/data.routes.ts`)

Control plane:
| Method | Endpoint | Action | Who |
|---|---|---|---|
| GET | `/data/catalog` | list datasets visible to caller + allowed actions | any authed |
| POST | `/data/access` | request key (`AccessRequest`) → `{ keyId, secret, grants, expiresAt }` | any authed |
| DELETE | `/data/access/:keyId` | revoke a key | issuer / local |
| GET | `/data/access/:keyId` | inspect (no secret) | issuer / local |

Data plane (require key / local root; `enforce()` per call):
| Method | Endpoint | Action |
|---|---|---|
| GET | `/data/:dataset/records/:id` | `read` |
| POST | `/data/:dataset/query` | `query` |
| POST | `/data/:dataset/search` | `search` (vector only) |
| PUT | `/data/:dataset/records` | `write` |
| DELETE | `/data/:dataset/records/:id` | `delete` |

Admin (local / `manage`):
| Method | Endpoint |
|---|---|
| GET/POST | `/data/datasets` (list / create) |
| PUT/DELETE | `/data/datasets/:id` (config+ACL / drop) |
| POST | `/data/:dataset/sync`, GET `/data/sync/status` |
| POST | `/data/:dataset/sql` (raw read-only SQL, local-only) |
| POST | `/data/:dataset/admin` (`{op,args}` store-specific maintenance — `manage`; the goal-8 LLM management path) |

All responses use the existing `wrapResponse`/`wrapError` `ApiResponse<T>` envelope.

## 10. MCP tool surface (4-file add → stdio + HTTP `/mcp`)

Add to `definitions.ts`/`expanded.ts` (`EXPANDED_TOOL_DEFS` + `EXPANDED_HANDLERS`) + `TOOL_SCOPES`,
handlers call the loopback data routes (like existing tools call `/mcp/*`). The `node` param is
auto-injected (free node targeting); `data_catalog` pairs with `list_nodes`.

| Tool | Scope | Purpose |
|---|---|---|
| `data_catalog` | read | list datasets the caller may use (+ allowed actions, backend, visibility) |
| `data_request_access` | read | `AccessRequest` → access key (the mgr ask-and-grant step) |
| `data_query` | read | structured query within a dataset (needs key) |
| `data_search` | read | semantic search within a vector dataset (needs key) |
| `data_get` | read | fetch a record by id (needs key) |
| `data_put` | write | write a record (needs key + `write`) |
| `data_delete` | write | delete a record (needs key + `delete`) |
| `data_admin` | manage | run a declared store-specific op on a (system) dataset — rebuild-fts, regenerate, dedup, reindex, clear-cache… (goal-8 management) |

LLM loop: `data_catalog` → `data_request_access` (state intent) → use returned key with
`data_query`/`data_search`/`data_get`/`data_put`. Existing `search`/`detail`/`feedback` unchanged.

## 11. On-disk layout (under `~/.lm-assist/`)
```
data/
  datasets.json                 # dataset registry (descriptors + ACL + visibility)
  keys.lmdb                     # KeyStore (hashed secrets) + audit
  sql/<id>.sqlite               # sql datasets
  cache/<id>.lmdb               # cache datasets (compressed)
  remote/<machineId>/<id>/...   # synced-in read-only replicas
lance-store/                    # existing; vector datasets add tables ds_<id>; `vectors` untouched
knowledge/                      # existing; untouched (exposed via system dataset adapter)
```

---

## 12. Security considerations
- Opaque secrets, hashed at rest, shown once; per-node validity; expiry + revocation + audit log.
- Cloud principals can **never** exceed per-node ACL or read `local-only`/non-cross-node data;
  re-checked at enforce time (defense in depth).
- SQL injection foreclosed: no raw SQL from cloud/LLM; parameterized compiler only; raw SQL local-only.
- `dataset` id validated (`^[a-z0-9][a-z0-9_-]{0,63}$`) — no path traversal into `sql/`,`cache/`.
- Write size/rate caps; `manage` actions never granted to cloud by default.
- System-dataset **mutate/admin is local-only by default**; cloud management of existing DB data is
  opt-in per dataset ACL, and the management path delegates to existing store methods (no raw writes).
- A single kill-switch `dataServiceEnabled` (project-settings.json), mirroring `knowledgeEnabled`.

### 12.1 Sensitivity & redaction (secrets must never leak — enforces the global secret rules)
- **Hard exclusion (never registrable, never tracked, never a dataset):** `~/.claude/.credentials.json`
  (OAuth), `~/.lm-assist/hub.json` / `hub-dev.json` (hub apiKey), `~/.claude/claudeai-session.json`
  (cookies), `.env` (ANTHROPIC/TIER keys), the access-key store `data/keys.lmdb`, and any LIVE trading
  credential. The registry refuses to create/track a dataset whose backing path matches this list.
- **Field redaction (always on):** before any record leaves the data plane, values under key names
  matching `/(token|secret|password|api[-_]?key|cookie|credential|authorization|private[-_]?key)/i`
  become `«redacted»`. Applied for all principals; tracked logs/JSON are scrubbed on read.
- **`sensitive: true` datasets:** excluded from cloud principals entirely, excluded from sync, never
  cross-node-readable — regardless of ACL.
- **Cloud is stricter:** cloud principals cannot read `sensitive` datasets, cannot receive unredacted
  fields, and cannot be granted `manage` on system datasets without an explicit operator ACL rule.

## 13. Backward-compatibility guarantees ("care existing impl")
1. `core/src/knowledge/`, `core/src/vector/vector-store.ts` global `vectors` table: **unmodified**.
   (We *lift/share* the RRF helper into a common util consumed by both — no behavior change.)
2. `/knowledge/*` routes + `search`/`detail`/`feedback` MCP tools: **byte-stable** (regression-tested).
   The `knowledge`/`vectors` system datasets are an *additional caller* of the same `KnowledgeStore`/
   `VectorStore` methods (goal-8 management) — not a rewrite — so invariants are preserved.
3. New work is purely additive: new `data.routes.ts`, new backends, new MCP tools, new on-disk `data/`.
4. chokidar stays `^3.6.0`; new ESM-only deps (none expected) follow the `Function('import')` rule.

## 14. Relationship to the platform-capability architecture
Orthogonal axis. That design splits OS-specific *code* behind capability **ports**; this design
controls *data access* via access **keys**. To avoid the name clash we use "access key/grant/mgr,"
never "capability." A backend with OS-specific bits (none expected in v1) would itself sit behind a
platform port — the two compose cleanly.

## 15. Implementation phasing (each phase → its own writing-plans plan)
- **M1 — Control plane + cache backend + sensitivity guard:** `BackendRegistry`, `DatasetRegistry`,
  `KeyStore`+audit, mgr (resolve/grant/enforce), principal resolution, `data.routes.ts`, cache backend,
  and the §12.1 guard (hard-exclusion list + always-on redaction filter — it lives in the
  enforce/return path, so it ships first). Provable end-to-end on the simplest engine.
- **M2 — vector backend + system-dataset management + read-only tracking:** per-dataset LanceDB tables,
  shared embedder, shared RRF; `knowledge` + `vectors` management adapters (full CRUD + `admin` ops,
  gated; delegating to existing store methods); read-only tracked datasets (script JSON stores,
  generated md/logs). Backward-compat snapshot tests gate this.
- **M3 — sql backend:** better-sqlite3, fixed schema + FTS5 + indexed JSON fields, QuerySpec compiler.
- **M4 — MCP tools:** the 7 `data_*` tools via the 4-file add; verify both surfaces.
- **M5 — cross-node sync:** generalize remote-sync; visibility enforcement; node-targeted access.
- **M6 (optional) — web management UI:** datasets, ACL, keys, sync status.

## 16. Testing strategy
- **Unit:** each backend put/get/query/delete round-trip; QuerySpec compiler (sql); mgr grant math
  (grant within ACL, deny beyond ACL, cloud blocked on local-only, visibility intersection, expiry,
  revocation); principal resolution (local vs relayed).
- **Integration:** REST with/without valid key (403 paths); MCP dispatch on stdio **and** `/mcp`;
  cross-node sync round-trip between two simulated nodes; system-dataset read-through to knowledge.
- **Backward-compat:** snapshot of `/knowledge/*` + `search/detail/feedback` outputs unchanged.

## 17. Open questions / future work
- Per-dataset embedding models; multi-writer/CRDT sync; per-record ACL; raw-SQL delegation to trusted
  cloud users; quota/usage accounting per key; web UI (M6). All deferred.
