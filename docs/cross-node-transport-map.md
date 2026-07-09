# Cross-Node Transport Map (hub relay · fabric · file transfer · sync)

> Consolidated architecture review, 2026-07-08. Maps every path bytes/requests can take between
> nodes, across both boundaries: the LangMartDesign **hub** (`assist-api.langmart.ai`) and the
> lm-assist **worker** (local Core). Built from a 5-way parallel code audit. File:line anchors inline.

## TL;DR — there are 3 parallel transport stacks + fragmented consumers

Over W1–W4 three **independent** cross-node transports were built and never unified:

1. **Hub API relay** — request/response over the worker's outbound WebSocket to the SG hub. Universal baseline.
2. **Fabric direct P2P** (W1/W2) — LAN peer-to-peer (relay→UDP→TCP-for-LAN). Fast path, mostly **opt-in/dormant**.
3. **File-transfer transport** — its own durable job manager + hybrid/TCP/firehose byte path. Self-contained, clean.

The consumers pick among these **inconsistently**: data-sync can use fabric *or* hub; knowledge/memory/rules are hub-only; the bus is fabric-only; file bytes use the fabric *channels* but not its RPC; general fabric RPC is off by default. Plus there are **4 duplicated hub-fetch helper implementations** on the caller side and **7 relay paths** on the hub side.

---

## The two boundaries

```
                    ┌─────────────────────── HUB (LangMartDesign assist-api, :8086) ───────────────────────┐
 caller (connector, │  Bearer/OAuth ──> /api/tier-agent/machines/:id/proxy/*  ──relayApiRequest()          │
 claude.ai, another │                    (7 relay paths; requestId-correlated JSON/binary over gateway WS) │
 node's Core)  ─────┤  express.json 50MB body · 30s request timeout · addr by gatewayId                    │
                    └──────────────────────────────────┬───────────────────────────────────────────────────┘
                                                        │  worker's OUTBOUND WebSocket (HubClient)
                    ┌───────────────────────────────────▼─────────────── WORKER (lm-assist Core) ──────────┐
                    │  api-relay-handler.ts: allow-list (~40 prefixes) · **1MB cap (:64)** · 30s (:332)     │
                    │  INJECTS x-relay-source:hub + x-api-key:localToken ; STRIPS client x-relay-source /   │
                    │  x-lm-user-id (:407-432)  ──dispatch──>  localhost:3100  (resolves as CLOUD principal) │
                    └──────────────────────────────────────────────────────────────────────────────────────┘

  OR bypass the hub entirely (same-cluster, linked):
  caller Core ──fabric link (relay→UDP→TCP-for-LAN)──> peer Core :3100  (resolves as PEER principal)
```

**Key consequence** (the source of the "hub sync doesn't work" behavior): a hub-relayed request lands as an
**anonymous `cloud` principal** (`x-relay-source:hub`, no `x-lm-user-id`), which needs a matching **ACL** entry
to read a dataset. The fabric path lands as a trusted **`peer`** principal, readable by visibility alone.
See `docs/…` access-manager: `resolvePrincipal` + `evaluateGrants`.

---

## Transport family 1 — Hub API relay

**Caller-side helpers (4 implementations, 2 are duplicates):**

| Impl | File | Behavior | Node addressing |
|---|---|---|---|
| data | `data/peer-client.ts:46-114` | `hubFetch/proxyFetch/proxyPost/proxyGet`; **throws** on error; access-key in **header** | `gatewayId‖machineId‖id` ✅ |
| knowledge | `knowledge/remote-sync.ts:123-163` | **DUPLICATE** of peer-client (verbatim) | `machineId‖gatewayId‖id` ❌ (recreates on cloud restart) |
| memory/rules | `memory/mcp-transport.ts:11-89` | `relayPost/relayGet`; **returns null** on error; access-key in **body** | caller-supplied |
| browser | `routes/core/peer-relay.routes.ts:59-104` | browser→local-core→hub; path-validated; refuses relay-chaining | — |

