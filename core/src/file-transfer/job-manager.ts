/**
 * Job manager — durable scheduler for file-transfer sends (Task 6 of the
 * bulk-transfer-job-manager plan).
 *
 * Wraps sendPath as the executor and adds what a raw fire-and-forget send
 * doesn't have: per-peer + global concurrency caps with round-robin fairness,
 * cancellation (queued or mid-flight), backoff retry, a per-job TTL deadline,
 * terminal-job retention, and crash recovery (recover() replays the durable
 * JSONL log on boot and re-queues anything that wasn't finished).
 *
 * State is process-singleton module state (jobs/pendingByPeer/activeByPeer/
 * controllers), the same shape as the send-queue.ts this replaces — there's
 * exactly one scheduler per process. Tests substitute the executor
 * (_setExecutorForTest) and the durable store (_setStoreForTest) instead of
 * hitting the real network / the real ~/.cache/lm-assist log; see
 * job-manager.test.ts and task-6-report.md.
 */
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

// Hoisted above the `executor` default below (which references it) — the
// brief's original transcription declared this *after* the default executor
// assignment that used it, a TS "used before declaration" error.
export const RESUME_MIN_BYTES = 8 * 1024 * 1024;

export type Executor = (
  job: JobRecord,
  signal: AbortSignal,
  resumeFrom: number,
) => Promise<{ bytes: number; mode: string; via: string | null }>;

/** SourceRef/SinkRef also cover `{kind:'blob'}` (data-service refs); the
 * executor here only ever wraps sendPath, which needs a local filesystem
 * path, so narrow explicitly rather than casting the whole union. */
function localPathOf(ref: SourceRef | SinkRef): string {
  if (ref.kind === 'file') return ref.path;
  throw new Error(`job-manager: blob ${ref.kind === 'blob' ? ref.dataKey : ''} refs are not yet supported by the sendPath executor`);
}

let store = new JobStore(jobLogPath());
/** Test-only seam: redirect the durable log to an isolated file so tests
 * never append to (or replay) the real ~/.cache/lm-assist log. Production
 * never calls this — mirrors _setExecutorForTest below. */
export function _setStoreForTest(s: JobStore): void {
  store = s;
}

const jobs = new Map<string, JobRecord>();
const pendingByPeer = new Map<string, string[]>();
const activeByPeer = new Map<string, number>();
const controllers = new Map<string, AbortController>();
let globalActive = 0;

let executor: Executor = async (job, signal, resumeFrom) => {
  const res = await sendPath(job.peer, localPathOf(job.source), localPathOf(job.sink), {
    transferId: job.jobId,
    signal,
    resumeFrom,
    resumable: resumeFrom > 0 || job.size >= RESUME_MIN_BYTES,
  });
  // SendResult's mode/via are optional; Executor's are not (mode always
  // reflects the channel that finished the transfer) — default rather than
  // let `undefined` leak into a field typed as required `string`.
  return { bytes: res.bytes, mode: res.mode ?? 'unknown', via: res.via ?? null };
};
export function _setExecutorForTest(e: Executor): void {
  executor = e;
}

function persist(j: JobRecord): void {
  store.append(j);
}

/** get-or-create the pending queue for a peer and push a jobId onto it. */
function pushPending(peer: string, jobId: string): void {
  let q = pendingByPeer.get(peer);
  if (!q) {
    q = [];
    pendingByPeer.set(peer, q);
  }
  q.push(jobId);
}

export function enqueueJob(p: {
  peer: string;
  source: SourceRef;
  sink: SinkRef;
  size: number;
  ttlMs?: number;
  maxAttempts?: number;
}): string {
  const jobId = randomUUID();
  const now = Date.now();
  const j: JobRecord = {
    jobId,
    peer: p.peer,
    source: p.source,
    sink: p.sink,
    size: p.size,
    state: 'queued',
    attempts: 0,
    maxAttempts: p.maxAttempts ?? MAX_ATTEMPTS,
    bytesDone: 0,
    resumeCount: 0,
    enqueuedAt: now,
    deadlineAt: now + (p.ttlMs ?? JOB_TTL),
  };
  jobs.set(jobId, j);
  pushPending(p.peer, jobId);
  persist(j);
  pump();
  return jobId;
}

function pump(): void {
  // Round-robin peers for fairness: each pass through pendingByPeer starts
  // at most one job per peer, so no single peer can monopolize the global
  // cap while others still have work waiting.
  let progressed = true;
  while (progressed && globalActive < GLOBAL) {
    progressed = false;
    for (const [peer, q] of pendingByPeer) {
      if (globalActive >= GLOBAL) break;
      if ((activeByPeer.get(peer) ?? 0) >= PER_PEER || q.length === 0) continue;
      const jobId = q.shift()!;
      const job = jobs.get(jobId);
      if (!job || TERMINAL.has(job.state)) continue;
      activeByPeer.set(peer, (activeByPeer.get(peer) ?? 0) + 1);
      globalActive++;
      progressed = true;
      void runJob(job);
    }
  }
}

