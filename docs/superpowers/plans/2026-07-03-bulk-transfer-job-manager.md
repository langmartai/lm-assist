# Bulk Transfer Job Manager — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the in-memory `send-queue.ts` into a durable, cancellable, resumable **bulk transfer job manager** so cross-node transfers survive peer drops and Core restarts.

**Architecture:** A payload-generic engine over the existing `sendPath` executor. New units: `job-store` (durable JSONL log), `payload` (Source/Sink + file adapter), `job-manager` (scheduler + lifecycle + cancel + retry + resume-decision + TTL sweeper). `sendPath` gains `signal` + `resumeFrom`; the receiver gains a resume sidecar + `FT_RESUME_STATE`/`FT_CANCEL`. Full design: `docs/superpowers/specs/2026-07-03-bulk-transfer-job-manager-design.md`.

**Tech Stack:** TypeScript (CommonJS, `module: commonjs` — no ESM-only imports), Node ≥20.9, `node:test` + `node:assert/strict`, build via `./core.sh build`, test build via `cd core && npm run build:test` then `node --test dist-test/...`.

## Global Constraints

- **Payload-generic:** the engine moves bytes from a `Source` to a `Sink`; the **file adapter is the only adapter this increment**. Do NOT build the data/blob adapter (that is W4).
- **Reuse `sendPath`** as the executor — modify only its signature (`signal`, `resumeFrom`) and streaming offset; do not rewrite its path/retry logic.
- **Wire-compatible:** add new FT control messages only; the existing FT_META/DATA/END/OK/ERR flow for non-resumable (`resumable` falsy) transfers must be byte-identical to today.
- **Durable + crash-safe:** append-only JSONL; no LMDB or other new heavy dependency.
- **Defaults (verbatim):** per-peer cap 2 (`LM_SEND_CONCURRENCY`), global cap 8 (`LM_SEND_CONCURRENCY_GLOBAL`), resume threshold 8 MB (`RESUME_MIN_BYTES`), checkpoint 4 MB, job deadline 24 h (`LM_JOB_TTL_MS`), terminal retention 1 h (`LM_JOB_RETENTION_MS`), receiver stale-partial 24 h (`LM_PARTIAL_TTL_MS`), maxAttempts 5, backoff 0.5 s → 30 s cap.
- **State files** are dev/prod-separated under `~/.cache/lm-assist/`: `transfer-jobs-prod.jsonl` / `transfer-jobs-dev.jsonl` (dev when `!__dirname.includes('node_modules')`).

## File Structure

| File | New/Mod | Responsibility |
|---|---|---|
| `core/src/file-transfer/types.ts` | Mod | Add `FtResumeState`, `FtCancel` to `FtControl`; add `FtMeta.resumable?/sha256?`; add `SendOpts.signal?/resumeFrom?/resumable?`. |
| `core/src/file-transfer/payload.ts` | New | `Source`/`Sink`/`OpenSink` interfaces + `FileSource`/`FileSink`. |
| `core/src/file-transfer/job-store.ts` | New | Append-only JSONL job persistence: `append`, `loadAll`, `compact`. |
| `core/src/file-transfer/sender.ts` | Mod | `sendPath` honors `opts.signal` (abort) + `opts.resumeFrom` (stream from offset) + resumable-meta handshake. |
| `core/src/file-transfer/receiver.ts` | Mod | Resume sidecar; reply `FT_RESUME_STATE` on resumable `FT_META`; `FT_CANCEL` cleanup; stale-partial sweep. |
| `core/src/file-transfer/job-manager.ts` | New (replaces `send-queue.ts`) | Scheduler, lifecycle, cancel, retry, resume-decision, TTL sweeper, `recover()`. |
| `core/src/file-transfer/send-queue.ts` | Delete | Superseded; re-export shim from `job-manager.ts` for the route. |
| `core/src/routes/core/transport.routes.ts` | Mod | `GET /transport/jobs`, `GET /transport/jobs/:id`, `POST /transport/jobs/:id/cancel`; wire enqueue to `job-manager`. |
| `core/src/mcp-server/tools/*` (transfer tools) | Mod | Add `transfer_cancel`, `transfer_status`. |

---

### Task 1: FT protocol additions (types + frame round-trip)

**Files:**
- Modify: `core/src/file-transfer/types.ts`
- Test: `core/src/file-transfer/__tests__/resume-protocol.test.ts` (new)

**Interfaces:**
- Produces: `FtResumeState { type:'FT_RESUME_STATE'; transferId:string; bytesDone:number }`, `FtCancel { type:'FT_CANCEL'; transferId:string; reason?:string }`; `FtMeta` gains `resumable?:boolean; sha256?:string`; `SendOpts` gains `signal?:AbortSignal; resumeFrom?:number; resumable?:boolean`.

