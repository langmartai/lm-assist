// core/src/data/backends/sql-worker.ts
// Dedicated worker thread that owns all better-sqlite3 (synchronous) execution.
// The main-thread SqlBackend proxy (sql-backend.ts) posts {id, method, args}; we run
// the op on the SqlEngine (blocking is fine HERE — it's not the main loop) and post
// back {id, ok, result} / {id, ok:false, error}. One worker serializes SQL ops, which
// is correct for better-sqlite3 and keeps the :3100 event loop free.
import { parentPort, workerData } from 'worker_threads';
import { SqlEngine } from './sql-engine';

const engine = new SqlEngine((workerData as any)?.storeDirOverride);

parentPort?.on('message', async (m: { id: number; method: string; args: unknown[] }) => {
  try {
    const fn = (engine as unknown as Record<string, (...a: unknown[]) => unknown>)[m.method];
    if (typeof fn !== 'function') throw new Error(`unknown sql method: ${m.method}`);
    const result = await fn.apply(engine, m.args || []);
    parentPort?.postMessage({ id: m.id, ok: true, result });
  } catch (e) {
    parentPort?.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e), code: (e as any)?.code });
  }
});