async function runJob(job: JobRecord): Promise<void> {
  job.state = 'active';
  job.startedAt = Date.now();
  job.attempts++;
  const ac = new AbortController();
  controllers.set(job.jobId, ac);
  persist(job);
  const resumeFrom = job.bytesDone > 0 && job.size >= RESUME_MIN_BYTES ? job.bytesDone : 0;
  if (resumeFrom > 0) job.resumeCount++;
  try {
    const res = await executor(job, ac.signal, resumeFrom);
    job.state = 'done';
    job.bytesDone = res.bytes;
    job.mode = res.mode;
    job.via = res.via;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Guard against a late-arriving executor settlement racing a terminal
    // state already assigned by someone else (the TTL sweeper force-expires
    // a stuck job synchronously and does not wait for its executor promise
    // to ever settle — see cancelJob/sweepOnce). Once a job is terminal,
    // a subsequent rejection here must be a no-op, not a re-derivation that
    // could stomp e.g. 'expired' back to 'cancelled'.
    if (!TERMINAL.has(job.state)) {
      if (ac.signal.aborted) {
        // Disambiguate *why* the signal fired via cancelReason (set by
        // cancelJob before it calls abort()) rather than collapsing every
        // abort to 'cancelled' — a TTL-triggered abort should still land on
        // 'expired' even for an executor that responds to the signal.
        job.state = job.cancelReason === 'expired' ? 'expired' : 'cancelled';
      } else if (Date.now() >= job.deadlineAt) {
        job.state = 'expired';
        job.error = msg;
      } else if (job.attempts >= job.maxAttempts) {
        job.state = 'failed';
        job.error = msg;
      } else {
        job.state = 'retry-wait';
        job.error = msg;
        const backoff = Math.min(30_000, 500 * Math.pow(2, job.attempts - 1));
        const t = setTimeout(() => {
          if (!TERMINAL.has(job.state)) {
            job.state = 'queued';
            pushPending(job.peer, job.jobId);
            persist(job);
            pump();
          }
        }, backoff);
        t.unref?.();
      }
    }
  } finally {
    controllers.delete(job.jobId);
    activeByPeer.set(job.peer, Math.max(0, (activeByPeer.get(job.peer) ?? 1) - 1));
    globalActive = Math.max(0, globalActive - 1);
    if (TERMINAL.has(job.state)) job.endedAt = Date.now();
    persist(job);
    pump();
  }
}

export function cancelJob(jobId: string, reason = 'user'): boolean {
  const job = jobs.get(jobId);
  if (!job || TERMINAL.has(job.state)) return false;
  job.cancelReason = reason;
  const ac = controllers.get(jobId);
  if (ac) {
    ac.abort(); // active ⇒ runJob's catch marks the terminal state once the executor settles
  } else {
    // queued / retry-wait: finalize immediately, no executor is running.
    job.state = reason === 'expired' ? 'expired' : 'cancelled';
    job.endedAt = Date.now();
    persist(job);
    const q = pendingByPeer.get(job.peer);
    if (q) {
      const i = q.indexOf(jobId);
      if (i >= 0) q.splice(i, 1);
    }
  }
  return true;
}

export interface JobView extends JobRecord {
  pct?: number;
  instantMBps?: number;
  avgMBps?: number;
  rttMs?: number | null;
}

function toView(j: JobRecord): JobView {
  const live = j.state === 'active' ? getTransfer(j.jobId) : null;
  return {
    ...j,
    bytesDone: live?.bytes ?? j.bytesDone,
    pct: live?.pct,
    instantMBps: live?.instantMBps,
    avgMBps: live?.avgMBps,
    rttMs: live?.rttMs ?? null,
  };
}

export function getJob(jobId: string): JobView | null {
  const j = jobs.get(jobId);
  return j ? toView(j) : null;
}

export function snapshot(): {
  maxConcurrent: number;
  globalMax: number;
  globalActive: number;
  pending: number;
  jobs: JobView[];
} {
  return {
    maxConcurrent: PER_PEER,
    globalMax: GLOBAL,
    globalActive,
    pending: [...pendingByPeer.values()].reduce((a, q) => a + q.length, 0),
    jobs: [...jobs.values()].map(toView),
  };
}

export function waitForJob(jobId: string, timeoutMs: number): Promise<JobView> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      const j = jobs.get(jobId);
      if (!j || TERMINAL.has(j.state) || Date.now() >= deadline) {
        resolve(toView(j ?? ({} as JobRecord)));
        return;
      }
      const t = setTimeout(tick, 100);
      t.unref?.();
    };
    tick();
  });
}

export function recover(): void {
  for (const r of store.loadAll()) {
    if (TERMINAL.has(r.state) && r.endedAt && Date.now() - r.endedAt > RETENTION) continue; // drop old terminal
    jobs.set(r.jobId, r);
    if (!TERMINAL.has(r.state)) {
      r.state = 'queued';
      pushPending(r.peer, r.jobId);
    }
  }
  compactNow();
  pump();
  startSweeper();
}

/** The sweep body, extracted so both the periodic interval and the
 * synchronous test seam (_sweepNowForTest) run identical logic. */
function sweepOnce(): void {
  const now = Date.now();
  for (const j of jobs.values()) {
    if (!TERMINAL.has(j.state) && now >= j.deadlineAt) {
      cancelJob(j.jobId, 'expired');
      // cancelJob only calls abort() for an *active* job — finalizing its
      // state is normally left to runJob's catch, once the executor promise
      // actually settles. A stuck/non-cooperative executor may never settle,
      // so the scheduler's own bookkeeping must not wait on it indefinitely:
      // force the terminal state here too. (No-op if cancelJob's own
      // queued/retry-wait branch already finalized it above.)
      if (!TERMINAL.has(j.state)) {
        j.state = 'expired';
        j.endedAt = Date.now();
        persist(j);
      }
    }
    if (TERMINAL.has(j.state) && j.endedAt && now - j.endedAt > RETENTION) {
      jobs.delete(j.jobId);
    }
  }
  compactNow();
}

/** Test-only seam: run the sweep synchronously instead of waiting for the
 * 5-minute interval. Production never calls this — mirrors
 * _setExecutorForTest / _setStoreForTest above. */
export function _sweepNowForTest(): void {
  sweepOnce();
}

let sweeper: NodeJS.Timeout | null = null;
function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(sweepOnce, 5 * 60_000);
  sweeper.unref?.();
}

function compactNow(): void {
  store.compact([...jobs.values()]);
}