- [ ] **Step 1: Write the failing test** — `resume-protocol.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeControl, FrameReader } from '../frame';
import type { FtResumeState, FtCancel } from '../types';

test('FT_RESUME_STATE and FT_CANCEL round-trip through encodeControl/FrameReader', () => {
  const reader = new FrameReader();
  const rs: FtResumeState = { type: 'FT_RESUME_STATE', transferId: 't1', bytesDone: 4096 };
  const cx: FtCancel = { type: 'FT_CANCEL', transferId: 't1', reason: 'user' };
  const frames = [...reader.push(encodeControl(rs)), ...reader.push(encodeControl(cx))];
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0].kind === 'control' && frames[0].msg, rs);
  assert.deepEqual(frames[1].kind === 'control' && frames[1].msg, cx);
});
```

- [ ] **Step 2: Run to verify it fails** — `cd core && npm run build:test 2>&1 | grep resume-protocol` → FAIL (types `FtResumeState`/`FtCancel` not exported).

- [ ] **Step 3: Add the types** in `types.ts`. After the `FtErr` interface add:

```ts
export interface FtResumeState { type: 'FT_RESUME_STATE'; transferId: string; bytesDone: number; }
export interface FtCancel { type: 'FT_CANCEL'; transferId: string; reason?: string; }
```
Add both to the `FtControl` union (append `| FtResumeState | FtCancel`). In `FtMeta` add `resumable?: boolean; sha256?: string;`. In `SendOpts` add:
```ts
  /** Abort the transfer mid-flight (job cancel). */
  signal?: AbortSignal;
  /** Resume: begin streaming the single entry at this byte offset. */
  resumeFrom?: number;
  /** Ask the receiver for its resume state before streaming (large files). */
  resumable?: boolean;
```

- [ ] **Step 4: Run test to verify it passes** — `cd core && npm run build:test && node --test dist-test/file-transfer/__tests__/resume-protocol.test.js` → PASS.

- [ ] **Step 5: Commit**
```bash
git add core/src/file-transfer/types.ts core/src/file-transfer/__tests__/resume-protocol.test.ts
git commit -m "feat(file-transfer): FT_RESUME_STATE/FT_CANCEL control frames + resume SendOpts"
```

---

### Task 2: Payload Source/Sink + file adapter

**Files:**
- Create: `core/src/file-transfer/payload.ts`
- Test: `core/src/file-transfer/__tests__/payload.test.ts`

**Interfaces:**
- Produces: `interface Source { size():Promise<number>; sha256():Promise<string>; read(offset:number,length:number):Promise<Buffer>; }`; `interface OpenSink { write(offset:number,chunk:Buffer):Promise<void>; finalize():Promise<void>; abort():Promise<void>; }`; `interface Sink { open(destPath:string,resumeFrom:number):Promise<OpenSink>; receivedBytes(destPath:string):Promise<number>; }`; classes `FileSource(path)`, `FileSink()`.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { FileSource, FileSink } from '../payload';

test('FileSource reads at offset + hashes; FileSink writes at offset + finalizes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-'));
  const src = path.join(dir, 'in.bin'); const dst = path.join(dir, 'out.bin');
  const data = Buffer.alloc(10000, 9); fs.writeFileSync(src, data);
  const s = new FileSource(src);
  assert.equal(await s.size(), 10000);
  assert.equal((await s.read(4000, 100)).length, 100);
  const sink = new FileSink();
  const open = await sink.open(dst, 0);
  await open.write(0, await s.read(0, 6000));
  await open.write(6000, await s.read(6000, 4000));
  await open.finalize();
  assert.deepEqual(fs.readFileSync(dst), data);
  assert.equal(await sink.receivedBytes(dst), 10000);
});
```

- [ ] **Step 2: Run to verify it fails** — module missing → FAIL.

- [ ] **Step 3: Implement `payload.ts`**

```ts
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as crypto from 'crypto';

export interface Source {
  size(): Promise<number>;
  sha256(): Promise<string>;
  read(offset: number, length: number): Promise<Buffer>;
}
export interface OpenSink {
  write(offset: number, chunk: Buffer): Promise<void>;
  finalize(): Promise<void>;
  abort(): Promise<void>;
}
export interface Sink {
  open(destPath: string, resumeFrom: number): Promise<OpenSink>;
  receivedBytes(destPath: string): Promise<number>;
}

export class FileSource implements Source {
  constructor(private readonly path: string) {}
  async size(): Promise<number> { return (await fsp.stat(this.path)).size; }
  async read(offset: number, length: number): Promise<Buffer> {
    const fd = await fsp.open(this.path, 'r');
    try { const buf = Buffer.allocUnsafe(length); const { bytesRead } = await fd.read(buf, 0, length, offset); return buf.subarray(0, bytesRead); }
    finally { await fd.close(); }
  }
  sha256(): Promise<string> {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256'); const rs = fs.createReadStream(this.path);
      rs.on('error', reject); rs.on('data', (d) => h.update(d)); rs.on('end', () => resolve(h.digest('hex')));
    });
  }
}

