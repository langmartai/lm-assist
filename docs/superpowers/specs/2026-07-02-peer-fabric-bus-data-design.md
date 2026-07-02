# Peer Fabric, Message Bus, and Data Service Redesign

**Date:** 2026-07-02
**Status:** Draft — pending user review
**Relates to:** `docs/plans/2026-06-08-nat-transport-design.md` (the hybrid transport this builds on); the paused mission-workflow registry design (its fleet-synced docs + fast convergence depend on W3/W4 here).

---

## 1. Problem — what the review found

lm-assist's cross-node foundations grew per-feature. Three findings drive this redesign:

1. **Three parallel network stacks, and the wrong one carries the data.** The hub HTTPS machine-proxy (`data/peer-client.ts`) carries data sync, mission leader-anchoring, cross-node MCP routing, and session messaging — every byte between LAN neighbours (117/123/107 all on `10.0.1.x`) hairpins through the Singapore hub under a 30s timeout, 1MB body cap, and header stripping (the origin of every key-in-body workaround). Meanwhile a capable hybrid P2P transport (`core/src/transport/`: relay floor over hub WSS + direct UDP with STUN/hole-punch, candidate ladder host/static/srflx, ReliableConnection, live mode/RTT) exists and is used by exactly one consumer: file transfer. Its direct path is **unencrypted** (crypto = md5 frame routing only).

2. **The data service's push path is dead; there is no message plane.** The designed `dataset_updated` flow (15s dirty-flush → hub → reactive pull) never fans out in practice, so cross-node convergence rides the **300s reconcile**. This caused real bugs (0.1.82 stranded-mission) and scar tissue (hand-wired leader-anchor proxies in every mission route). There is no durable cross-node event log at all: the only working cross-node push is the bespoke `memory_updated` message; everything else polls (supervisor 1min — full cloud transcript reads per active mission, stall-monitor 5min, message sweeper 30s, reconcile 300s).

3. **Messaging has no delivery semantics.** `send_session_message` requires a live driveable target now, retries via a 30s sweeper forever, loses messages on crash, and offers no cross-node ack. Worker→controller reporting is split across three channels (`⟦WORKER-STATUS⟧` output blocks, local-only `POST /worker/status`, session messages). Multi-writer state is only safe by convention: LWW replaces whole records; no CAS.

The reference design already in hand: the Anthropic `worker/events` channel (reverse-engineered, memory `remote-control-worker-events-protocol`) — durable append-only log, per-subscriber cursors, fan-out, idempotent resolution — is exactly the missing primitive, proven against our own controller.

## 2. Decisions locked with the user

| Decision | Choice |
|---|---|
| Execution order | **Network design first, then data transmission design** on top |
| Direct-path security bar | **LAN-direct trusted** (`via === 'host'` only for general traffic); WAN always TLS relay floor; encryption is the roadmap item that lifts this |
| Program scope | **Foundation-first**: fabric → bus → data-service changes; existing paths migrate in later waves |
| Addressing | Logical only — **node id or resource id (e.g. session)**; a resource is resolved to a node by a **Resolution Service**; the network routes |
| Failure handling | **Auto-managed retry**, escape to any available method, **automatically return to the best path** when it recovers |
| Transmission concerns | Data-type-aware **compression**; **large-file multipart** transmission auto-managed with status; **bandwidth/speed monitoring** |
| Status/observability | Nodes **manage their own connectivity state**; one **general** `node_status` MCP endpoint (network is one section, not the whole story) |
| Hub changes | None required (worker-side only falls out of the fabric design) |

---

## 3. Part 1 — Network Design