**URL/auth:** `{hubHttp}/api/tier-agent/machines/{node}/proxy{path}` + `Authorization: Bearer {hub apiKey}`.

**Hub side — 7 relay paths** (LangMartDesign; 6 share the WS relay core, gateway-proxy is separate):

| Path | Endpoint | Auth | Notes |
|---|---|---|---|
| Machine proxy | `…/machines/:id/proxy/*` | Bearer | the data/memory/rules/knowledge/mission path |
| Generic catch-all | `ALL …/machines/:id/*` | Bearer | falls through to `relayToMachine()` |
| MCP relay | `/internal/mcp-relay` | shared-secret + Bearer | **only path that injects a user id** (`x-mcp-user-id`) |
| Console binary | `/ws/console/:id/:sid` | Bearer or console token | `[0xFF][hash][payload]` |
| ttyd HTTP/WS | `…/machines/:id/ttyd/:port[/ws]` | Bearer or proxy token | strips `token` query |
| Port-forward | internal node↔node | user-ownership | `[0xFE][streamHash][payload]` |
| Transport relay | internal (NAT) | user-ownership | `[0xFD][channelHash][payload]` — carries the fabric relay floor |
| gateway-proxy | `/auth/*`, `/api/public/*` | Bearer | **direct HTTP to gateway-type1, forwards ALL headers (no stripping)** |

**Caps (split across layers):** hub `express.json` **50MB** + 30s (`app.ts:49`, gateway-manager `:146`); worker relay **1MB** + 30s (`api-relay-handler.ts:64,332`). Effective ceiling = **1MB, worker-side**.

---

## Transport family 2 — Fabric direct P2P (W1/W2/W3)

**Layers:** W1 link (`fabric/peer-link.ts:53`, `peer-manager.ts:32`) → W2 transmission (`fabric-link.ts:68` RPC/msgpack, `chunking.ts` >64KB, `compression.ts` path-aware gzip) → W3 bus (`bus/bus.ts:73` fanout, `:188` catch-up).

**Channels:** RELAY (always, hub WS `0xFD`) → DIRECT (IPv4 UDP, `via==='host'`) → **TCP-for-LAN** (HTTP-Upgrade `lm-tcp/1` on the Core API port, 100–225 MB/s). Relay→direct upgrade via `link.onChannel()`+`channelSwapped()`.

**Kill-switches** (`project-settings.ts:103-108`): `fabricEnabled=true`, `busEnabled=true`, `fabricCompressionEnabled=true`, **`fabricRpcEnabled=false`**, **`dataSyncViaFabric=false`**.

**Eligibility (3-gate AND):** `dataSyncViaFabric && fabricLinks.has(node) && peerHasFeature('data')` → else hub.

**Adoption:** Bus = **active**. Data-sync = **opt-in** (`FabricPeerClient` wraps `HubPeerClient`, per-call try-fabric/catch-hub). File-transfer = **active** (uses the fabric *channels*). General RPC = **dormant** (`fabricRpcEnabled=false`; rpc-server allow-list scoped to `/bus/*` + `/data/sync/*` only). Bulk >8MB response → offloads to file-transfer.

---

## Transport family 3 — File / bulk transfer (the clean one)

`transfer_send_file` → `POST /transport/send-file` → durable **job manager** (`file-transfer/job-manager.ts`: enqueue→pump[per-peer 2/global 8]→runJob[retry 1/3/9s, TTL sweep]) → `sender.ts sendPath`.

**Byte transports (all converge on one hybrid channel + one receiver `receiver.ts:234`):** RELAY(always) | DIRECT-UDP | TCP-for-LAN | FIREHOSE(unreliable UDP >10MB, NACK-repair). **Control plane always relay.** Size-adaptive: <64KB→relay; ≥64KB→TCP-then-hybrid; >10MB+direct→firehose. Resume via `.lmpart` sidecar (receiver-authoritative). `send-queue.ts` **retired**. **No major inconsistency** — this is the model the sync engines should follow.

