/**
 * MEASURED output bounds for the backup tools.
 *
 * The MCP result ceiling is 65,536 B (`DEFAULT_MAX_RESULT_BYTES`) and the
 * per-tool soft budget is 25 KiB. Past the ceiling a result is truncated ABOVE
 * the tool, so the tool's own "end of results" is still printed and the reply
 * reads as complete when it is not — the failure that killed a 110-message
 * conversation with a single 923 KB `mission_list`.
 *
 * "It should be small" is not a bound. These tests render WORST-CASE data
 * through the real renderers at the maximum page each route allows, and assert
 * the bytes. If a page size or a display clamp is ever loosened, this fails
 * before anything reaches a conversation.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  renderSearch, renderList, renderRead, renderStatus, pager, BACKUP_TOOL_DEFS,
  type SearchResponse, type ListResponse, type ItemResponse, type StatusReport,
} from '../mcp-server/tools/backup';
import { DEFAULT_MAX_RESULT_BYTES } from '../mcp-server/result-cap';
import { TOOL_OUTPUT_SOFT_BYTES } from '../mcp-server/tool-output-budget';

const B = (s: string) => Buffer.byteLength(s, 'utf8');

/** Max page each route permits — kept in step with backup.routes.ts. */
const MAX_SEARCH_HITS = 25;
const MAX_LIST_ROWS = 60;
const MAX_READ_BYTES = 20 * 1024;   // must equal MAX_READ_BYTES in backup.routes.ts

/** A path far longer than anything real, to prove the clamp carries the bound. */
const MONSTER_PATH = `projects/${'C--home-a-very-long-project-slug'.repeat(12)}/${'x'.repeat(300)}.jsonl`;
const MONSTER_TEXT = 'lorem ipsum dolor sit amet '.repeat(200);

function worstHit(i: number) {
  return {
    id: `${i}`.padStart(16, 'a'),
    kind: 'session', source: 'linux-117', project: MONSTER_PATH,
    path: MONSTER_PATH, container: `claude-2026-07-29_1200${i}.tar.gz`,
    title: MONSTER_PATH, mtime: 1_800_000_000_000, size: 123_456_789,
    excerpt: MONSTER_TEXT,
  };
}

test('search at its maximum page stays inside the soft budget', () => {
  const r: SearchResponse = {
    hits: Array.from({ length: MAX_SEARCH_HITS }, (_, i) => worstHit(i)),
    total: 90_414, returned: MAX_SEARCH_HITS, limit: MAX_SEARCH_HITS, offset: 0,
    hasMore: true, nextOffset: MAX_SEARCH_HITS, indexedAt: 1_800_000_000_000, stale: true,
  };
  const bytes = B(renderSearch(r));
  assert.ok(bytes <= TOOL_OUTPUT_SOFT_BYTES,
    `search worst case is ${bytes}B, over the ${TOOL_OUTPUT_SOFT_BYTES}B soft budget`);
  assert.ok(bytes < DEFAULT_MAX_RESULT_BYTES / 2,
    `search worst case is ${bytes}B — too close to the ${DEFAULT_MAX_RESULT_BYTES}B ceiling`);
});

test('list at its maximum page stays inside the soft budget', () => {
  const r: ListResponse = {
    mode: 'items',
    rows: Array.from({ length: MAX_LIST_ROWS }, (_, i) => {
      const h = worstHit(i);
      return { ...h, excerpt: undefined } as unknown as NonNullable<ListResponse['rows']>[number];
    }),
    total: 90_414, returned: MAX_LIST_ROWS, limit: MAX_LIST_ROWS, offset: 0,
    hasMore: true, nextOffset: MAX_LIST_ROWS, indexedAt: 1_800_000_000_000,
  };
  const bytes = B(renderList(r));
  assert.ok(bytes <= TOOL_OUTPUT_SOFT_BYTES,
    `list worst case is ${bytes}B, over the ${TOOL_OUTPUT_SOFT_BYTES}B soft budget`);
});

