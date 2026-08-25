// core/src/search/prompt-index-service.ts
// Keeps the prompt FTS index current: a live tail on the session watcher, plus a
// bounded backfill for everything already on disk.
//
// Two rules shape this file.
//
// 1. THE API IS NOT IN THE LOOP. The one automation here that works — the session
//    cache's own summary watcher — writes straight through on the chokidar event. Its
//    twin, which detected changes and then relied on a separate manual step, has been
//    dead since 2026-04-19. So indexing hangs directly off onFileEvent and touches no
//    HTTP surface.
// 2. NOTHING REBUILDS ON A SEARCH. lm-assist alone has ~1064 sessions with transcripts
//    up to 23k turns. The backfill is incremental, resumable across restarts via the
//    on-disk watermarks, and yields between files so it cannot monopolise the loop.
import * as fs from 'fs';
import * as path from 'path';
import { getSessionCache } from '../session-cache';
import { getProjectsDir } from '../utils/path-utils';
import { getPromptIndex, PromptIndex, isIndexableSessionFile } from './prompt-index';
import { getMemoryIndex } from './memory-index';

/** Files per batch before yielding back to the event loop during backfill. */
const BACKFILL_BATCH = 25;
/** Pause between batches — keeps a cold start from saturating a busy node. */
const BACKFILL_PAUSE_MS = 50;
/** Coalescing window for a chatty live session. */
const LIVE_DEBOUNCE_MS = 1500;
/** How often local memory files are re-scanned (stat-gated, so a no-op when unchanged). */
const MEMORY_REFRESH_MS = 5 * 60 * 1000;

let started = false;
let backfill: { total: number; done: number; running: boolean } = { total: 0, done: 0, running: false };

export function promptIndexProgress(): { total: number; done: number; running: boolean } {
  return { ...backfill };
}

/** Every session transcript on this node (project dirs one level down). */
function listSessionFiles(): string[] {
  const root = getProjectsDir();
  const out: string[] = [];
  let dirs: string[];
  try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    const p = path.join(root, d);
    try {
      if (!fs.statSync(p).isDirectory()) continue;
      for (const f of fs.readdirSync(p)) {
        const full = path.join(p, f);
        if (isIndexableSessionFile(full)) out.push(full);
      }
    } catch { /* unreadable project dir — skip */ }
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); if (typeof t.unref === 'function') t.unref(); });

/**
 * Index everything not already at its watermark. Safe to run at boot: a file already
 * indexed to EOF costs one stat() and returns immediately.
 */
export async function runBackfill(index: PromptIndex = getPromptIndex()): Promise<{ files: number; prompts: number }> {
  if (backfill.running) return { files: backfill.done, prompts: 0 };
  const files = listSessionFiles();
  backfill = { total: files.length, done: 0, running: true };
  let prompts = 0;
  try {
    await index.init();
    for (let i = 0; i < files.length; i++) {
      try { prompts += await index.indexFile(files[i]); } catch { /* one bad file must not stop the pass */ }
      backfill.done = i + 1;
      if ((i + 1) % BACKFILL_BATCH === 0) await sleep(BACKFILL_PAUSE_MS);
    }
    index.flushState();
  } finally {
    backfill.running = false;
  }
  return { files: files.length, prompts };
}

/**
 * Subscribe to the live session watcher and kick off the backfill.
 * Idempotent — a second call is a no-op.
 */
export function startPromptIndexService(): void {
  if (started) return;
  started = true;
  const index = getPromptIndex();

  const pending = new Map<string, NodeJS.Timeout>();
  const flush = (filePath: string) => {
    pending.delete(filePath);
    // Fire-and-forget: an indexing failure must never propagate into the watcher.
    index.indexFile(filePath).catch(() => { /* next event retries from the same watermark */ });
  };

  try {
    getSessionCache().onFileEvent((event, filePath) => {
      if (event === 'unlink') return;          // watermark is harmless; rows stay queryable
      // Same predicate the backfill uses — the two must never disagree about what counts
      // as a session, or a result depends on how the file happened to be discovered.
      if (!isIndexableSessionFile(filePath)) return;
      const existing = pending.get(filePath);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => flush(filePath), LIVE_DEBOUNCE_MS);
      if (typeof t.unref === 'function') t.unref();
      pending.set(filePath, t);
    });
  } catch { /* no cache/watcher in this process — backfill still runs */ }

  // Detached: boot must not wait on it. A failure here (typically better-sqlite3 missing
  // on this node) leaves search on the text-scan fallback, which says so — but log it once
  // so the cause is visible without having to infer it from a search response.
  runBackfill(index).catch((e) => {
    console.error('[PromptIndex] backfill failed:', e?.message || e);
  });

  // Memory files are a few hundred small documents, stat-gated, so this is cheap enough
  // to run on the same boot and again periodically — they are REWRITTEN in place rather
  // than appended, so there is no watcher tail to follow.
  const refreshMemory = () => {
    getMemoryIndex().refresh().catch((e) => {
      console.error('[MemoryIndex] refresh failed:', e?.message || e);
    });
  };
  refreshMemory();
  const memTimer = setInterval(refreshMemory, MEMORY_REFRESH_MS);
  if (typeof memTimer.unref === 'function') memTimer.unref();
}

/** Tests only. */
export function resetPromptIndexService(): void { started = false; backfill = { total: 0, done: 0, running: false }; }
