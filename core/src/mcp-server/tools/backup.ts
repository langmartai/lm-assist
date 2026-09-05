/**
 * Backup MCP tools — run, status, search, read, remove.
 *
 * The store is `E:\claude-backup` on DESKTOP-GDKLATG (node 107): every host's
 * `.claude` (sessions, memory, rules, settings), the claude.ai conversations
 * and account memory, and a per-host memory+rules extract. Only 107 holds it,
 * so every tool routes there — a non-collector answers with a pointer rather
 * than an empty result.
 *
 * Descriptions here are deliberately terse, and the surface is guarded by a hard
 * catalogue budget. `tools/list` is paid by every conversation before a single
 * call, and shared boilerplate is the expensive kind — it is multiplied by the
 * tool count (one repeated paragraph across 188 tools was 40% of a 350 KB
 * catalogue). So the routing hint sits on the two entry-point tools only; the
 * rest is carried by guide("backup") and by the pointer the tools return when
 * called off-collector.
 */

import { ok, err, workerGet, workerPost, type McpToolResult } from './_passthrough';

export const backupRunToolDef = {
  name: 'backup_run',
  description:
    'Capture the fleet backup on node 107: every host\'s .claude (sessions, memory, rules) plus ' +
    'claude.ai conversations and account memory. Credentials are excluded at capture. ASYNC — returns ' +
    'a runId (a full pass re-pulls ~2 GB); poll backup_status. One at a time. ' +
    'node:"DESKTOP-GDKLATG". guide("backup").',
  annotations: { readOnlyHint: false, destructiveHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      targets: {
        type: 'array', items: { type: 'string' },
        description: 'windows-desk (=node 107) · linux-117 · linux-123 · claudeai · memory-rules. Default all.',
      },
      dryRun: { type: 'boolean', description: 'Report only, write nothing.' },
      skipBlobs: { type: 'boolean', description: 'Skip claude.ai attachment download.' },
      reindex: { type: 'boolean', description: 'Rebuild index rows, not incremental.' },
    },
  },
};

export const backupStatusToolDef = {
  name: 'backup_status',
  description:
    'Backup health on node 107: per-target last run, result, size, items, files the secret policy ' +
    'excluded, and a STALENESS verdict (fresh/aging/stale/never) so a target that quietly stopped is ' +
    'visible. Plus in-flight run, index freshness, free disk, recent removals, and any credential ' +
    'files left in the store by the pre-filter era. node:"DESKTOP-GDKLATG".',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      detail: { type: 'string', enum: ['summary', 'full'], description: 'full adds history + removals.' },
    },
  },
};

export const backupSearchToolDef = {
  name: 'backup_search',
  description:
    'Search the BACKUP without restoring anything — backed-up sessions, memory, rules and claude.ai ' +
    'conversations, including content sealed inside .tar.gz snapshots. Answers from an index; no ' +
    'archive is unpacked. Each hit carries an `id` for backup_read/backup_remove.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      q: { type: 'string', description: 'Search text. Bare words allow FTS operators; punctuation is a phrase.' },
      kind: { type: 'string', enum: ['session', 'memory', 'rule', 'conversation', 'file'], description: 'Restrict to one kind.' },
      source: {
        type: 'string',
        description: 'Which backed-up HOST (windows-desk=107 · linux-117 · linux-123 · claudeai). Not `node`, which routes the call.',
      },
      project: { type: 'string', description: 'Substring match on the project slug.' },
      since: { type: 'string', description: 'ISO date — items modified on/after it.' },
      limit: { type: 'number', description: 'Hits per page (default 10, max 25 — each carries an excerpt).' },
      offset: { type: 'number', description: 'Page offset; the reply gives nextOffset.' },
    },
    required: ['q'],
  },
};

export const backupReadToolDef = {
  name: 'backup_read',
  description:
    'Read one backed-up item by the `id` from backup_search or backup_list. A member inside a ' +
    '.tar.gz is streamed out individually — the archive is never unpacked. PAGED: 8 KB per call, ' +
    '20 KB max (the MCP result ceiling is 64 KB); every reply gives the exact nextOffset until eof.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Item id from backup_search.' },
      offset: { type: 'number', description: 'Byte offset (default 0).' },
      maxBytes: { type: 'number', description: 'Bytes this call (default 8192, max 20480).' },
    },
    required: ['id'],
  },
};