test('the overview does not grow with the backup', () => {
  // Five hosts x five kinds, plus retained snapshots — bounded by policy, not
  // by how much has been backed up. That is what makes it a safe landing view.
  const kinds = ['session', 'memory', 'rule', 'conversation', 'file'];
  const sources = ['windows-desk', 'linux-117', 'linux-123', 'claudeai', 'memory-rules'];
  const r: ListResponse = {
    mode: 'overview',
    bySource: sources.flatMap((source) => kinds.map((kind) => ({
      source, kind, count: 99_999, bytes: 9_999_999_999, newest: 1_800_000_000_000,
    }))),
    snapshots: sources.flatMap((source) => Array.from({ length: 5 }, (_, i) => ({
      source, container: `claude-2026-07-2${i}_120000.tar.gz`, count: 90_414,
    }))),
    totals: { items: 500_000, bytes: 9_999_999_999 },
    indexedAt: 1_800_000_000_000,
  };
  const bytes = B(renderList(r));
  assert.ok(bytes <= TOOL_OUTPUT_SOFT_BYTES, `overview is ${bytes}B, over the soft budget`);
});

test('a full read page plus its header stays under the hard ceiling', () => {
  const r: ItemResponse = {
    id: 'a1b2c3d4e5f6a7b8', kind: 'session', source: 'linux-117', store: 'snapshot',
    path: MONSTER_PATH, container: 'claude-2026-07-29_120000.tar.gz', title: 'x',
    mtime: 1_800_000_000_000, totalBytes: 5_000_000, offset: 0,
    returnedBytes: MAX_READ_BYTES, eof: false, nextOffset: MAX_READ_BYTES,
    clampedFrom: 1_048_576, maxBytesPerCall: MAX_READ_BYTES,
    content: 'x'.repeat(MAX_READ_BYTES),
  };
  const bytes = B(renderRead(r));
  assert.ok(bytes <= TOOL_OUTPUT_SOFT_BYTES,
    `read worst case is ${bytes}B, over the ${TOOL_OUTPUT_SOFT_BYTES}B soft budget`);
  assert.ok(bytes < DEFAULT_MAX_RESULT_BYTES,
    `read worst case is ${bytes}B, at or over the ${DEFAULT_MAX_RESULT_BYTES}B ceiling — it would be truncated ABOVE the tool`);
});

test('status stays bounded even with hundreds of legacy secrets', () => {
  const s: StatusReport = {
    root: 'E:\\\\claude-backup',
    targets: ['windows-desk', 'linux-117', 'linux-123', 'claudeai', 'memory-rules'].map((name) => ({
      name, method: 'ssh tar.gz snapshot', lastRun: '2026-07-29 13:35:12',
      result: 'ok (tar warned: files changed during read)', sizeMB: 2034, items: 90_414,
      secretsExcluded: 12, staleness: 'fresh', ageDays: 0.2,
    })),
    missing: [],
    run: { runId: 'abc123', startedAt: '2026-07-29 13:00:00', current: 'linux-117', done: [], failed: [] },
    index: { available: true, indexedAt: 1_800_000_000_000, rows: 500_000,
      byKind: { session: 400_000, memory: 50_000, rule: 500, conversation: 108, file: 49_392 } },
    // The store walk decides this length — it is DATA, so it must be bounded.
    legacySecrets: Array.from({ length: 500 }, (_, i) => ({
      path: `${MONSTER_PATH}/${i}`, reason: 'live Claude Code OAuth token', bytes: 555,
      isDir: i % 3 === 0,
    })),
    recentRemovals: Array.from({ length: 5 }, (_, i) => ({
      at: '2026-07-29 12:00:00', path: `${MONSTER_PATH}/${i}`, reason: 'purge of a captured credential',
    })),
    history: Array.from({ length: 8 }, (_, i) => `[2026-07-29 13:35:1${i}] linux-117 ok size=2034MB`),
    diskFreeGB: 812.4,
  };
  for (const full of [false, true]) {
    const bytes = B(renderStatus(s, full));
    assert.ok(bytes <= TOOL_OUTPUT_SOFT_BYTES,
      `status(detail:${full ? 'full' : 'summary'}) is ${bytes}B, over the ${TOOL_OUTPUT_SOFT_BYTES}B soft budget`);
  }
});

