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
  /** Optional caller-requested transport override, threaded to sendPath by the
   * default executor. Backward-compatible: an old JSONL record written before
   * this field existed loads as `undefined` ⇒ today's auto-negotiation. */
  forceMode?: 'direct' | 'relay';
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
    try { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch (e) { console.error('[job-store] append failed (durability degraded):', (e as Error).message); }
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
    } catch (e) { console.error('[job-store] compact failed:', (e as Error).message); try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
  }
}
