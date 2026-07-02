# Bulk Transfer Job Manager — Design

**Status:** approved-in-brainstorm, pending spec review
**Context:** a scoped increment of the fabric spec's **T4 (Bulk transfer — multipart, auto-managed)**, `docs/superpowers/specs/2026-07-02-peer-fabric-bus-data-design.md` §4. Delivers the reliable, durable, cancellable job manager for cross-node bulk transfers; defers T4's heavier extras (compression, token-bucket class priority, RPC bulk-handle auto-fetch) and the data/blob adapter (W4).

**Goal:** turn the in-memory `send-queue.ts` (global cap 2, no durability, no cancel, no resume) into a durable, payload-generic **bulk transfer job manager** — async jobs with status, cancel (both ends), auto-retry, size-hybrid resume, per-peer concurrency, and TTL auto-clear — so cross-node bulk transfers are reliable across peer drops and Core restarts.

## Global Constraints

- **Payload-generic, not file-specific.** The engine moves bytes from a `Source` to a `Sink`; **files are the first adapter**. A data/blob adapter (large `data_put`/`data_get`, dataset export) plugs into the *same* engine at **W4** without touching the manager or wire protocol. Small data ops stay on the RPC class — this manager is the **bulk** class only.
- **Reuse the executor.** `sendPath` (path selection, per-attempt retry, live `transfer-stats`) stays the executor; it gains only `signal` + `resumeFrom`. The receiver (`handleIncomingTransfer`) gains resume + cancel handling.
- **Durable + crash-safe** via an append-only JSONL log; no new heavy dependency (no LMDB).
- **Wire-compatible additions only** — new FT control messages; existing FT_META/DATA/END/OK/ERR unchanged for the non-resumable path.
- Env-tunable throughout; safe defaults. Dev/prod-separated state files.

---

## 1. Architecture & components

| Unit | File | Responsibility |
|---|---|---|
| Job store | `core/src/file-transfer/job-store.ts` (new) | Durable persistence: append-only JSONL event log; replay-on-boot; atomic compaction. |
| Job manager | `core/src/file-transfer/job-manager.ts` (new; supersedes `send-queue.ts`) | Scheduler (per-peer queues + caps), lifecycle, cancel, backoff-retry, resume-decision, TTL sweeper, `recover()` on boot. |
| Source/Sink | `core/src/file-transfer/payload.ts` (new) | `Source`/`Sink` interfaces + the **file adapter** (`FileSource`, `FileSink`). |
| Executor | `core/src/file-transfer/sender.ts` (modify) | `sendPath` gains `opts.signal?: AbortSignal`, `opts.resumeFrom?: number`; reads from a `Source`. |
| Receiver | `core/src/file-transfer/receiver.ts` (modify) | Resume sidecar; `FT_META` resume handshake; `FT_CANCEL` cleanup; writes to a `Sink`. |
| Surface | `core/src/routes/core/transport.routes.ts` + MCP `transfer_*` (modify) | Jobs list / status / cancel. |

`send-queue.ts` is replaced by `job-manager.ts` (the route imports move); its public shape (`enqueueSend`, `snapshotQueue`, `getSendJob`) is preserved or thinly re-exported so callers don't break.

## 2. Job & state model + durability

**Record**
```
Job {
  jobId, peer, source: SourceRef, sink: SinkRef, size, sha256?,
  state, attempts, maxAttempts, bytesDone, resumeCount,
  enqueuedAt, startedAt?, endedAt?, deadlineAt,          // deadlineAt = enqueuedAt + ttlMs
  mode?, via?, error?, cancelReason?
}
SourceRef = { kind:'file', path } | { kind:'blob', dataKey|inlineId }   // 'blob' lands at W4
SinkRef   = { kind:'file', path } | { kind:'blob', dataKey }            // 'blob' lands at W4
```

**States:** `queued → active → done` · `active → retry-wait → queued` (transient failure, backoff) · `→ failed` (terminal: past maxAttempts or non-retryable) · `→ cancelled` (user) · `→ expired` (past `deadlineAt`).