test('every windowed result says where it is and how to get the rest', () => {
  // A page that does not say "there is more" is indistinguishable from a
  // complete answer — the specific way a capped tool lies.
  assert.match(pager('backup_list', 0, 30, 90_414, 30), /Showing 1–30 of 90414\./);
  assert.match(pager('backup_list', 0, 30, 90_414, 30), /backup_list\(\{offset: 30\}\)/);
  assert.match(pager('backup_search', 60, 10, 70, null), /Showing 61–70 of 70\. End of results\./);
  assert.strictEqual(pager('backup_search', 0, 0, 0, null), 'No matching items.');
});

test('a truncated page never claims to be the end', () => {
  const r: SearchResponse = {
    hits: [worstHit(1)], total: 500, returned: 1, limit: 1, offset: 0,
    hasMore: true, nextOffset: 1, indexedAt: Date.now(), stale: false,
  };
  const text = renderSearch(r);
  assert.ok(!text.includes('End of results'), 'a partial page must not read as complete');
  assert.match(text, /More available/);
});

test('a read that was clamped says so, so the short reply is not mistaken for the file', () => {
  const base: ItemResponse = {
    id: 'a1b2c3d4e5f6a7b8', kind: 'memory', source: 'linux-117', store: 'snapshot',
    path: 'projects/P/memory/MEMORY.md', title: 'MEMORY.md', mtime: Date.now(),
    totalBytes: 900_000, offset: 0, returnedBytes: MAX_READ_BYTES, eof: false,
    nextOffset: MAX_READ_BYTES, clampedFrom: 1_048_576, maxBytesPerCall: MAX_READ_BYTES,
    content: 'x',
  };
  assert.match(renderRead(base), /you asked for 1048576 bytes/);
  assert.match(renderRead(base), /backup_read\(\{id: "a1b2c3d4e5f6a7b8", offset: 20480\}\)/);
  const done = renderRead({ ...base, eof: true, nextOffset: null, clampedFrom: null });
  assert.match(done, /end of file/);
  assert.ok(!done.includes('continue:'));
});

test('no schema advertises a page the MCP ceiling would silently truncate', () => {
  // The bug this catches shipped once already: backup_read's description said
  // "64 KB default, 1 MB max" while the route clamped to 20 KB. A caller asking
  // for 1 MB would get a short reply and no indication it was short — and even
  // the route's own cap would have been overridden by the 64 KB ceiling above it.
  const defs = BACKUP_TOOL_DEFS as { name: string; description: string;
    inputSchema: { properties: Record<string, { description?: string }> } }[];
  const read = defs.find((d) => d.name === 'backup_read')!;
  const claimed = [read.description, read.inputSchema.properties.maxBytes?.description ?? '']
    .join(' ')
    .match(/(\d[\d_,]*)\s*(KB|MB|bytes)?/gi) ?? [];
  for (const raw of claimed) {
    const n = Number(raw.replace(/[^\d]/g, ''));
    if (!Number.isFinite(n) || n < 1000) continue;         // "8 KB", "20 KB" → unit-less small numbers
    assert.ok(n <= DEFAULT_MAX_RESULT_BYTES,
      `backup_read advertises ${n} bytes, above the ${DEFAULT_MAX_RESULT_BYTES}B MCP ceiling — ` +
      'a caller asking for that would get a silently truncated result');
  }
  // And the advertised max must match what the route actually allows.
  assert.match(read.inputSchema.properties.maxBytes!.description!, /max 20480/);
});
