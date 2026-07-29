/**
 * Backup routes — the REST surface behind the `backup_*` MCP tools.
 *
 *   POST /backup/run      start a run (async — returns a runId, not a result)
 *   GET  /backup/status   targets + staleness + index freshness + legacy secrets
 *   GET  /backup/search   FTS query over the index, no archive touched
 *   GET  /backup/item     read one backed-up item, including a tarball member
 *   POST /backup/remove   delete for real, repacking a snapshot when needed
 *
 * EVERY ROUTE RESOLVES THE COLLECTOR FIRST. Only the node holding a backup root
 * can serve these, and a node that is not it answers with a pointer to the one
 * that is rather than an empty result — an empty result would read as "there is
 * no backup", which is the most misleading thing this surface could say.
 */

import * as fs from 'fs';
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { ALL_TARGETS, loadConfig, NOT_COLLECTOR_HINT, type TargetName } from '../../backup/config';
import { buildStatusReport, dryRun, startRun } from '../../backup/run';
import { openForRead, type SearchHit } from '../../backup/search-index';
import { BackupIndex } from '../../backup/search-index';
import { physicalPath, removeItem } from '../../backup/remove';
import { readTarGz } from '../../backup/tar-reader';

/**
 * Ceilings sized against the MCP result cap, not against intuition.
 *
 * `result-cap.ts` truncates ANY tool result at 65,536 B and the per-tool soft
 * budget is 25 KiB. A tool that advertises a bigger page than that is lying: the
 * caller asks for 1 MB, the outer cap chops it at 64 KiB, and the result LOOKS
 * complete because the tool's own `eof` said nothing about the truncation that
 * happened above it. So every page here is bounded below the soft budget, with
 * headroom for the header the renderer adds, and callers page explicitly.
 */
const MAX_READ_BYTES = 20 * 1024;
const DEFAULT_READ_BYTES = 8 * 1024;
/** Search renders an excerpt per hit, so its page is much smaller than list's. */
const MAX_SEARCH_LIMIT = 25;
const DEFAULT_SEARCH_LIMIT = 10;
/** List rows are compact (no excerpt), so more fit — but 100 x a long path
 * still overshoots 25 KiB, so 60 is where the measurement landed. */
const MAX_LIST_LIMIT = 60;
const DEFAULT_LIST_LIMIT = 30;
/** Excerpt cap per hit — the single biggest driver of search result size. */
const MAX_EXCERPT_CHARS = 220;

