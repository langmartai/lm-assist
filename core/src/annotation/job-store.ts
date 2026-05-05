/**
 * In-memory job tracking for async annotation runs.
 * Jobs survive the process lifetime only — if you need persistence, add a
 * JSON-on-disk backing store.
 */
import { randomUUID } from 'crypto';
import type { AnnotatorJobStatus } from './types';

const jobs = new Map<string, AnnotatorJobStatus>();

export function createJob(init: Omit<AnnotatorJobStatus, 'id' | 'status' | 'createdAt'>): AnnotatorJobStatus {
  const id = randomUUID();
  const job: AnnotatorJobStatus = {
    id,
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...init,
  };
  jobs.set(id, job);
  return job;
}

export function updateJob(id: string, patch: Partial<AnnotatorJobStatus>): AnnotatorJobStatus | undefined {
  const j = jobs.get(id);
  if (!j) return undefined;
  Object.assign(j, patch);
  return j;
}

export function getJob(id: string): AnnotatorJobStatus | undefined {
  return jobs.get(id);
}

export function listJobs(opts: { sessionId?: string; limit?: number } = {}): AnnotatorJobStatus[] {
  let all = Array.from(jobs.values());
  if (opts.sessionId) all = all.filter((j) => j.sessionId === opts.sessionId);
  all.sort((a, b) => (b.createdAt.localeCompare(a.createdAt)));
  if (opts.limit) all = all.slice(0, opts.limit);
  return all;
}
