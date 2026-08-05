/**
 * thread -> labels, derived from the surface that actually works.
 *
 * 🔴 WHY THIS EXISTS. The per-row label chip (`SELECTORS_EXT.rowLabelChip`, marked
 * CANDIDATE and never verified) returns nothing. MEASURED 2026-08-02 in a single
 * page evaluation, so both readings describe the same rows at the same instant:
 *
 *     idx | subject        | extractor | DOM chips
 *       6 | Security alert | []        | ["HY: Microsoft"]
 *
 * The thread-view chip path returns empty for the same threads. So BOTH chip
 * scrapes are unreliable, and `labels: []` has been indistinguishable from "this
 * thread has no labels" — the worst kind of wrong, because it reads as a fact.
 *
 * But the INVERSE direction is solid and proven in daily use: `label:"X"` search
 * and the `#label/X` view both return exactly the right threads, every time. Label
 * membership is knowable; we were simply asking from the wrong end.
 *
 * So this walks labels and records which threads each one holds, giving an index
 * that answers thread -> labels by lookup instead of by scraping a chip that may
 * not render.
 *
 * 🔴 IT IS AN INDEX, AND IT LAGS. It is only as fresh as its last refresh, and it
 * is BOUNDED — `perLabel` threads per label. Both facts are reported with every
 * answer rather than hidden, because a stale or truncated index that presents
 * itself as complete would recreate the exact failure it was built to fix.
 */

import * as fs from 'fs';
import * as path from 'path';

import { GM_DATA_DIR } from './config';

export interface LabelIndexEntry {
  /** Labels observed to contain this thread, in the order the walk found them. */
  labels: string[];
}

export interface LabelIndexMeta {
  builtAt: number;
  /** Labels actually walked (a walk can stop early on error or cap). */
  labelsWalked: number;
  /** Labels the account has, so a partial walk is visible as partial. */
  labelsTotal: number;
  /** Cap applied per label. A thread beyond it is simply not in the index. */
  perLabel: number;
  threadsIndexed: number;
  /** Labels that could not be read, with why. Never silently dropped. */
  failed: { label: string; error: string }[];
}

export interface LabelIndex {
  meta: LabelIndexMeta;
  /** threadId -> entry */
  threads: Record<string, LabelIndexEntry>;
}

const indexFile = (): string => path.join(GM_DATA_DIR, 'label-index.json');

/** Read the persisted index. Returns null when there is none — NOT an empty index. */
export function readLabelIndex(): LabelIndex | null {
  try {
    const raw = fs.readFileSync(indexFile(), 'utf8');
    const d = JSON.parse(raw) as LabelIndex;
    if (!d || typeof d !== 'object' || !d.meta || !d.threads) return null;
    return d;
  } catch {
    return null;
  }
}

export function writeLabelIndex(ix: LabelIndex): void {
  fs.mkdirSync(GM_DATA_DIR, { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(ix), 'utf8');
}

/**
 * Labels for one thread, plus how much to trust the answer.
 *
 * `known` is false when there is no index at all — the caller must NOT render that
 * as "no labels". This is the whole point of the module: absence of knowledge and
 * absence of labels are different answers.
 */
export function labelsForThread(threadId: string): { known: boolean; labels: string[]; staleMs: number | null } {
  const ix = readLabelIndex();
  if (!ix) return { known: false, labels: [], staleMs: null };
  const hit = ix.threads[threadId];
  return {
    known: true,
    labels: hit ? hit.labels.slice() : [],
    staleMs: Date.now() - ix.meta.builtAt,
  };
}

/** Enrich rows in place-ish: returns new rows with `labels` filled from the index. */
export function enrichRowsWithLabels<T extends { threadId: string | null; labels?: string[] }>(
  rows: T[],
): { rows: T[]; indexed: boolean; staleMs: number | null } {
  const ix = readLabelIndex();
  if (!ix) return { rows, indexed: false, staleMs: null };
  const staleMs = Date.now() - ix.meta.builtAt;
  const out = rows.map((r) => {
    if (!r.threadId) return r;
    // Never overwrite a non-empty scrape: if the chip DID render, that is
    // first-hand and fresher than the index.
    if (Array.isArray(r.labels) && r.labels.length) return r;
    const hit = ix.threads[r.threadId];
    return hit ? ({ ...r, labels: hit.labels.slice() } as T) : r;
  });
  return { rows: out, indexed: true, staleMs };
}

/**
 * Build the index by walking labels.
 *
 * `listForLabel` is injected so this module never imports the CDP client — that
 * would be circular, and it also lets the walk be tested without a browser.
 */
export async function buildLabelIndex(
  labelNames: string[],
  listForLabel: (label: string, limit: number) => Promise<{ threadId: string | null }[]>,
  opts: { perLabel?: number; maxLabels?: number } = {},
): Promise<LabelIndex> {
  const perLabel = Math.max(1, Math.min(opts.perLabel ?? 50, 200));
  const maxLabels = Math.max(1, Math.min(opts.maxLabels ?? 100, 500));
  const walk = labelNames.slice(0, maxLabels);

  const threads: Record<string, LabelIndexEntry> = {};
  const failed: { label: string; error: string }[] = [];

  for (const label of walk) {
    try {
      const rows = await listForLabel(label, perLabel);
      for (const r of rows) {
        if (!r.threadId) continue;
        const e = (threads[r.threadId] ||= { labels: [] });
        if (!e.labels.includes(label)) e.labels.push(label);
      }
    } catch (e) {
      // Recorded, never swallowed: a label that failed to read is a HOLE in the
      // index, and a caller reading a thread's labels deserves to know the walk
      // was incomplete.
      failed.push({ label, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    meta: {
      builtAt: Date.now(),
      labelsWalked: walk.length,
      labelsTotal: labelNames.length,
      perLabel,
      threadsIndexed: Object.keys(threads).length,
      failed,
    },
    threads,
  };
}