function num(v: string | undefined, dflt: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function createBackupRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // ---------------------------------------------------------------- run
    {
      method: 'POST',
      pattern: /^\/backup\/run$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        const cfg = loadConfig();
        if (!cfg) return wrapError('NOT_COLLECTOR', NOT_COLLECTOR_HINT, start);

        const body = (req.body ?? {}) as Record<string, unknown>;
        const requested = Array.isArray(body.targets) ? (body.targets as string[]) : null;
        const unknown = requested?.filter((t) => !ALL_TARGETS.includes(t as TargetName)) ?? [];
        if (unknown.length) {
          return wrapError('UNKNOWN_TARGET',
            `unknown target(s): ${unknown.join(', ')}. Valid: ${ALL_TARGETS.join(', ')}`, start);
        }
        const targets = (requested as TargetName[] | null) ?? ALL_TARGETS;

        if (body.dryRun === true) return wrapResponse(dryRun(cfg, targets), start);

        try {
          const run = startRun(cfg, {
            targets,
            dryRun: false,
            skipBlobs: body.skipBlobs === true,
            reindex: body.reindex === true,
          });
          return wrapResponse({ ...run, root: cfg.root }, start);
        } catch (e) {
          return wrapError('RUN_IN_FLIGHT', e instanceof Error ? e.message : String(e), start);
        }
      },
    },

    // ------------------------------------------------------------- status
    {
      method: 'GET',
      pattern: /^\/backup\/status$/,
      handler: async () => {
        const start = Date.now();
        const cfg = loadConfig();
        if (!cfg) return wrapError('NOT_COLLECTOR', NOT_COLLECTOR_HINT, start);
        return wrapResponse(await buildStatusReport(cfg), start);
      },
    },

    // ------------------------------------------------------------- search
    {
      method: 'GET',
      pattern: /^\/backup\/search$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        const cfg = loadConfig();
        if (!cfg) return wrapError('NOT_COLLECTOR', NOT_COLLECTOR_HINT, start);

        const q = (req.query.q ?? '').trim();
        if (!q) return wrapError('MISSING_QUERY', 'q is required', start);

        const { index, meta } = openForRead(cfg);
        if (!index) return wrapError('INDEX_UNAVAILABLE', meta.reason ?? 'no index', start);

        try {
          const limit = num(req.query.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
          const offset = num(req.query.offset, 0, 0, 1_000_000);
          const since = req.query.since ? Date.parse(req.query.since) : undefined;
          const { hits, total } = index.search({
            q,
            kind: req.query.kind || undefined,
            source: req.query.source || undefined,
            project: req.query.project || undefined,
            since: Number.isFinite(since) ? since : undefined,
            limit, offset,
          });
          // Trim excerpts server-side: FTS `snippet()` is bounded in TOKENS, and a
          // token can be arbitrarily long (a base64 blob, a 300-char path), so
          // token-bounded is not byte-bounded.
          for (const h of hits) {
            if (h.excerpt && h.excerpt.length > MAX_EXCERPT_CHARS) {
              h.excerpt = `${h.excerpt.slice(0, MAX_EXCERPT_CHARS)}…`;
            }
          }
          const hasMore = offset + hits.length < total;
          return wrapResponse({
            hits, total, limit, offset,
            returned: hits.length,
            hasMore,
            nextOffset: hasMore ? offset + hits.length : null,
            indexedAt: meta.indexedAt,
            // A search answered from an index that has not been refreshed since
            // the last capture is answering about the past. Say so.
            stale: meta.indexedAt !== null && Date.now() - meta.indexedAt > 7 * 86_400_000,
          }, start);
        } catch (e) {
          return wrapError('SEARCH_FAILED', e instanceof Error ? e.message : String(e), start);
        } finally {
          index.close();
        }
      },
    },

    // --------------------------------------------------------------- item
    {
      method: 'GET',
      pattern: /^\/backup\/item$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        const cfg = loadConfig();
        if (!cfg) return wrapError('NOT_COLLECTOR', NOT_COLLECTOR_HINT, start);

        const id = (req.query.id ?? '').trim();
        if (!id) return wrapError('MISSING_ID', 'id is required (from backup_search)', start);

        const { index, meta } = openForRead(cfg);
        if (!index) return wrapError('INDEX_UNAVAILABLE', meta.reason ?? 'no index', start);

        try {
          const item = index.get(id);
          if (!item) return wrapError('NOT_FOUND', `no backed-up item with id "${id}"`, start);

          const offset = num(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
          const maxBytes = num(req.query.maxBytes, DEFAULT_READ_BYTES, 1, MAX_READ_BYTES);
          const requested = Number(req.query.maxBytes);
          // Say so when the caller asked for more than a page can carry, rather
          // than quietly returning less than they think they got.
          const clamped = Number.isFinite(requested) && requested > MAX_READ_BYTES ? requested : null;
          const target = physicalPath(cfg, item);

          let buf: Buffer | null = null;
          if (item.store === 'snapshot') {
            // Stream the archive and take exactly one member — never unpack it.
            for await (const { entry, content } of readTarGz(target, (e) => e.name === item.member)) {
              if (entry.name === item.member) { buf = content; break; }
            }
            if (!buf) {
              return wrapError('MEMBER_GONE',
                `"${item.member}" is no longer inside ${item.container} — it may have been removed; re-run backup_search`, start);
            }
          } else {
            if (!fs.existsSync(target)) {
              return wrapError('FILE_GONE',
                `${item.path} is indexed but missing from the store — re-run backup_run to reconcile`, start);
            }
            buf = fs.readFileSync(target);
          }

          const slice = buf.subarray(offset, offset + maxBytes);
          return wrapResponse({
            id: item.id, kind: item.kind, source: item.source, store: item.store,
            path: item.path, container: item.container || undefined, title: item.title,
            mtime: item.mtime, totalBytes: buf.length, offset,
            returnedBytes: slice.length,
            eof: offset + slice.length >= buf.length,
            nextOffset: offset + slice.length >= buf.length ? null : offset + slice.length,
            clampedFrom: clamped,
            maxBytesPerCall: MAX_READ_BYTES,
            content: slice.toString('utf-8'),
          }, start);
        } catch (e) {
          return wrapError('READ_FAILED', e instanceof Error ? e.message : String(e), start);
        } finally {
          index.close();
        }
      },
    },

    // --------------------------------------------------------------- list
    {
      method: 'GET',
      pattern: /^\/backup\/list$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        const cfg = loadConfig();
        if (!cfg) return wrapError('NOT_COLLECTOR', NOT_COLLECTOR_HINT, start);

        const { index, meta } = openForRead(cfg);
        if (!index) return wrapError('INDEX_UNAVAILABLE', meta.reason ?? 'no index', start);

        try {
          const filtering = ['source', 'kind', 'project', 'prefix', 'container']
            .some((k) => (req.query[k] ?? '') !== '');
          // No filter = "what have you got?" → aggregates, whose size does not
          // grow with the backup. Any filter = a paged window onto the items.
          if (!filtering) {
            return wrapResponse({
              mode: 'overview' as const,
              ...index.overview(),
              indexedAt: meta.indexedAt,
            }, start);
          }
          const limit = num(req.query.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
          const offset = num(req.query.offset, 0, 0, 1_000_000);
          const { rows, total } = index.list({
            source: req.query.source || undefined,
            kind: req.query.kind || undefined,
            project: req.query.project || undefined,
            prefix: req.query.prefix || undefined,
            container: req.query.container || undefined,
            limit, offset,
          });
          const hasMore = offset + rows.length < total;
          return wrapResponse({
            mode: 'items' as const,
            rows, total, limit, offset,
            returned: rows.length,
            hasMore,
            nextOffset: hasMore ? offset + rows.length : null,
            indexedAt: meta.indexedAt,
          }, start);
        } catch (e) {
          return wrapError('LIST_FAILED', e instanceof Error ? e.message : String(e), start);
        } finally {
          index.close();
        }
      },
    },

    // ------------------------------------------------------------- remove
    {
      method: 'POST',
      pattern: /^\/backup\/remove$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        const cfg = loadConfig();
        if (!cfg) return wrapError('NOT_COLLECTOR', NOT_COLLECTOR_HINT, start);

        const b = (req.body ?? {}) as Record<string, unknown>;
        const id = typeof b.id === 'string' ? b.id.trim() : '';
        const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
        if (!id) return wrapError('MISSING_ID', 'id is required (from backup_search)', start);
        if (!reason) return wrapError('MISSING_REASON', 'reason is required and is recorded in the removal audit', start);
        if (b.confirm !== true) {
          return wrapError('NOT_CONFIRMED',
            'confirm must be true — removal deletes backed-up data and, for a snapshot member, rewrites the archive', start);
        }
        const scope = b.scope === 'snapshot' ? 'snapshot' : 'item';

        let index: BackupIndex;
        try {
          index = new BackupIndex(cfg);
        } catch (e) {
          return wrapError('INDEX_UNAVAILABLE', e instanceof Error ? e.message : String(e), start);
        }
        try {
          const outcome = await removeItem(cfg, index, {
            id, reason, exclude: b.exclude !== false, scope,
          });
          return wrapResponse(outcome, start);
        } catch (e) {
          return wrapError('REMOVE_FAILED', e instanceof Error ? e.message : String(e), start);
        } finally {
          index.close();
        }
      },
    },
  ];
}

