// core/src/data/backends/sql-backend.ts
// Main-thread proxy for the `sql` backend. better-sqlite3 is SYNCHRONOUS and would
// block the shared :3100 event loop for a query's full duration, so all execution is
// offloaded to a dedicated worker thread (sql-worker.ts → sql-engine.ts). This class
// is a thin message-passing RPC: it stays on the main thread, resolves registry-derived
// config (indexedFor), and awaits the worker's reply. The StorageBackend methods are
// already async, so callers are unchanged — they now just don't block the loop.
//
// The worker is spawned LAZILY on first use (a node with no sql dataset never spawns it)
// and is unref'd so it can't keep the process alive. If it dies, pending calls reject and
// the next call respawns it (mirrors the embedder-worker lifecycle).
import * as path from 'path';
import { Worker } from 'worker_threads';
import type {
  StorageBackend, BackendKind, DatasetDescriptor, DataRecord, QuerySpec, NodeOrigin, SqlConfig,
} from '../types';
import { getDataDir } from '../../utils/path-utils';
import { getDatasetRegistry } from '../dataset-registry';

function isSafeFieldPath(p: string): boolean { return /^[A-Za-z0-9_.]+$/.test(p); }

export class SqlBackend implements StorageBackend {
  readonly kind: BackendKind = 'sql';
  private storeDirOverride?: string;
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(storeDirOverride?: string) { this.storeDirOverride = storeDirOverride; }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(path.join(__dirname, 'sql-worker.js'), {
      workerData: { storeDirOverride: this.storeDirOverride },
      env: { ...process.env, LM_ASSIST_DATA_DIR: getDataDir() }, // worker resolves sqlDirFor() identically to main
    });
    w.on('message', (m: any) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (this.pending.size === 0) w.unref(); // idle → let the process exit; re-ref'd on the next call
      if (m.ok) p.resolve(m.result);
      else { const e = new Error(m.error); if (m.code) (e as any).code = m.code; p.reject(e); }
    });
    const failAll = (err: Error) => {
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.worker = null; // respawn on next call
    };
    w.on('error', (err) => failAll(err instanceof Error ? err : new Error(String(err))));
    w.on('exit', (code) => { if (code !== 0) failAll(new Error(`sql worker exited (code ${code})`)); else this.worker = null; });
    w.unref();
    this.worker = w;
    return w;
  }

  private call<T>(method: string, args: unknown[]): Promise<T> {
    const w = this.ensureWorker();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.ref(); // keep the event loop alive while a call is in flight (unref'd again when idle)
      w.postMessage({ id, method, args });
    });
  }

  /** Registry lookup stays on the main thread; the resolved indexed-field set is passed to the worker. */
  private indexedFor(dataset: string): string[] {
    const d = getDatasetRegistry().get(dataset);
    const c = d?.config as SqlConfig | undefined;
    return (c?.indexedFields || []).filter((f) => isSafeFieldPath(f.path)).map((f) => f.path);
  }

  createDataset(d: DatasetDescriptor): Promise<void> { return this.call('createDataset', [d]); }
  dropDataset(id: string): Promise<void> { return this.call('dropDataset', [id]); }
  get(dataset: string, id: string): Promise<DataRecord | null> { return this.call('get', [dataset, id]); }
  put(dataset: string, record: DataRecord): Promise<{ id: string }> { return this.call('put', [dataset, record]); }
  query(dataset: string, q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }> {
    return this.call('query', [dataset, q, this.indexedFor(dataset)]);
  }
  delete(dataset: string, id: string): Promise<boolean> { return this.call('delete', [dataset, id]); }
  exportSince(dataset: string, since?: string): Promise<DataRecord[]> { return this.call('exportSince', [dataset, since]); }
  importBatch(dataset: string, records: DataRecord[], origin: NodeOrigin): Promise<{ applied: number; skipped: number }> {
    return this.call('importBatch', [dataset, records, origin]);
  }
  admin(dataset: string, op: string, args?: Record<string, unknown>): Promise<unknown> { return this.call('admin', [dataset, op, args]); }
  /** Now async (runs on the worker). data-service.rawSql awaits it. */
  rawSelect(dataset: string, sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
    return this.call('rawSelect', [dataset, sql, params]);
  }
}