---

## Sync engines — one job, five implementations

| Engine | Transport | Auth | Trigger | Dir |
|---|---|---|---|---|
| **Data** (`data/sync-engine.ts`) | fabric (opt-in) → **hub** | minted per-dataset ACL key (30s) | bus change-notify ~300ms + 300s reconcile | pull |
| **Knowledge** (`knowledge/remote-sync.ts`) | **hub only** | static hub apiKey (Bearer) | manual/fire-and-forget, never reconciles | pull |
| **Memory** (`memory/autosync.ts`) | **hub only** | static hub apiKey (body) | chokidar + 1.5s debounce; 15s startup | **push** (cloud→home + mesh) |
| **Rules** (`rules/autosync.ts`) | **hub only** | static hub apiKey (body) | chokidar + **5-min reconcile of ALL nodes** (no cluster scope) | pull |
| **Missions/clusters** | via Data engine | (data engine) | (data engine) | pull |

Three orthogonal axes of divergence: **transport** (only data has a fabric path), **auth** (data mints scoped ephemeral keys; the rest reuse the static enrollment key → wider blast radius), **trigger** (bus-event vs two different chokidar watchers vs manual).

---

## Inconsistency inventory (ranked)

1. **No shared peer-transport abstraction.** Data-sync alone got the fabric fast-path (opt-in); knowledge/memory/rules are permanently hub-bound. A node on fabric still pulls 3/4 sync types over the slow hub. → Wrap all sync in the `FabricPeerClient` fabric-first/hub-fallback pattern.
2. **4 hub-fetch helpers, 2 verbatim duplicates**, diverging on node-addressing (`gatewayId`-first ✅ vs `machineId`-first ❌ — the knowledge copy mis-IDs nodes after cloud restart) and error handling (throw vs silent-null). → Extract one `hub-client/hub-fetch.ts`; fix addressing to gatewayId-first everywhere.
3. **Anonymous cloud principal on the hub path.** `x-lm-user-id` is never injected (the MCP path injects a *differently-named* `x-mcp-user-id`), so hub-relayed sync is an ACL-gated anonymous cloud caller → most datasets (empty ACL) don't sync over the hub at all. Fabric's peer principal is why it "just works". → If the hub path must sync, either inject a verified `x-lm-user-id` or give sync datasets a `peer`/`*` ACL grant.
4. **Auth model per engine.** Data = ephemeral scoped keys; memory/rules/knowledge = static enrollment key on every op. → Unify on the minted-key or peer-principal model.
5. **Fabric RPC dormant by default** (`fabricRpcEnabled=false`, `dataSyncViaFabric=false`). The whole W2 RPC layer is built but only bus + opt-in data-sync use it. → Decide: promote to default-on per cluster, or document as opt-in.
6. **Caps split across 3 layers** (hub 50MB / worker-relay 1MB / fabric chunked-unbounded / file-transfer own path). The 1MB worker cap silently bounds every hub-relayed data/memory/rules payload. → Document the effective ceiling; align data-sync export chunking to it.
7. **gateway-proxy bypasses the header-stripping boundary** (forwards all headers to gateway-type1). Fine today (only `/auth`,`/api/public`), but a different security model than the machine-proxy relay. → Keep it strictly off the worker-relay allow-list.
8. **Rules reconcile has no cluster scope** — every 5 min it pulls from *all* online nodes → O(N²) cross-cluster traffic at fleet scale. → Add cluster scoping like the data engine's `shouldPullDataset`.

## Recommendation

Converge on **one peer abstraction**: a single `PeerClient` (fabric-first, hub-fallback, one hub-fetch helper, one auth model, gatewayId addressing) that **all** sync engines + the API relay call — exactly the `FabricPeerClient`/file-transfer pattern, generalized. That collapses families 1+2 for callers, kills the duplicate helpers, gives knowledge/memory/rules the fast fabric path for free, and makes the cloud-vs-peer auth boundary uniform. File-transfer (family 3) is already the reference implementation.