export class FileSink implements Sink {
  async receivedBytes(destPath: string): Promise<number> {
    try { return (await fsp.stat(destPath)).size; } catch { return 0; }
  }
  async open(destPath: string, resumeFrom: number): Promise<OpenSink> {
    await fsp.mkdir(require('path').dirname(destPath), { recursive: true });
    // resumeFrom>0 ⇒ keep existing bytes (r+); else truncate (w).
    const handle = await fsp.open(destPath, resumeFrom > 0 ? 'r+' : 'w');
    return {
      write: async (offset, chunk) => { await handle.write(chunk, 0, chunk.length, offset); },
      finalize: async () => { await handle.close(); },
      abort: async () => { await handle.close().catch(() => {}); await fsp.unlink(destPath).catch(() => {}); },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Commit**
```bash
git add core/src/file-transfer/payload.ts core/src/file-transfer/__tests__/payload.test.ts
git commit -m "feat(file-transfer): payload Source/Sink interfaces + file adapter"
```

---

### Task 3: Durable job store (JSONL append/replay/compact)

**Files:**
- Create: `core/src/file-transfer/job-store.ts`
- Test: `core/src/file-transfer/__tests__/job-store.test.ts`

**Interfaces:**
- Produces: `type JobRecord` (see below); `class JobStore { constructor(filePath); append(rec:JobRecord):void; loadAll():JobRecord[]; compact(live:JobRecord[]):void; }`. `jobLogPath():string` (dev/prod-separated).

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { JobStore, type JobRecord } from '../job-store';

function rec(id: string, state: JobRecord['state']): JobRecord {
  return { jobId: id, peer: 'p', source: { kind: 'file', path: '/a' }, sink: { kind: 'file', path: '/b' },
    size: 1, state, attempts: 0, maxAttempts: 5, bytesDone: 0, resumeCount: 0, enqueuedAt: 1, deadlineAt: 2 };
}

test('append then loadAll replays last-write-wins per jobId', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'js-')), 'jobs.jsonl');
  const store = new JobStore(f);
  store.append(rec('j1', 'queued'));
  store.append(rec('j1', 'active'));
  store.append(rec('j2', 'queued'));
  const all = new JobStore(f).loadAll();
  assert.equal(all.length, 2);
  assert.equal(all.find((r) => r.jobId === 'j1')!.state, 'active');
});

test('loadAll tolerates a torn final line', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'js-')), 'jobs.jsonl');
  const store = new JobStore(f); store.append(rec('j1', 'done'));
  fs.appendFileSync(f, '{"jobId":"j2","st'); // torn
  assert.equal(new JobStore(f).loadAll().length, 1);
});

test('compact rewrites to one line per live job', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'js-')), 'jobs.jsonl');
  const store = new JobStore(f);
  store.append(rec('j1', 'queued')); store.append(rec('j1', 'active')); store.append(rec('j2', 'done'));
  store.compact([rec('j1', 'active')]);
  assert.equal(fs.readFileSync(f, 'utf8').trim().split('\n').length, 1);
  assert.equal(new JobStore(f).loadAll().length, 1);
});
```

- [ ] **Step 2: Run to verify it fails** — module missing → FAIL.

- [ ] **Step 3: Implement `job-store.ts`**

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type JobState = 'queued' | 'active' | 'retry-wait' | 'done' | 'failed' | 'cancelled' | 'expired';
export type SourceRef = { kind: 'file'; path: string } | { kind: 'blob'; dataKey: string };
export type SinkRef = { kind: 'file'; path: string } | { kind: 'blob'; dataKey: string };

export interface JobRecord {
  jobId: string; peer: string; source: SourceRef; sink: SinkRef;
  size: number; sha256?: string;
  state: JobState; attempts: number; maxAttempts: number; bytesDone: number; resumeCount: number;
  enqueuedAt: number; startedAt?: number; endedAt?: number; deadlineAt: number;
  mode?: string; via?: string | null; error?: string; cancelReason?: string;
}

export function jobLogPath(): string {
  const dir = path.join(os.homedir(), '.cache', 'lm-assist');
  fs.mkdirSync(dir, { recursive: true });
  const prod = __dirname.includes('node_modules');
  return path.join(dir, prod ? 'transfer-jobs-prod.jsonl' : 'transfer-jobs-dev.jsonl');
}

export class JobStore {
  constructor(private readonly file: string = jobLogPath()) {}
  append(rec: JobRecord): void {
    try { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch { /* best-effort durability */ }
  }
  loadAll(): JobRecord[] {
    let text = ''; try { text = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const byId = new Map<string, JobRecord>();
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line) as JobRecord; if (r && r.jobId) byId.set(r.jobId, r); }
      catch { /* torn/partial line — skip */ }
    }
    return [...byId.values()];
  }
  compact(live: JobRecord[]): void {
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, live.map((r) => JSON.stringify(r)).join('\n') + (live.length ? '\n' : ''));
      fs.renameSync(tmp, this.file);
    } catch { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
  }
}
```

