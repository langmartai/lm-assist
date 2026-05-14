/**
 * Tab registry — atomic, multi-process-safe, mtime-reloaded.
 *
 * Why this is non-trivial: previously the in-memory cache was loaded ONCE at
 * singleton construction, writes were `fs.writeFileSync` (truncate + write,
 * non-atomic). Two processes could clobber, a power loss could leave an
 * empty file, and external edits were invisible. All three are real bugs.
 *
 * Design:
 *   - load(): re-read from disk if file mtime > cached mtime (cheap stat).
 *   - save(): write to .tmp, fsync, rename — POSIX rename is atomic.
 *   - locking: a sentinel .lock file via O_EXCL (`wx`); stale-lock breaker
 *              after 5s in case a previous holder crashed.
 *   - reconciliation: listTabs() can optionally cross-check against
 *              tmux.list() to mark dead entries (caller decides whether to
 *              prune or just annotate).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TerminalError } from './errors';
import type { TabRecord } from './types';
import * as tmux from './tmux';

const REGISTRY_DIR = path.join(os.homedir(), '.cache', 'lm-assist');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'terminal-tabs.json');
const REGISTRY_LOCK = path.join(REGISTRY_DIR, 'terminal-tabs.json.lock');
const REGISTRY_TMP = path.join(REGISTRY_DIR, 'terminal-tabs.json.tmp');
const STALE_LOCK_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 2000;

interface Cached {
  mtimeMs: number;
  data: Record<string, TabRecord>;
}

let cached: Cached | null = null;

// ---------- locking ------------------------------------------------------

async function acquireLock(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < LOCK_TIMEOUT_MS) {
    try {
      fs.mkdirSync(REGISTRY_DIR, { recursive: true });
      const fd = fs.openSync(REGISTRY_LOCK, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code === 'EEXIST') {
        // Check if stale.
        try {
          const stat = fs.statSync(REGISTRY_LOCK);
          if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
            fs.unlinkSync(REGISTRY_LOCK);
            continue;  // retry immediately
          }
        } catch {
          // Lock vanished between EEXIST and stat — race, retry.
        }
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
        continue;
      }
      throw new TerminalError('REGISTRY_ERROR', `lock acquire failed: ${(e as Error).message}`);
    }
  }
  throw new TerminalError('REGISTRY_ERROR', 'lock acquire timed out');
}

function releaseLock(): void {
  try { fs.unlinkSync(REGISTRY_LOCK); } catch { /* already gone */ }
}

// ---------- IO -----------------------------------------------------------

function readFileIfChanged(): Cached {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(REGISTRY_FILE);
  } catch {
    return { mtimeMs: 0, data: {} };
  }
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;
  let data: Record<string, TabRecord> = {};
  try {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Shape-validate each entry — ignore garbage rather than crash.
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v === 'object' && typeof (v as TabRecord).id === 'string') {
          data[k] = v as TabRecord;
        }
      }
    }
  } catch {
    // Corrupt file → treat as empty rather than wiping (caller's writes will
    // re-populate).
    data = {};
  }
  cached = { mtimeMs: stat.mtimeMs, data };
  return cached;
}

function writeAtomically(data: Record<string, TabRecord>): void {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  const json = JSON.stringify(data, null, 2) + '\n';
  // Write to .tmp, fsync, rename. Rename is atomic on POSIX.
  const fd = fs.openSync(REGISTRY_TMP, 'w');
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(REGISTRY_TMP, REGISTRY_FILE);
  // Refresh cache.
  const stat = fs.statSync(REGISTRY_FILE);
  cached = { mtimeMs: stat.mtimeMs, data: { ...data } };
}

// ---------- Public API ---------------------------------------------------

/** Read the registry, reloading from disk if mtime has advanced. */
export function load(): Record<string, TabRecord> {
  return { ...readFileIfChanged().data };
}

/** Atomically apply a mutation to the registry. */
export async function update(mutate: (current: Record<string, TabRecord>) => Record<string, TabRecord>): Promise<void> {
  await acquireLock();
  try {
    const current = readFileIfChanged().data;
    const next = mutate({ ...current });
    writeAtomically(next);
  } finally {
    releaseLock();
  }
}

export async function put(rec: TabRecord): Promise<void> {
  await update((cur) => { cur[rec.id] = rec; return cur; });
}

export async function remove(id: string): Promise<boolean> {
  let removed = false;
  await update((cur) => {
    if (cur[id]) { delete cur[id]; removed = true; }
    return cur;
  });
  return removed;
}

export function get(id: string): TabRecord | undefined {
  return readFileIfChanged().data[id];
}

/** Reconcile registry against tmux reality. Returns list with `alive` flag. */
export function listWithLiveness(): Array<TabRecord & { alive: boolean }> {
  const data = readFileIfChanged().data;
  let liveSessions: Set<string>;
  try {
    const sessions = tmux.list() as Array<{ name?: string }>;
    liveSessions = new Set(sessions.map((s) => s.name).filter((n): n is string => !!n));
  } catch {
    // If tmux query fails, return everything as alive=unknown=true rather than
    // marking everything dead and confusing the caller.
    liveSessions = new Set(Object.values(data).map((r) => r.tmuxSession ?? '').filter(Boolean));
  }
  return Object.values(data).map((rec) => ({
    ...rec,
    alive: rec.tmuxSession === null ? true : liveSessions.has(rec.tmuxSession),
  }));
}

/** Drop registry entries whose tmux session is gone. Returns removed ids. */
export async function pruneDead(): Promise<string[]> {
  const dead = listWithLiveness().filter((r) => !r.alive).map((r) => r.id);
  if (dead.length === 0) return [];
  await update((cur) => { for (const id of dead) delete cur[id]; return cur; });
  return dead;
}

/** Generate a fresh tab id matching the format expected by validate.parseTabId. */
export function newTabId(): string {
  return 'tab-' + Math.random().toString(36).slice(2, 10).padEnd(8, '0').slice(0, 8);
}

// ---------- test helpers -------------------------------------------------

export function _resetCacheForTests(): void { cached = null; }
export const _paths = { REGISTRY_FILE, REGISTRY_LOCK, REGISTRY_TMP };