export const backupListToolDef = {
  name: 'backup_list',
  description:
    'Browse WHAT IS IN the backup — no search term needed. Called bare it returns an overview: ' +
    'items and bytes per host and kind, plus the snapshots held. Add source/kind/project/prefix/' +
    'container to page through the actual entries, newest first, each with an `id` for ' +
    'backup_read. Use this to see what exists; use backup_search to find text inside it.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      source: { type: 'string', description: 'windows-desk (node 107) · linux-117 · linux-123 · claudeai.' },
      kind: { type: 'string', enum: ['session', 'memory', 'rule', 'conversation', 'file'], description: 'Restrict to one kind.' },
      project: { type: 'string', description: 'Substring match on the project slug.' },
      prefix: { type: 'string', description: 'Path prefix, e.g. "projects/" or "rules/".' },
      container: { type: 'string', description: 'A specific snapshot filename, to list only its contents.' },
      limit: { type: 'number', description: 'Rows per page (default 30, max 60).' },
      offset: { type: 'number', description: 'Page offset; the reply gives nextOffset.' },
    },
  },
};

export const backupRemoveToolDef = {
  name: 'backup_remove',
  description:
    'Remove an item from the backup for real. Deletes the stored copy; a member inside a .tar.gz means ' +
    'the snapshot is REPACKED without it, swapped only after the rewrite verifies (minutes on 2 GB). ' +
    'Records a permanent exclusion by default — without it, anything mirrored from a live .claude comes ' +
    'back. Git history is never rewritten (the payload was never committed). Audited. DESTRUCTIVE.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Item id from backup_search.' },
      reason: { type: 'string', description: 'Why — recorded in the removal audit.' },
      confirm: { type: 'boolean', description: 'Must be true.' },
      exclude: { type: 'boolean', description: 'Never re-capture this path (default true).' },
      scope: {
        type: 'string', enum: ['item', 'snapshot'],
        description: 'item (default) = one file/member; snapshot = a whole dated .tar.gz.',
      },
    },
    required: ['id', 'reason', 'confirm'],
  },
};

export const BACKUP_TOOL_DEFS = [
  backupRunToolDef,
  backupStatusToolDef,
  backupListToolDef,
  backupSearchToolDef,
  backupReadToolDef,
  backupRemoveToolDef,
];

// ------------------------------------------------------- rendering (pure)
//
// Rendering is separated from transport so its SIZE CAN BE MEASURED. Every one
// of these is bounded by a page the route already clamped, and a test renders
// worst-case data through them and asserts the bytes — because "it should be
// small" is how a tool ends up returning 923 KB and killing a conversation.

/** The paging footer every windowed result carries. */
export function pager(
  tool: string, offset: number, returned: number, total: number, nextOffset: number | null,
): string {
  if (total === 0) return 'No matching items.';
  const first = returned === 0 ? 0 : offset + 1;
  const line = `Showing ${first}–${offset + returned} of ${total}.`;
  return nextOffset === null
    ? `${line} End of results.`
    : `${line} More available — next page: ${tool}({offset: ${nextOffset}}).`;
}

/**
 * Display bounds the RENDERER enforces, rather than trusting its caller.
 *
 * The route clamps too, but a bound that lives only upstream is a bound that
 * disappears the moment someone calls the renderer from somewhere else. These
 * are what backup-output-size.test.ts actually measures.
 */
const EXCERPT_CHARS = 220;
const PATH_CHARS = 140;

/** Middle-ellipsis: the head says WHERE, the tail says WHICH — both matter. */
function clampPath(p: string): string {
  if (p.length <= PATH_CHARS) return p;
  const head = Math.ceil((PATH_CHARS - 1) / 2);
  return `${p.slice(0, head)}…${p.slice(p.length - (PATH_CHARS - 1 - head))}`;
}

