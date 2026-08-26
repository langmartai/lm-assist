// core/src/search/fts-rank.ts
// The ranked-FTS query shared by every prompt/memory index in this directory.
//
// It exists so the two stores cannot drift on the parts that are easy to get subtly
// wrong and hard to notice: AND-before-OR widening, an escalating row budget, and
// truthfully reporting when the scan was capped rather than inventing a total.
import type { SqlBackend } from '../data/backends/sql-backend';
import type { DataRecord, QueryFilter } from '../data/types';
import { tokenizeFts } from '../data/backends/fts-query';

/** Hard ceiling on rows pulled for one search. Bounds worst-case memory and time. */
export const MAX_SCAN_ROWS = 5000;

export interface RankedFtsResult {
  /** 'and' = every term matched one document; 'or' = widened after AND found nothing. */
  mode: 'and' | 'or';
  /** Matching records in bm25 order (best first), without their `text`. */
  records: DataRecord[];
  /**
   * True when the scan hit its ceiling, so `records` is a PREFIX of the matches.
   * Callers must render counts as "at least N" — a capped scan reported as a total is
   * the exact class of lie this whole search rewrite exists to remove.
   */
  truncated: boolean;
  scannedRows: number;
}

/**
 * Rank `dataset` by bm25 over `query`.
 *
 * Returns null when the query has no indexable terms — which callers must treat as
 * "cannot search", never as "matched nothing", or a junk query reads as a definitive
 * empty result.
 *
 * `groupKey` names the unit the caller actually returns (sessions, say, rather than the
 * prompts that matched). The row budget escalates until it holds more than `need` of
 * those units, so a deep page is reachable instead of being silently cut off at a fixed
 * row count.
 */
export async function rankedFtsSearch(
  backend: SqlBackend,
  dataset: string,
  query: string,
  opts: {
    filter?: QueryFilter[];
    need?: number;
    startRows?: number;
    groupKey?: (rec: DataRecord) => string;
  } = {},
): Promise<RankedFtsResult | null> {
  if (tokenizeFts(query).length === 0) return null;

  const need = Math.max(opts.need ?? 1, 1);
  const start = Math.min(Math.max(opts.startRows ?? Math.max(need * 10, 200), 1), MAX_SCAN_ROWS);
  const filter = opts.filter ?? [];
  const groupKey = opts.groupKey;

  const distinct = (recs: DataRecord[]): number => {
    if (!groupKey) return recs.length;
    const seen = new Set<string>();
    for (const r of recs) seen.add(groupKey(r));
    return seen.size;
  };

  for (const mode of ['and', 'or'] as const) {
    let rows = start;
    let recs: DataRecord[] = [];
    let exhausted = false;
    for (;;) {
      const r = await backend.query(dataset, {
        filter, fts: query, ftsMode: mode, limit: rows,
        // The ranking pass needs ids and fields, never the documents: carrying `text`
        // shipped the whole matched corpus across the worker boundary (23.7MB measured
        // for one broad query at the ceiling) for a renderer that shows a few snippets.
        // `total` is never read here either, and computing it costs a second COUNT scan
        // on every escalation step.
        omitText: true, countTotal: false,
      });
      recs = (r.records || []).filter((x) => x.deleted !== true);
      // Fewer rows back than asked for ⇒ every match is in hand; the count is exact.
      exhausted = (r.records || []).length < rows;
      if (exhausted || rows >= MAX_SCAN_ROWS) break;
      if (distinct(recs) > need) break;
      rows = Math.min(rows * 2, MAX_SCAN_ROWS);
    }
    if (recs.length === 0) continue;      // AND found nothing → widen to OR
    return { mode, records: recs, truncated: !exhausted, scannedRows: recs.length };
  }
  return { mode: 'and', records: [], truncated: false, scannedRows: 0 };
}