- [ ] **Step 4: Run test to verify it passes** — PASS (3 tests).

- [ ] **Step 5: Commit**
```bash
git add core/src/file-transfer/job-store.ts core/src/file-transfer/__tests__/job-store.test.ts
git commit -m "feat(file-transfer): durable JSONL job store (append/replay/compact)"
```

---

### Task 4: `sendPath` honors `signal` (abort) + `resumeFrom` (offset)

**Files:**
- Modify: `core/src/file-transfer/sender.ts` (streamFile call at `:208`; the `attempt`/retry loop `:152-259`)
- Test: `core/src/file-transfer/__tests__/sender-abort-resume.test.ts`

**Interfaces:**
- Consumes: `SendOpts.signal`, `SendOpts.resumeFrom` (Task 1).
- Produces: `sendPath` aborts promptly when `opts.signal` fires (rejects with a `TransferError` code `'aborted'`), and streams the single entry starting at `opts.resumeFrom`.

- [ ] **Step 1: Write the failing test** — drive a loopback transfer, abort mid-stream, assert it rejects fast; and a resumeFrom that only sends the tail. (Use the existing loopback pattern in `core/src/file-transfer/__tests__/` — a paired in-memory Channel; if none exists, build a minimal `Channel` stub whose `send/sendControl` capture frames and feed `handleIncomingTransfer`.) Assertions:

```ts
// abort: fire opts.signal after META; expect sendPath to reject with code 'aborted' within 500ms
// resume: opts.resumeFrom = 6000 on a 10000-byte file ⇒ receiver (fresh handle at offset 6000) ends with only the tail written
```

- [ ] **Step 2: Run to verify it fails** — `signal`/`resumeFrom` unused → abort hangs / resume ignored → FAIL.

- [ ] **Step 3: Implement.** In `sendPath`:
  1. Near the top of `attempt`, after `currentChannel = channel;`, add abort wiring:
     ```ts
     if (opts?.signal) {
       if (opts.signal.aborted) throw new TransferError('aborted', 'cancelled before start');
       const onAbort = () => { try { channel.close(); } catch { /* ignore */ } };
       opts.signal.addEventListener('abort', onAbort, { once: true });
       // remove in finally: opts.signal.removeEventListener('abort', onAbort);
     }
     ```
     Add the matching `removeEventListener` in the `finally` block (`:221`). A channel close mid-`await done` already rejects `done`; map that rejection to code `'aborted'` when `opts.signal.aborted` (in the retry loop `catch` at `:251`, if `opts?.signal?.aborted` set `code='aborted'`).
  2. Make `'aborted'` non-retriable: in `isRetriable`, return false for `'aborted'` (so the retry loop rethrows immediately).
  3. Pass the offset to `streamFile` for a single-entry transfer: change the `streamFile(channel, transferId, i, e.absPath, chunkSize, cb)` call (`:208`) to accept a start offset — add a 6th param `startOffset` defaulting to 0, used only when `entries.length===1`:
     ```ts
     const startOffset = (entries.length === 1 && opts?.resumeFrom) ? opts.resumeFrom : 0;
     await streamFile(channel, transferId, i, e.absPath, chunkSize, cb, startOffset);
     ```
     In `streamFile` (find its definition in this file), begin the read loop at `startOffset` (the `fs.read` position and the emitted `encodeData(..., offset, ...)` both start there); `sent` progress starts at `startOffset`.

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Commit**
```bash
git add core/src/file-transfer/sender.ts core/src/file-transfer/__tests__/sender-abort-resume.test.ts
git commit -m "feat(file-transfer): sendPath honors abort signal + resumeFrom offset"
```

---

### Task 5: Receiver — resume sidecar + FT_RESUME_STATE + FT_CANCEL

**Files:**
- Modify: `core/src/file-transfer/receiver.ts` (`handleMeta` `:129`, `handleData` `:155`, the frame dispatch `:462`, `finish`/`replyErr`)
- Test: `core/src/file-transfer/__tests__/receiver-resume-cancel.test.ts`

**Interfaces:**
- Consumes: `FtResumeState`, `FtCancel`, `FtMeta.resumable` (Task 1).
- Produces: on a `resumable` `FT_META`, the receiver replies `FT_RESUME_STATE{transferId,bytesDone}` before data; it checkpoints `bytesDone` into `<dest>.lmpart`; on `FT_CANCEL` it deletes the partial + sidecar; a completed transfer deletes the sidecar.

