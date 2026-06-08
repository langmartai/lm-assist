/**
 * Send queue — file/dir sends are enqueued and processed asynchronously so the
 * caller returns immediately with a jobId instead of blocking for the whole
 * transfer. Up to LM_SEND_CONCURRENCY (default 2) jobs run at once; the rest
 * wait. Each job runs sendPath with transferId = jobId, so /transport/stats live
 * metrics line up with the queue job.
 */
import { randomUUID } from 'crypto';
import { sendPath } from './sender';
import { getTransfer } from './transfer-stats';
import type { SendOpts } from './types';

export type SendJobState = 'queued' | 'active' | 'done' | 'failed';

interface SendJob {
  jobId: string;
  peerGatewayId: string;
  localPath: string;
  remotePath: string;
  opts?: SendOpts;
  state: SendJobState;
  enqueuedAt: number;
  startedAt?: number;
  endedAt?: number;
  bytes?: number;
  mode?: string;
  via?: string | null;
  error?: string;
}

const jobs = new Map<string, SendJob>();
const order: string[] = []; // jobIds in arrival order
const pending: string[] = []; // queued jobIds awaiting a slot
let activeCount = 0;
const MAX_CONCURRENT = Math.max(1, Number(process.env.LM_SEND_CONCURRENCY) || 2);
const KEEP_FINISHED = 200;

export function enqueueSend(p: {
  peerGatewayId: string;
  localPath: string;
  remotePath: string;
  opts?: SendOpts;
}): string {
  const jobId = randomUUID();
  jobs.set(jobId, {
    jobId,
    peerGatewayId: p.peerGatewayId,
    localPath: p.localPath,
    remotePath: p.remotePath,
    opts: p.opts,
    state: 'queued',
    enqueuedAt: Date.now(),
  });
  order.push(jobId);
  pending.push(jobId);
  trimFinished();
  pump();
  return jobId;
}

function trimFinished(): void {
  while (order.length > KEEP_FINISHED) {
    const id = order[0];
    const j = jobs.get(id);
    if (j && (j.state === 'done' || j.state === 'failed')) {
      jobs.delete(id);
      order.shift();
    } else {
      break;
    }
  }
}

function pump(): void {
  while (activeCount < MAX_CONCURRENT && pending.length > 0) {
    const jobId = pending.shift()!;
    const job = jobs.get(jobId);
    if (!job) continue;
    activeCount += 1;
    void runJob(job);
  }
}

async function runJob(job: SendJob): Promise<void> {
  job.state = 'active';
  job.startedAt = Date.now();
  try {
    const res = await sendPath(job.peerGatewayId, job.localPath, job.remotePath, {
      ...job.opts,
      transferId: job.jobId,
    });
    job.state = 'done';
    job.bytes = res.bytes;
    job.mode = res.mode;
    job.via = res.via;
  } catch (e) {
    job.state = 'failed';
    job.error = e instanceof Error ? e.message : String(e);
  } finally {
    job.endedAt = Date.now();
    activeCount -= 1;
    pump();
  }
}

export interface SendJobView {
  jobId: string;
  peerGatewayId: string;
  localPath: string;
  remotePath: string;
  state: SendJobState;
  enqueuedAt: number;
  startedAt?: number;
  endedAt?: number;
  bytes?: number;
  totalBytes?: number;
  pct?: number;
  instantMBps?: number;
  avgMBps?: number;
  rttMs?: number | null;
  mode?: string;
  via?: string | null;
  error?: string;
}

function toView(j: SendJob): SendJobView {
  const live = j.state === 'active' ? getTransfer(j.jobId) : null;
  return {
    jobId: j.jobId,
    peerGatewayId: j.peerGatewayId,
    localPath: j.localPath,
    remotePath: j.remotePath,
    state: j.state,
    enqueuedAt: j.enqueuedAt,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    bytes: j.bytes ?? live?.bytes,
    totalBytes: live?.totalBytes,
    pct: live?.pct,
    instantMBps: live?.instantMBps,
    avgMBps: live?.avgMBps,
    rttMs: live?.rttMs ?? null,
    mode: j.mode ?? live?.mode,
    via: j.via ?? (live?.via ?? null),
    error: j.error,
  };
}

export function snapshotQueue(): {
  maxConcurrent: number;
  active: number;
  pending: number;
  jobs: SendJobView[];
} {
  return {
    maxConcurrent: MAX_CONCURRENT,
    active: activeCount,
    pending: pending.length,
    jobs: order.map((id) => jobs.get(id)).filter((j): j is SendJob => !!j).map(toView),
  };
}

export function getSendJob(jobId: string): SendJobView | null {
  const j = jobs.get(jobId);
  return j ? toView(j) : null;
}