### N1. Topology & roles
- Nodes form the data plane; node↔node whenever possible.
- Hub = control plane only: identity/enrollment, presence roster (`/machines`), rendezvous + STUN (`hub:8087`), TLS relay floor (0xFD frames over each node's WSS), connector/MCP ingress. **No hub code changes.**
- Paths between two nodes, preference order: `host-direct UDP (LAN)` → `srflx UDP (WAN hole-punched)` → `relay floor (TLS via hub)` → `legacy hub HTTPS proxy (compat)`.

### N2. Peer links
- One managed link per peer over the existing hybrid channel (relay floor always present; direct leg probed/confirmed per direction; live `mode`/`via`/`rtt`).
- Node-owned lifecycle state machine: `discovered → connecting → connected ⇄ degraded → idle`, plus `legacy` (no HELLO at setup) and `failed(backoff)`. Every transition timestamped with reason; per-link counters.
- **Path trust policy:** general traffic rides `host`-direct or the TLS relay floor — never plaintext over WAN. srflx-direct stays reserved for file transfer (as today) until link encryption ships.
- **Identity:** signaling flows over hub-authenticated WSS, so `peerGatewayId` is trusted by construction. Application ACLs are Part 2/3's job.
- Implementation note: the frozen Channel contract already provides the policy hook — `send()` = direct-when-confirmed, `sendControl()` = always-relay (`transport/index.ts:57-59`). Policy = use `send()` iff `via === 'host'`, else `sendControl()`. Zero transport-layer changes.

### N3. Addressing & routing — the Resolution Service
- Addresses are logical: `{node: <gatewayId>}` or `{resource: {kind, id}}`.
- **Resolution Service** (`core/src/resolution/`): registry of per-kind resolvers behind one interface:

```ts
interface Resolver {
  kind: string;                                   // 'session' | 'mission' | 'dataset' | 'role' | ...
  resolve(id: string): Promise<Location | null>;  // { node } | { cloud } | null
}
```

| Kind | Source |
|---|---|
| `session` | local index → cache → peer `exists` fan-out; session-footprints seeds the cache |
| `mission` | missions dataset (`ownerNode` / leader) |
| `dataset` | dataset registry (owner authority; synced replica = any node) |
| `role` | election (`leader`), controller record |

- Shared semantics in the service: TTL cache, short negative caching, **invalidate-on-delivery-failure → re-resolve** (moved/resumed resources heal), resolution counters in status.
- v1 boundary: the fabric routes to **fleet-resident** resources. Cloud CCR sessions (`session_…`/`cse_…`) resolve to `{cloud}` and keep the cloud client APIs — same vocabulary, no pretending.
- Subsumes over time: `send_session_message`'s `toNode`, `mission-session-resolver.ts` transport juggling, and (via `{role:"leader"}`) the per-route leader-anchor proxies.

### N4. Network management & observability
- The node owns its connectivity state. `GET /fabric/status` returns self + per-peer `{state, mode, via, rttMs, pathInUse: direct|relay-floor|legacy-proxy, since, lastError, counters {requests, bytes, failures, fallbacks, reopens}}`.
- **StatusRegistry:** every subsystem registers a provider returning `{ok|warn|error, summary, detail}` — `fabric`, `hub`, `data-sync`, `bus`, `scheduler`, `mission-controller`, `auth`, `services`.
- **MCP `node_status(node?, section?)`** — the general endpoint: no args → summary verdict across all subsystems; `section="network"` → full peer table; existing narrow tools (`data_sync_status`, `stall_status`, …) become thin views over the registry. Fleet matrix composes from each node's `network` section.

### N5. Failure model (network layer)

| Failure | Behavior |
|---|---|
| Peer offline | Link → `failed/idle`; fail fast upward — the network layer does not queue; durability/retry is the transmission layer's job |
| Hub down | Signaling + relay floor lost → cross-node down in v1 (documented); links re-establish on reconnect; LAN survivability of established links = v2 |
| Legacy peer | Detected at link setup → transparent fallback to hub HTTPS proxy; mixed-version fleet fully functional |
| Path flap | Degrade to relay floor without link death; upgrade back on re-confirmation (see T7.4) |

### N6. Contract upward
"An ordered, reliable, identity-authenticated pipe to a node (or a resolved resource's node), best path auto-selected per trust policy, with live health, fast failure, and status observability." Non-goals at this layer: framing, durability, app ACLs.

---

## 4. Part 2 — Data Transmission Design

### T1. Framing
Envelopes over the pipe: `{kind: hello|ping|req|res|pub|chunk|xfer, id, headers, payload}` (msgpack). Payloads > ~64KB split into `chunk {id, seq, fin}` frames. `req`/`res` correlate by `id` with per-call timeouts. `hello` carries `{fabricVersion, features}` for capability negotiation.

### T2. Data-type-aware compression
Per-frame `{enc, comp, rawLen}`; policy per payload **and per path**:

| Payload | LAN host-direct | Relay floor / WAN |
|---|---|---|
| json/text/code ≥ 4KB | gzip level 1 | gzip level 6 (hub bandwidth is scarce) |
| < 4KB | none | none |
| binary / pre-compressed | none (content-type hint, else entropy sample: compress head 4KB, <10% gain → skip) | none |

Savings counted per link (T5). Peers without `comp-gzip` in HELLO get `comp: none`.

### T3. RPC semantics
`req` dispatches into the **existing route table** with principal `{type:'peer', node}`; errors map to `{status, code, message}`; large responses stream as chunks. Existing handlers (`/data/:ds/export`, `/mission/*`, …) work over the fabric unchanged.

### T4. Bulk transfer — multipart, auto-managed
Formalizes the existing file-transfer layer (firehose, pacing, repair, `transfer_queue`) as the fabric's bulk class:
- Manifest `{transferId, name, size, partSize, partCount, sha256}` → receiver acks (reports part-bitmap when resuming) → parts flow (firehose on confirmed direct; chunked reliable on relay) → per-part CRC + received-bitmap → gap repair → whole-file hash verify → complete.
- Durable transfer state **both ends** (survives restarts; resume sends only missing parts); queued with per-link concurrency (~2); auto-retry with backoff; TTL cleanup of stale partials.
- **Auto-selection:** an RPC response above ~8MB returns a *bulk handle*; the fabric fetches it via this machinery transparently.
- Status: live records `{id, peer, direction, size, bytesDone, rate, eta, state, resumeCount}` via `transfer_stats`, `node_status(section="network")`, `GET /fabric/status`.

### T5. Bandwidth & speed monitoring + management
- Per-link metrics (10s EWMA + totals): in/out rate per class (`control|rpc|bus|bulk`), RTT, compression savings, queue depths, active transfers → StatusRegistry.
- Class priority via sender-side token buckets: `control > rpc > bus > bulk` (bulk consumes leftover budget only).
- Optional per-link/per-class caps in settings (defaults: uncapped on LAN-direct; bulk over relay floor capped at 5 MB/s to stay gentle on the hub).
- `fabric_probe(node)`: on-demand measured throughput + RTT on the current path.

### T6. Delivery guarantees by class

| Class | Guarantee |
|---|---|
| `rpc` | Effectively exactly-once within the dedup window; auto-retried across link failures; definite success or definite error |
| `bus` | At-least-once via durable log + cursors; fan-out fire-and-forget, catch-up heals |
| `bulk` | Exactly-once completion per transferId (bitmap + hash; resume, never re-execute) |
| `control` | Best-effort, link-scoped |

### T7. Failure auto-management
- **Layer 1 — link recovery (always):** reopen with backoff+jitter; degrade to relay floor on direct loss; re-HELLO after reopen.
- **Layer 2 — request auto-retry:** receiver-side **idempotency cache** `{requestId → response}` (~2 min, LRU) — a retried request returns the cached response, never re-executes. Classification: not-delivered → retry always; delivered-no-response → retry same id (cache dedupes); application error → **no transport retry**; budget exhausted → definite error with attempt trail. Backoff 0.5s→…capped; default ~4 attempts or caller deadline. Escalation between attempts: direct → relay floor → legacy proxy → re-resolve (resource addresses).
- **Layer 3 — per-class:** rpc per above (opt-out available); bus needs no per-event retry (log+cursors are the retry); bulk auto-resumes from bitmap; control regenerates.
- **T7.4 — always the best *available* path:** downward escape is instant and per-attempt. Upward restoration is automatic: relay-floor links re-probe direct ~30s; legacy links re-HELLO on peer reconnect + slow periodic retry (~10 min — catches upgraded peers); resource addresses re-resolve on TTL/failure. Anti-flap hysteresis: ~2 consecutive probe successes to climb, min ~30s between switches, repeat-flappers get exponentially longer confirmation windows + `warn` status. In-flight requests finish where they are; new frames take the new path.
- Observability: per-link/per-class retries, escalations, dedup-hits, exhausted budgets, `pathInUse` vs `bestPathAvailable`, `lastDowngrade/lastUpgrade`, `flaps`.

---

## 5. Part 3 — Services on the Transmission Layer

### S1. The Bus — durable event log with cursors
- **Topic** = named append-only log; names reuse the resource vocabulary: `data:<dataset>`, `mission:<id>`, `session:<uuid>` (mailbox), `node:<id>`, `app:<name>`.
- **Event** `{topic, origin, seq, type, payload, at}` — `seq` per-origin monotonic; global id `origin:seq`; ordering guaranteed per origin; replica merge = idempotent ingest keyed `(origin, seq)` — no LWW, no conflicts.
- **Storage:** `bus.lmdb` per node keyed `(topic, origin, seq)`; per-topic retention (default 10k events / 7 days) + compaction sweep; payload cap 64KB (bigger → dataset/bulk handle, event carries the reference).
- **Publish:** local append → `pub` fan-out to subscribed peers (cluster scope default; `fleet` for fleet topics). **Subscribe (in-process):** handler + durable cursor `{subscriberId, topic → origin→seq}` in LMDB; restart resumes exactly. **Catch-up:** `bus/:topic/since {cursors}` on link recovery/boot; slow reconcile (~5 min) as safety net.
- **MCP:** `bus_publish(topic, type, payload)` · `bus_read(topic, from?, wait?)` (long-poll ≤ ~25s, returns events + next cursor, stateless for the caller) · `bus_topics()`. Topics bridge to local SSE `/stream` for the web UI. Every new MCP tool gets a `TOOL_SCOPES` entry (hard rule — Core crashes on `/mcp` otherwise).
- **Control:** topic ACLs in the dataset vocabulary (local/peer write; cloud read via key; `sensitive` local-only). Status provider: topics, backlog, cursor lags, fan-out failures.

### S2. Data service changes
1. **Change-notify → bus:** `put/delete` publishes `{type:'changed'|'deleted', ids}` to `data:<dataset>`; peer sync listeners run a debounced `pullDataset` → convergence **~300s → ~1–2s**. Retires the dead dirty-flush→hub path and the unbounded SyncQueue (bounded debounce buffer remains); 300s reconcile stays as safety net.
2. **Sync over fabric:** manifest/export/fetch via `fabric.request({node}, …)` — auto-retry, compression, no 1MB cap (chunks; >8MB → bulk handles). Legacy peers keep hub HTTPS + key-in-body via fallback.
3. **Peer principal replaces minted sync keys:** engine sync authorizes as `{type:'peer', node}` against dataset visibility (`synced`/`cross-node-readable`); access keys remain only for cloud/connector callers.
4. **CAS put:** `put(record, {ifVersion})` → `CONFLICT` on mismatch; multi-writer callers retry-with-merge. LWW stays the sync merge rule; CAS guards the write path.
5. Hygiene: bound the debounce buffer; replica GC for departed peers (flagged, low priority); LanceDB compaction noted as follow-up.

### S3. First consumers (v1)
`missions` + `mission-workflows` datasets converge fleet-wide in ~1s — the direct dependency of the paused mission-workflow registry design, and the start of unwinding leader-anchor scar tissue. Named later waves (out of program, pre-shaped by the vocabulary): session mailboxes, worker→`mission:<id>` reporting, supervisor-as-bus-consumer, memory-push migration, leader-anchor retirement.

---

## 6. Part 4 — Delivery Plan

| Wave | Ships | Live e2e proof | Kill-switch |
|---|---|---|---|
| **W1 Network** | PeerManager, link state machine, HELLO/versioning, path policy, legacy fallback, Resolution Service, `GET /fabric/status`, StatusRegistry, `node_status` MCP | 117⇄123 `via:host` ms RTT; 107 Windows UDP link; legacy peer falls back cleanly | `fabricEnabled` |
| **W2 Transmission** | Framing/chunking, compression, RPC dispatch + peer principal, idempotency cache, auto-retry + T7.4 restoration, pacing + bandwidth monitors, bulk formalization, `fabric_probe` | Kill link mid-request → retry dedupes; >1MB export streams; transfer resumes across Core restart | per-class flags |
| **W3 Bus** | Topic log, durable cursors, fan-out, catch-up, retention, `bus_*` MCP, SSE bridge, status provider | 117 publish → 123 consume <1s; consumer restart → cursor resume; partition → catch-up | `busEnabled` |
| **W4 Data service** | Change-notify → bus, sync-over-fabric, peer-principal ACL, CAS, retire dirty-flush | Mission on non-leader visible on leader ~1s; CAS conflict; mixed-version fleet syncs | `dataSyncViaFabric` |

**Testing:** TDD units for every pure piece (state machine, framing codec, retry decision table, cursor merge, compression policy, CAS); isolated two-Core integration harness (the `:3201` + temp-data-dir pattern); live fleet e2e per wave on the real LAN + real Windows node; opus whole-branch review before each deploy.

**Risks:** 107 Windows UDP/firewall may block host-direct (relay floor absorbs; verify in W1) · ReliableConnection under sustained RPC load (W2 load test + pacing caps) · bus LMDB growth (retention churn-tested) · every wave's e2e includes one legacy peer · `forceMode:'relay'` per-link escape hatch.

**Deferred:** direct-path encryption (lifts LAN-only), hub-down LAN survivability, the later-wave migrations named in S3.

## 7. Non-goals
- No hub (LangMartDesign) changes.
- No replacement of cloud CCR communication (Anthropic-hosted sessions keep cloud client APIs).
- No new external dependencies for transport/crypto in this program (gzip = zlib built-in; msgpack already in the tree — confirm at plan time, else JSON+gzip).
- File transfer's user-facing behavior unchanged (it gains status/limits, loses nothing).