function clampExcerpt(x: string): string {
  const flat = (x || '').replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS)}…`;
}

function shortDate(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—';
}

function mb(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

interface Hit {
  id: string; kind: string; source: string; project: string; path: string;
  container: string; title: string; mtime: number; size: number; excerpt: string;
}
export interface SearchResponse {
  hits: Hit[]; total: number; returned: number; limit: number; offset: number;
  hasMore: boolean; nextOffset: number | null; indexedAt: number | null; stale: boolean;
}

export function renderSearch(r: SearchResponse): string {
  if (!r.hits.length) {
    return r.indexedAt
      ? `No backed-up items match. Index last updated ${shortDate(r.indexedAt)}. ` +
        'Try backup_list to see what is in the backup.'
      : 'The index is empty — run backup_run first.';
  }
  const out: string[] = [];
  if (r.stale) out.push('⚠️  Index not refreshed in over a week — these describe the last capture, not today.', '');
  for (const h of r.hits) {
    out.push(
      `[${h.id}] ${h.kind} · ${h.source}${h.container ? ` · ${clampPath(h.container)}` : ''} · ${shortDate(h.mtime)} · ${mb(h.size)}`,
      `  ${clampPath(h.path)}${h.project ? `  (${clampPath(h.project)})` : ''}`,
      `  ${clampExcerpt(h.excerpt)}`,
    );
  }
  out.push('', pager('backup_search', r.offset, r.returned, r.total, r.nextOffset),
    'Read one with backup_read({id}).');
  return out.join('\n');
}

interface ListRow {
  id: string; kind: string; source: string; project: string; path: string;
  container: string; title: string; mtime: number; size: number;
}
export interface ListResponse {
  mode: 'overview' | 'items';
  bySource?: { source: string; kind: string; count: number; bytes: number; newest: number }[];
  snapshots?: { source: string; container: string; count: number }[];
  totals?: { items: number; bytes: number };
  rows?: ListRow[]; total?: number; returned?: number; limit?: number; offset?: number;
  hasMore?: boolean; nextOffset?: number | null; indexedAt: number | null;
}

export function renderList(r: ListResponse): string {
  if (r.mode === 'overview') {
    const by = r.bySource ?? [];
    if (!by.length) return 'The backup index is empty — run backup_run to populate it.';
    const out = [
      `Backup contents — ${r.totals?.items ?? 0} indexed items, ${mb(r.totals?.bytes ?? 0)}` +
      `, indexed ${shortDate(r.indexedAt ?? 0)}`,
      '',
      '| Host | Kind | Items | Size | Newest |',
      '|---|---|---|---|---|',
    ];
    for (const b of by) {
      out.push(`| ${b.source} | ${b.kind} | ${b.count} | ${mb(b.bytes)} | ${shortDate(b.newest)} |`);
    }
    const snaps = r.snapshots ?? [];
    if (snaps.length) {
      out.push('', 'Snapshots held:');
      for (const sn of snaps) out.push(`  ${sn.source} · ${sn.container} — ${sn.count} entries`);
    }
    out.push('', 'Drill in with backup_list({source, kind, project, prefix, container}); ' +
      'search text with backup_search({q}).');
    return out.join('\n');
  }

  const rows = r.rows ?? [];
  if (!rows.length) {
    return `No items match those filters. ${pager('backup_list', r.offset ?? 0, 0, r.total ?? 0, null)}`;
  }
  const out: string[] = [];
  for (const row of rows) {
    out.push(
      `[${row.id}] ${row.kind} · ${row.source}${row.container ? ` · ${clampPath(row.container)}` : ''} · ` +
      `${shortDate(row.mtime)} · ${mb(row.size)}`,
      `  ${clampPath(row.path)}`,
    );
  }
  out.push('', pager('backup_list', r.offset ?? 0, r.returned ?? rows.length, r.total ?? rows.length, r.nextOffset ?? null),
    'Read one with backup_read({id}).');
  return out.join('\n');
}

export interface ItemResponse {
  id: string; kind: string; source: string; store: string; path: string; container?: string;
  title: string; mtime: number; totalBytes: number; offset: number; returnedBytes: number;
  eof: boolean; nextOffset: number | null; clampedFrom: number | null;
  maxBytesPerCall: number; content: string;
}

export function renderRead(r: ItemResponse): string {
  const head = [
    `${r.kind} · ${r.source}${r.container ? ` · ${r.container}` : ''}`,
    r.path,
    `bytes ${r.offset}–${r.offset + r.returnedBytes} of ${r.totalBytes}` +
      (r.eof ? ' (end of file)' : ` — continue: backup_read({id: "${r.id}", offset: ${r.nextOffset}})`),
  ];
  // A caller who asked for more than a page can carry must be told, or the
  // short reply reads as "that was all of it".
  if (r.clampedFrom !== null) {
    head.push(
      `note: you asked for ${r.clampedFrom} bytes; a single call carries at most ` +
      `${r.maxBytesPerCall} because the MCP result ceiling is 65536. Page with offset.`,
    );
  }
  return `${head.join('\n')}\n\n${r.content}`;
}

export interface StatusReport {
  root: string;
  targets: { name: string; method: string; lastRun: string; result: string; sizeMB: number;
    items: number; secretsExcluded?: number; staleness: string; ageDays: number }[];
  missing: string[];
  run: { runId: string; startedAt: string; current?: string; done: string[]; failed: string[] } | null;
  index: { available: boolean; reason?: string; indexedAt: number | null; rows: number; byKind: Record<string, number> };
  legacySecrets: { path: string; reason: string; bytes: number; isDir: boolean }[];
  recentRemovals: { at: string; path: string; reason: string }[];
  history: string[];
  diskFreeGB: number | null;
}

/** Secret-file lines shown before collapsing to a count. */
const SECRET_LINES = 6;

export function renderStatus(s: StatusReport, full: boolean): string {
  const out: string[] = [`Backup store: ${s.root}` + (s.diskFreeGB !== null ? ` · ${s.diskFreeGB} GB free` : '')];

  if (s.run) {
    out.push('', `RUN IN FLIGHT ${s.run.runId} (started ${s.run.startedAt})` +
      (s.run.current ? ` — currently ${s.run.current}` : '') +
      ` · done ${s.run.done.length}, failed ${s.run.failed.length}`);
  }

  out.push('', '| Target | Last run | Age | Result | MB | Items | Excluded |', '|---|---|---|---|---|---|---|');
  for (const t of s.targets) {
    const age = t.staleness === 'never' ? 'never' : `${t.staleness} ${t.ageDays}d`;
    out.push(`| ${t.name} | ${t.lastRun} | ${age} | ${t.result} | ${t.sizeMB} | ${t.items} | ${t.secretsExcluded ?? '—'} |`);
  }
  if (s.missing.length) out.push('', `Never captured: ${s.missing.join(', ')}`);

  out.push('', s.index.available
    ? `Index: ${s.index.rows} items (${Object.entries(s.index.byKind).map(([k, v]) => `${k} ${v}`).join(', ')})` +
      `, updated ${shortDate(s.index.indexedAt ?? 0)} — browse with backup_list`
    : `Index: UNAVAILABLE — ${s.index.reason}`);

  if (s.legacySecrets.length) {
    const bytes = s.legacySecrets.reduce((a, b) => a + b.bytes, 0);
    const dirs = s.legacySecrets.filter((l) => l.isDir).length;
    out.push('', `⚠️  ${s.legacySecrets.length} credential path(s) still in the store from before ` +
      `capture-time filtering (${mb(bytes)} in files` +
      (dirs ? `, plus ${dirs} unsized director${dirs === 1 ? 'y' : 'ies'}` : '') +
      '). NOT on GitHub — the payload is gitignored — but plaintext on the backup volume:');
    // Bounded even in `full`: this walks the mirror, so its length is data, and
    // an unbounded list here is the same mistake as an unpaged search.
    const show = full ? SECRET_LINES * 3 : SECRET_LINES;
    for (const l of s.legacySecrets.slice(0, show)) {
      out.push(`  ${clampPath(l.path)}${l.isDir ? '/ (directory)' : ''} — ${l.reason}`);
    }
    if (s.legacySecrets.length > show) {
      out.push(`  … and ${s.legacySecrets.length - show} more` + (full ? '' : ' (detail:"full" shows more)'));
    }
    out.push('Remove with backup_remove; they will not be re-captured.');
  }

  if (full) {
    if (s.recentRemovals.length) {
      out.push('', 'Recent removals:');
      for (const r of s.recentRemovals) out.push(`  ${r.at}  ${r.path} — ${r.reason}`);
    }
    if (s.history.length) out.push('', 'History:', ...s.history.map((h) => `  ${h}`));
  }
  return out.join('\n');
}

interface RunStarted { runId: string; startedAt: string; targets: string[]; root: string }
interface DryReport { dryRun: true; localFiles: number; localExcluded: number; excludedSample: string[]; targets: string[] }

export function renderRun(r: RunStarted | DryReport): string {
  if ('dryRun' in r) {
    const out = [
      `Dry run — nothing written. Targets: ${r.targets.join(', ')}`,
      `Local .claude: ${r.localFiles} files would be captured, ${r.localExcluded} excluded by policy.`,
    ];
    if (r.excludedSample.length) out.push('', 'Excluded (sample):', ...r.excludedSample.map((x) => `  ${x}`));
    return out.join('\n');
  }
  return `Backup started — runId ${r.runId} at ${r.startedAt}\nTargets: ${r.targets.join(', ')}\n` +
    `Store: ${r.root}\n\nRuns in the background (a full pass re-pulls ~2 GB). Poll backup_status.`;
}

interface RemoveResponse {
  removed: boolean; id: string; kind: string; source: string; store: string; path: string;
  container?: string; excluded: boolean;
  repack?: { entriesBefore: number; entriesAfter: number; bytesBefore: number; bytesAfter: number };
  note: string;
}

export function renderRemove(r: RemoveResponse): string {
  const out = [`Removed ${r.kind} from the backup: ${r.source} · ${r.path}` +
    (r.container ? ` (in ${r.container})` : '')];
  if (r.repack) {
    out.push(`Snapshot repacked: ${r.repack.entriesBefore} → ${r.repack.entriesAfter} entries, ` +
      `${mb(r.repack.bytesBefore)} → ${mb(r.repack.bytesAfter)} (verified before swap).`);
  }
  if (r.note) out.push('', r.note);
  return out.join('\n');
}

// ---------------------------------------------------------------- handlers

function qs(args: Record<string, unknown>, keys: string[]): string {
  const p = new URLSearchParams();
  for (const k of keys) {
    const v = args[k];
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  return p.toString();
}

async function handleRun(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    return ok(renderRun(await workerPost<RunStarted | DryReport>('/backup/run', {
      targets: args.targets, dryRun: args.dryRun, skipBlobs: args.skipBlobs, reindex: args.reindex,
    })));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleStatus(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    return ok(renderStatus(await workerGet<StatusReport>('/backup/status'), args.detail === 'full'));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleList(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const q = qs(args, ['source', 'kind', 'project', 'prefix', 'container', 'limit', 'offset']);
    return ok(renderList(await workerGet<ListResponse>(`/backup/list${q ? `?${q}` : ''}`)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleSearch(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const q = qs(args, ['q', 'kind', 'source', 'project', 'since', 'limit', 'offset']);
    return ok(renderSearch(await workerGet<SearchResponse>(`/backup/search?${q}`)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleRead(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const q = qs(args, ['id', 'offset', 'maxBytes']);
    return ok(renderRead(await workerGet<ItemResponse>(`/backup/item?${q}`)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleRemove(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    return ok(renderRemove(await workerPost<RemoveResponse>('/backup/remove', {
      id: args.id, reason: args.reason, confirm: args.confirm,
      exclude: args.exclude, scope: args.scope,
    })));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const BACKUP_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  backup_run: handleRun,
  backup_status: handleStatus,
  backup_list: handleList,
  backup_search: handleSearch,
  backup_read: handleRead,
  backup_remove: handleRemove,
};