**Durability (`job-store`):** each transition appends one JSONL line to `~/.cache/lm-assist/transfer-jobs-{prod|dev}.jsonl`. Boot replays all lines into a Map (last line per `jobId` wins; terminal states are sticky). **Compaction** (periodic + on trim): rewrite the file atomically (temp + rename) with one current-state line per live job, dropping terminal jobs past their retention. Append-only ⇒ crash-safe; a torn final line is skipped on replay.

## 3. Scheduler & concurrency

- **Per-peer FIFO queues** + **per-peer cap** (`PER_PEER_CAP`, default 2) + **global cap** (`GLOBAL_CAP`, default 8). `pump()` round-robins over peers with pending work, dispatching while `active[peer] < PER_PEER_CAP && globalActive < GLOBAL_CAP` — so a busy peer can't starve others (fan-out fairness), bounded globally.
- **`wait:true` is unified through the manager**: it enqueues and awaits the job's terminal promise (respecting caps), closing today's sync-bypass gotcha. If the caller's `timeoutMs` (default 120 s) elapses before the job is terminal, the call **returns `{jobId, state}` and the job keeps running async** (the caller polls `jobId`) — a sync caller never blocks for the up-to-24 h job deadline.
- Env: `LM_SEND_CONCURRENCY` (per-peer), `LM_SEND_CONCURRENCY_GLOBAL`.

## 4. Cancel (queued + in-flight, both ends)

- **queued / retry-wait** → mark `cancelled`, drop from the queue; never starts.
- **active** → the manager holds an `AbortController` per running job. `cancel(jobId)` fires it → `sendPath`'s `signal` closes the channel and stops streaming → the sender emits an **`FT_CANCEL {transferId, reason}`** control frame → the **receiver deletes the partial + sidecar**. State → `cancelled`.
- **Critical distinction:** an explicit **cancel deletes** the partial; a mere **connection drop keeps** the partial (so resume can continue). Only `FT_CANCEL` (or a TTL sweep) deletes.

## 5. Resume — hybrid by size (threshold `RESUME_MIN_BYTES`, default 8 MB)

- **< threshold:** no sidecar; on any failure/restart, the job restarts from byte 0.
- **≥ threshold:** resumable. Flow:
  1. Sender sends `FT_META` with `{ resumable:true, transferId, size, sha256 }`.
  2. Receiver, on `FT_META.resumable`, looks for `<dest>.lmpart` (`{transferId,size,sha256,bytesDone,updatedAt}`). If it matches `{transferId,size}`, it opens the file r/w, **re-reads the first `bytesDone` bytes to rebuild the running SHA**, and replies **`FT_RESUME_STATE {transferId, bytesDone}`**; else `bytesDone:0` (and discards a mismatched partial).
  3. Sender streams from `bytesDone` (`resumeFrom`), `resumeCount++`.
  4. Receiver checkpoints `bytesDone` into the sidecar every `CHECKPOINT_BYTES` (default 4 MB). On `FT_END` the full-file SHA is verified as today; on success the sidecar is deleted. Exactly-once: a fully-received `transferId` replies `FT_OK` without rewriting.
- Non-resumable paths: `FT_META.resumable` is false for small files (no handshake, unchanged flow) and for **firehose** (out-of-order UDP) transfers — a large file over firehose restarts for now (direct is fast). Firehose-bitmap resume is a deferred follow-up.

## 6. TTL & auto-clear (one sweeper per node, ~5 min, `unref`'d)

| TTL | Env / default | Effect |
|---|---|---|
| **Job deadline** | `LM_JOB_TTL_MS` / 24 h (per-job `ttlMs` override) | A job not terminal by `deadlineAt` → `expired`; if active/resumable, emit `FT_CANCEL` to clean the receiver partial. Bounds retry-forever. |
| **Terminal retention** | `LM_JOB_RETENTION_MS` / 1 h | `done\|failed\|cancelled\|expired` records auto-purged from memory + compacted out of the log. |
| **Receiver stale-partial TTL** | `LM_PARTIAL_TTL_MS` / 24 h | Receiver independently sweeps `.lmpart` partials whose `updatedAt` is older than this — no orphaned partials when a sender vanished without `FT_CANCEL`. |