- [ ] **Step 1: Write the failing test** — loopback into `handleIncomingTransfer`:
  1. Send `resumable` META for an 8 MB entry, then only the first 4 MB of DATA, then drop (close). Assert `<dest>.lmpart` exists with `bytesDone≈4MB` and the partial file is kept.
  2. New channel: send the same `resumable` META; assert the receiver replies `FT_RESUME_STATE{bytesDone≈4MB}`; stream the tail; FT_END; assert file complete + sha match + sidecar gone.
  3. Send META + partial data, then `FT_CANCEL`; assert partial + sidecar deleted.

- [ ] **Step 2: Run to verify it fails** — no sidecar / no FT_RESUME_STATE / FT_CANCEL ignored → FAIL.

- [ ] **Step 3: Implement.**
  - Sidecar helpers (top of `receiver.ts`): `sidecarPath(dest)= dest + '.lmpart'`; `writeSidecar(dest,{transferId,size,sha256,bytesDone})` (JSON, `updatedAt: Date.now()`); `readSidecar(dest)`; `rmSidecar(dest)`.
  - In `handleMeta`, when `m.resumable` and a single non-dir entry: compute `dest = destFor(root,m,entry)`; read the sidecar; if it matches `{transferId:m.transferId, size}` set `resumeFrom = min(sidecar.bytesDone, existing-file-size)` else 0 (and delete a mismatched partial). Open the file `r+` (resume) or `w` (fresh) — reuse the existing `openFiles` handle logic but do NOT truncate when resuming. **Re-hash the first `resumeFrom` bytes** into the entry's `crypto.Hash` (read the partial in a loop, `hasher.update`). Seed `seenBytes[i]=resumeFrom`. Then `channel.sendControl(encodeControl({ type:'FT_RESUME_STATE', transferId:m.transferId, bytesDone:resumeFrom }))`.
  - In `handleData`, after a successful write, when the transfer is resumable, checkpoint every 4 MB: `if (seen - lastCheckpoint >= 4*1024*1024) { writeSidecar(dest,{...,bytesDone:seen}); lastCheckpoint = seen; }`.
  - In `handleEnd`, on success delete the sidecar (`rmSidecar(dest)`) after the sha check passes.
  - In the frame dispatch (`:462` switch), add `case 'FT_CANCEL': await handleCancel(msg as FtCancel); break;` where `handleCancel` closes+deletes open files, deletes the partial + sidecar, and `finish()`.
  - **Non-resumable path unchanged:** all the above is gated on `m.resumable` (falsy ⇒ today's exact behavior, no sidecar, no FT_RESUME_STATE).
  - **Stale-partial sweeper:** start an `unref`'d `setInterval` (once, module-level, ~30 min) that scans `receiveRoot()` recursively for `*.lmpart` files whose `updatedAt` is older than `LM_PARTIAL_TTL_MS` (default 24h) and deletes each sidecar + its partial file — covers senders that vanished without `FT_CANCEL`.

- [ ] **Step 4: Run test to verify it passes** — PASS (3 cases + sweeper unit test: write an old-dated `.lmpart`, invoke the sweep function directly, assert deletion).

- [ ] **Step 5: Commit**
```bash
git add core/src/file-transfer/receiver.ts core/src/file-transfer/__tests__/receiver-resume-cancel.test.ts
git commit -m "feat(file-transfer): receiver resume sidecar + FT_RESUME_STATE + FT_CANCEL cleanup"
```

---

### Task 6: Job manager (scheduler, lifecycle, cancel, retry, TTL, recover)

**Files:**
- Create: `core/src/file-transfer/job-manager.ts`
- Modify: `core/src/file-transfer/send-queue.ts` → replace body with re-exports from `job-manager` (keep `enqueueSend`, `snapshotQueue`, `getSendJob` names so the route compiles), OR delete and update the route import in Task 7.
- Test: `core/src/file-transfer/__tests__/job-manager.test.ts`

**Interfaces:**
- Consumes: `JobStore`/`JobRecord`/`jobLogPath` (Task 3); `sendPath` with `signal`/`resumeFrom`/`resumable` (Tasks 1,4); `getTransfer` (`transfer-stats`).
- Produces: `enqueueJob({peer, source, sink, ttlMs?, maxAttempts?}):string`; `cancelJob(jobId):boolean`; `getJob(jobId):JobView|null`; `snapshot():{maxConcurrent,globalActive,pending,jobs:JobView[]}`; `waitForJob(jobId, timeoutMs):Promise<JobView>`; `recover():void` (call on boot). Env: `LM_SEND_CONCURRENCY`(2), `LM_SEND_CONCURRENCY_GLOBAL`(8), `LM_JOB_TTL_MS`(24h), `LM_JOB_RETENTION_MS`(1h).

- [ ] **Step 1: Write the failing tests** (inject a fake executor so no real network — the manager takes an optional `executor(job, signal, resumeFrom)` defaulting to `sendPath`):

```ts
// (a) per-peer + global caps: enqueue 5 jobs to peerA + 5 to peerB with a slow executor;
//     assert active never exceeds 2 per peer and 8 global, and both peers make progress (fairness).
// (b) cancel queued: enqueue past the cap, cancel a still-queued job ⇒ state 'cancelled', never runs.
// (c) cancel active: executor observes the AbortSignal firing ⇒ job 'cancelled'.
// (d) retry: executor throws a retriable error twice then succeeds ⇒ attempts increments, ends 'done'.
// (e) TTL: a job with ttlMs=0 whose executor blocks ⇒ sweeper marks it 'expired'.
// (f) recover: pre-seed the JSONL log with an 'active' job ⇒ recover() re-queues it (state 'queued').
```

- [ ] **Step 2: Run to verify it fails** — module missing → FAIL.

- [ ] **Step 3: Implement `job-manager.ts`.** Core structure (complete the executor wiring + views):

```ts
import { randomUUID } from 'crypto';
import { JobStore, jobLogPath, type JobRecord, type JobState, type SourceRef, type SinkRef } from './job-store';
import { sendPath } from './sender';
import { getTransfer } from './transfer-stats';

const PER_PEER = Math.max(1, Number(process.env.LM_SEND_CONCURRENCY) || 2);
const GLOBAL = Math.max(PER_PEER, Number(process.env.LM_SEND_CONCURRENCY_GLOBAL) || 8);
const JOB_TTL = Number(process.env.LM_JOB_TTL_MS) || 24 * 3600_000;
const RETENTION = Number(process.env.LM_JOB_RETENTION_MS) || 3600_000;
const MAX_ATTEMPTS = 5;
const TERMINAL = new Set<JobState>(['done', 'failed', 'cancelled', 'expired']);

export type Executor = (job: JobRecord, signal: AbortSignal, resumeFrom: number) => Promise<{ bytes: number; mode: string; via: string | null }>;

const store = new JobStore(jobLogPath());
const jobs = new Map<string, JobRecord>();
const pendingByPeer = new Map<string, string[]>();
const activeByPeer = new Map<string, number>();
const controllers = new Map<string, AbortController>();
let globalActive = 0;
let executor: Executor = (job, signal, resumeFrom) =>
  sendPath(job.peer, (job.source as { path: string }).path, (job.sink as { path: string }).path,
    { transferId: job.jobId, signal, resumeFrom, resumable: resumeFrom > 0 || job.size >= RESUME_MIN_BYTES });

export const RESUME_MIN_BYTES = 8 * 1024 * 1024;
export function _setExecutorForTest(e: Executor): void { executor = e; }

function persist(j: JobRecord): void { store.append(j); }

export function enqueueJob(p: { peer: string; source: SourceRef; sink: SinkRef; size: number; ttlMs?: number; maxAttempts?: number }): string {
  const jobId = randomUUID(); const now = Date.now();
  const j: JobRecord = { jobId, peer: p.peer, source: p.source, sink: p.sink, size: p.size,
    state: 'queued', attempts: 0, maxAttempts: p.maxAttempts ?? MAX_ATTEMPTS, bytesDone: 0, resumeCount: 0,
    enqueuedAt: now, deadlineAt: now + (p.ttlMs ?? JOB_TTL) };
  jobs.set(jobId, j); (pendingByPeer.get(p.peer) ?? pendingByPeer.set(p.peer, []).get(p.peer)!).push(jobId);
  persist(j); pump(); return jobId;
}

function pump(): void {
  // Round-robin peers for fairness.
  let progressed = true;
  while (progressed && globalActive < GLOBAL) {
    progressed = false;
    for (const [peer, q] of pendingByPeer) {
      if (globalActive >= GLOBAL) break;
      if ((activeByPeer.get(peer) ?? 0) >= PER_PEER || q.length === 0) continue;
      const jobId = q.shift()!; const job = jobs.get(jobId);
      if (!job || TERMINAL.has(job.state) || job.state === 'cancelled') continue;
      activeByPeer.set(peer, (activeByPeer.get(peer) ?? 0) + 1); globalActive++;
      progressed = true; void runJob(job);
    }
  }
}

async function runJob(job: JobRecord): Promise<void> {
  job.state = 'active'; job.startedAt = Date.now(); job.attempts++;
  const ac = new AbortController(); controllers.set(job.jobId, ac); persist(job);
  const resumeFrom = job.bytesDone > 0 && job.size >= RESUME_MIN_BYTES ? job.bytesDone : 0;
  if (resumeFrom > 0) job.resumeCount++;
  try {
    const res = await executor(job, ac.signal, resumeFrom);
    job.state = 'done'; job.bytesDone = res.bytes; job.mode = res.mode; job.via = res.via;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (ac.signal.aborted) { job.state = 'cancelled'; }
    else if (Date.now() >= job.deadlineAt) { job.state = 'expired'; job.error = msg; }
    else if (job.attempts >= job.maxAttempts) { job.state = 'failed'; job.error = msg; }
    else { job.state = 'retry-wait'; job.error = msg;
      const backoff = Math.min(30_000, 500 * Math.pow(2, job.attempts - 1));
      setTimeout(() => { if (!TERMINAL.has(job.state)) { job.state = 'queued';
        (pendingByPeer.get(job.peer) ?? pendingByPeer.set(job.peer, []).get(job.peer)!).push(job.jobId); persist(job); pump(); } }, backoff).unref?.();
    }
  } finally {
    controllers.delete(job.jobId);
    activeByPeer.set(job.peer, Math.max(0, (activeByPeer.get(job.peer) ?? 1) - 1)); globalActive = Math.max(0, globalActive - 1);
    if (TERMINAL.has(job.state)) job.endedAt = Date.now();
    persist(job); pump();
  }
}

export function cancelJob(jobId: string, reason = 'user'): boolean {
  const job = jobs.get(jobId); if (!job || TERMINAL.has(job.state)) return false;
  job.cancelReason = reason;
  const ac = controllers.get(jobId);
  if (ac) { ac.abort(); }               // active ⇒ runJob's catch marks 'cancelled'
  else { job.state = 'cancelled'; job.endedAt = Date.now(); persist(job); // queued/retry-wait
    const q = pendingByPeer.get(job.peer); if (q) { const i = q.indexOf(jobId); if (i >= 0) q.splice(i, 1); } }
  return true;
}

export interface JobView extends Omit<JobRecord, never> { pct?: number; instantMBps?: number; avgMBps?: number; rttMs?: number | null; }
function toView(j: JobRecord): JobView {
  const live = j.state === 'active' ? getTransfer(j.jobId) : null;
  return { ...j, bytesDone: live?.bytes ?? j.bytesDone, pct: live?.pct, instantMBps: live?.instantMBps, avgMBps: live?.avgMBps, rttMs: live?.rttMs ?? null };
}
export function getJob(jobId: string): JobView | null { const j = jobs.get(jobId); return j ? toView(j) : null; }
export function snapshot() { return { maxConcurrent: PER_PEER, globalMax: GLOBAL, globalActive, pending: [...pendingByPeer.values()].reduce((a, q) => a + q.length, 0), jobs: [...jobs.values()].map(toView) }; }

export function waitForJob(jobId: string, timeoutMs: number): Promise<JobView> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => { const j = jobs.get(jobId);
      if (!j || TERMINAL.has(j.state) || Date.now() >= deadline) { resolve(toView(j ?? ({} as JobRecord))); return; }
      setTimeout(tick, 100).unref?.(); };
    tick();
  });
}

export function recover(): void {
  for (const r of store.loadAll()) {
    if (TERMINAL.has(r.state) && r.endedAt && Date.now() - r.endedAt > RETENTION) continue; // drop old terminal
    jobs.set(r.jobId, r);
    if (!TERMINAL.has(r.state)) { r.state = 'queued'; (pendingByPeer.get(r.peer) ?? pendingByPeer.set(r.peer, []).get(r.peer)!).push(r.jobId); }
  }
  compactNow(); pump();
  startSweeper();
}

let sweeper: NodeJS.Timeout | null = null;
function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const j of jobs.values()) {
      if (!TERMINAL.has(j.state) && now >= j.deadlineAt) { cancelJob(j.jobId, 'expired'); const jj = jobs.get(j.jobId); if (jj) { jj.state = 'expired'; persist(jj); } }
      if (TERMINAL.has(j.state) && j.endedAt && now - j.endedAt > RETENTION) jobs.delete(j.jobId);
    }
    compactNow();
  }, 5 * 60_000);
  sweeper.unref?.();
}
function compactNow(): void { store.compact([...jobs.values()]); }
```

  Note the `RESUME_MIN_BYTES` const must be declared before the `executor` default that references it — hoist it above the `executor` assignment. Fix ordering during implementation so tsc is clean.

- [ ] **Step 4: Run tests to verify they pass** — PASS (a–f).

- [ ] **Step 5: Commit**
```bash
git add core/src/file-transfer/job-manager.ts core/src/file-transfer/__tests__/job-manager.test.ts
git commit -m "feat(file-transfer): durable job manager — per-peer+global caps, cancel, retry, TTL, recover"
```

---

### Task 7: Wire routes + MCP; boot `recover()`; retire send-queue

**Files:**
- Modify: `core/src/routes/core/transport.routes.ts` (enqueue via `enqueueJob`; add jobs/cancel routes)
- Modify: `core/src/file-transfer/send-queue.ts` → delete; update the route + `index.ts` exports to import from `job-manager`
- Modify: boot path (where the server starts — e.g. `core/src/rest-server.ts` startup or `cli.ts runServer`) to call `recover()` once
- Modify: MCP transfer tools (find with `grep -rl "transfer_queue\|transfer_stats" core/src/mcp-server`)
- Test: `core/src/__tests__/transport-jobs.routes.test.ts` (route-handler level, executor stubbed)

**Interfaces:**
- Consumes: `enqueueJob`, `cancelJob`, `getJob`, `snapshot`, `waitForJob`, `recover` (Task 6).

- [ ] **Step 1: Write the failing test** — call the `/transport/jobs`, `/transport/jobs/:id`, `/transport/jobs/:id/cancel` handlers with a stubbed executor; assert list/status/cancel behave.

- [ ] **Step 2: Run to verify it fails** — routes 404 → FAIL.

- [ ] **Step 3: Implement.**
  - `/transport/send-file`: replace `enqueueSend(...)` with `enqueueJob({peer, source:{kind:'file',path:localPath}, sink:{kind:'file',path:remotePath}, size:<stat>, ttlMs:o.ttlMs})`. For `wait:true`: `const jobId = enqueueJob(...); const v = await waitForJob(jobId, o.timeoutMs ?? 120000); return v.state==='done' ? {success:true,data:v} : v.state==='queued'||v.state==='active' ? {success:true,data:{jobId,state:v.state}} : {success:false,error:v.error||v.state}`.
  - Add routes: `GET /transport/jobs` → `snapshot()` (optional `?peer=&state=` filter); `GET /transport/jobs/:id` → `getJob(id)`; `POST /transport/jobs/:id/cancel` → `{cancelled: cancelJob(id)}`. Keep `/transport/queue` + `/transport/stats` (map to `snapshot()`).
  - Boot: call `recover()` once at server start (idempotent; starts the sweeper).
  - MCP: add `transfer_cancel({jobId})` → POST cancel; `transfer_status({jobId})` → GET job. Register in the same tool file as `transfer_queue`.
  - Delete `send-queue.ts`; update `core/src/file-transfer/index.ts` exports.

- [ ] **Step 4: Run test + build** — `./core.sh build` clean; route test PASS.

- [ ] **Step 5: Commit**
```bash
git add -A core/src
git commit -m "feat(transport): job routes + MCP transfer_cancel/status + boot recover(); retire send-queue"
```

---

### Task 8: Integration — resume + cancel end-to-end (loopback), then real-fleet note

**Files:**
- Test: `core/src/file-transfer/__tests__/bulk-integration.test.ts`

- [ ] **Step 1: Write the test** — a real `enqueueJob` with the FILE executor over a loopback channel pair (reuse the paired-Channel harness from Task 4/5): (a) a 12 MB transfer interrupted at ~6 MB (close the channel), left to retry, resumes and completes byte-perfect with `resumeCount>0`; (b) a small (<8 MB) transfer interrupted restarts and completes; (c) `cancelJob` on an active transfer ⇒ both sides cleaned (`cancelled`, partial+sidecar gone).

- [ ] **Step 2–4: Run/iterate to green.**

- [ ] **Step 5: Commit + real-fleet validation note**
```bash
git add core/src/file-transfer/__tests__/bulk-integration.test.ts
git commit -m "test(file-transfer): bulk transfer resume + cancel end-to-end"
```
Then (manual, not a unit test): on the stage nodes, enqueue a large 123→107 relay transfer, `kill` the sender Core mid-transfer, restart, and confirm `recover()` resumes it to a byte-perfect md5; cancel an active transfer and confirm both-end cleanup. Record results in the SDD ledger.

---

## Self-Review

**Spec coverage:** durable jobs → T3; cancel both-ends → T4 (signal) + T5 (FT_CANCEL) + T6 (cancelJob); hybrid resume → T4 (resumeFrom) + T5 (sidecar/FT_RESUME_STATE) + T6 (resume-decision at `RESUME_MIN_BYTES`); per-peer+global concurrency + `wait:true` unify → T6 + T7; three TTLs → T6 sweeper (job deadline, retention) + T5 (receiver stale-partial sweep — **add to T5**: a receiver-side interval that deletes `.lmpart` older than `LM_PARTIAL_TTL_MS`); status/REST/MCP → T7; Source/Sink → T2; protocol → T1; testing → every task + T8. Payload-generic with file adapter only, data adapter deferred → honored (T2 interfaces, no blob impl).

**Gap found & fixed:** the **receiver stale-partial sweeper** (`LM_PARTIAL_TTL_MS`, 24h) is part of T5's deliverable — add a step in Task 5 to start an `unref`'d interval in the receiver module that scans the receive-root for `.lmpart` files older than the TTL and deletes them + their partials.

**Placeholder scan:** none — every step has concrete code or exact edit anchors.

**Type consistency:** `JobRecord`/`JobState`/`SourceRef`/`SinkRef` (T3) used verbatim in T6/T7; `FtResumeState`/`FtCancel` (T1) used in T4/T5; `Source`/`Sink`/`OpenSink` (T2) available for the file executor; `enqueueJob`/`cancelJob`/`getJob`/`snapshot`/`waitForJob`/`recover` (T6) consumed in T7.
