// core/src/worker-role/worker-store.ts
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../utils/path-utils';
import type { WorkerRecord } from './types';

function dataDir(): string { return process.env.LM_ASSIST_DATA_DIR || getDataDir(); }
function storeFile(): string { return path.join(dataDir(), 'workers.json'); }

function readAll(): Record<string, WorkerRecord> {
  try { return JSON.parse(fs.readFileSync(storeFile(), 'utf-8')) as Record<string, WorkerRecord>; }
  catch { return {}; }
}

function writeAll(map: Record<string, WorkerRecord>): void {
  const f = storeFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 });
  fs.renameSync(tmp, f);                 // atomic replace
}

export function getRecord(sessionId: string): WorkerRecord | null {
  return readAll()[sessionId] ?? null;
}

export function listRecords(): WorkerRecord[] {
  return Object.values(readAll());
}

export function putRecord(rec: WorkerRecord): WorkerRecord {
  const map = readAll();
  map[rec.sessionId] = rec;
  writeAll(map);
  return rec;
}

export function deleteRecord(sessionId: string): void {
  const map = readAll();
  delete map[sessionId];
  writeAll(map);
}

/** Mark `orchestratorId` as the worker's orchestrator and refresh its lastContact. */
export function stampOrchestrator(sessionId: string, orchestratorId: string, now: number): WorkerRecord | null {
  const rec = getRecord(sessionId);
  if (!rec) return null;
  rec.orchestrator = { id: orchestratorId, lastContact: now };
  rec.updatedAt = now;
  return putRecord(rec);
}