Job deadline and receiver stale-partial TTL align (24 h): a partial lives exactly as long as its job may, then both ends clean up.

## 7. Error handling & retry

- **Transient** (channel error, timeout, peer offline) → `retry-wait` with exponential backoff (`0.5 s → RETRY_MAX_MS` cap, default 30 s), `maxAttempts` default 5. Peer offline **holds** the job (does not fail fast — reliability is this layer's job). Between attempts the peer is re-resolved and the path re-selected (`sendPath` already falls back direct→relay within an attempt).
- **Terminal** (source missing, receiver rejects, past `maxAttempts`, past `deadlineAt`) → `failed`/`expired` with the error + attempt trail.
- **Exactly-once completion** per `transferId` (receiver dedupes a completed id).

## 8. Wire protocol additions

New FT control messages (existing ones unchanged): `FT_RESUME_STATE {transferId, bytesDone}` (receiver→sender), `FT_CANCEL {transferId, reason}` (sender→receiver). `FT_META` gains optional `{resumable, transferId, sha256}`. Over the relay these ride the existing control/priority lane; over TCP/direct the same channel.

## 9. REST + MCP surface

- **REST:** `POST /transport/send-file` (enqueue → `{jobId,state}`; `wait:true` blocks on the job) — same API, now durable/managed. `GET /transport/jobs?peer=&state=` (list), `GET /transport/jobs/:id` (status incl. live `bytesDone/rate/eta/resumeCount`), `POST /transport/jobs/:id/cancel`. Keep `/transport/queue` + `/transport/stats`.
- **MCP:** extend `transfer_*`: add `transfer_cancel(jobId)` and `transfer_status(jobId)`; `transfer_queue` (enqueue) and `transfer_stats` stay.

## 10. Source / Sink interface (file adapter this increment)

```
interface Source { size(): Promise<number>; sha256(): Promise<string>;
                   read(offset: number, length: number): Promise<Buffer>; } // seekable ⇒ resumable
interface Sink { open(meta, resumeFrom: number): Promise<OpenSink>;
                 receivedBytes(transferId): Promise<number>; }
interface OpenSink { write(offset: number, chunk: Buffer): Promise<void>;
                     finalize(): Promise<void>; abort(): Promise<void>; }
```
`FileSource{path}` / `FileSink{path}` implement these over `fs` (current behavior). `BlobSource{dataKey}` / `BlobSink{dataKey}` (memory or data-service backed) implement the same at **W4** — a non-seekable stream source is restart-only.

## 11. Testing

- **job-store:** append/replay round-trip; compaction; torn-final-line tolerance.
- **job-manager:** per-peer + global concurrency fairness; backoff retry to `failed`; cancel (queued & active); `recover()` re-queues non-terminal jobs on boot; TTL sweeper expires overdue jobs and purges terminal past retention.
- **resume:** interrupt a ≥8 MB transfer mid-stream → resume byte-perfect + SHA match + `resumeCount>0`; <8 MB restarts; cancel deletes the partial while a drop keeps it; sidecar mismatch → clean restart.
- **integration (real fleet):** interrupt a large relay transfer 123→107 → verify resume + md5; cancel an active transfer → verify both-end cleanup; kill+restart the sender Core mid-transfer → `recover()` resumes.

## 12. Out of scope (deferred)

Data/blob Source/Sink adapter and RPC bulk-handle auto-fetch (**W4**); firehose out-of-order resume; token-bucket class priority (`control>rpc>bus>bulk`); data-type-aware compression; per-link/per-class bandwidth caps. All are named in the fabric spec §4 and layer cleanly on this engine later.
