/**
 * MEASURED output bounds for the backlog collection tools (backup-output-size idiom).
 *
 * On 2026-08-12 the routine no-arg `backlog_list` measured 65,833 B — past its
 * 60,000 budget AND the 65,536 B enforced ceiling in result-cap.ts, so every
 * routine call was being silently truncated: the exact "cap firing on the
 * routine call" failure the cap must never be allowed to shape. `backlog_graph`
 * was at 47,843 B and climbing the same slope (the fleet backlog only
 * accumulates). The fix is a bounded default page + slimmer rows at the MCP
 * layer, NOT a bigger budget — these tests pin that projection so it cannot
 * quietly regress to "serialise the whole collection".
 *
 * They render fleet-shaped data through the REAL projections and assert both
 * the behavior (paging honesty, slim rows) and the bytes against the budget
 * entries in tool-output-budget.ts, so the ratchet is checkable without a live
 * Core.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  projectBacklogList, projectBacklogGraph,
  BACKLOG_LIST_DEFAULT_LIMIT, BACKLOG_GRAPH_DEFAULT_NODES,
} from '../mcp-server/tools/backlog';
import { MEASURED_BUDGETS } from '../mcp-server/tool-output-budget';
import { DEFAULT_MAX_RESULT_BYTES } from '../mcp-server/result-cap';

/** Bytes as the handler emits them (pretty() = JSON.stringify(v, null, 2)). */
const B = (v: unknown) => Buffer.byteLength(JSON.stringify(v, null, 2), 'utf8');

/** One fleet-shaped list row as GET /backlog returns it (toListRow), sized like
 *  the fattest real rows: long title, 4 tags, 2 edges, a full actor whose label
 *  is an absolute path. */
function fleetRow(i: number): Record<string, unknown> {
  return {
    id: `bl_${String(i).padStart(8, '0')}`,
    title: `A realistically wordy backlog title about a feature that needs shipping ${i}`,
    type: 'feature', status: 'open', priority: 'med',
    tags: ['mission-control', 'connector-tools', 'output-size', `round-${i % 7}`],
    edges: [
      { to: `bl_${String(i + 1).padStart(8, '0')}`, kind: 'relates-to' },
      { to: `bl_${String(i + 2).padStart(8, '0')}`, kind: 'depends-on' },
    ],
    removed: false,
    counts: { discussion: 12, reviews: 3, edges: 2 },
    version: 21, rev: 21,
    lastUpdatedBy: {
      kind: 'local-session', id: '0b9e8f7a-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
      node: 'ubuntu-Virtual-Machine', channel: 'mcp',
      label: '/home/ubuntu/lm-assist/.claude/worktrees/some-quite-long-worktree-name',
      toolUseId: 'toolu_01AbCdEfGhIjKlMnOpQrStUv', at: 1_755_000_000_000 + i,
    },
    createdAt: 1_754_000_000_000 + i, updatedAt: 1_755_000_000_000 + i,
  };
}

function fleetListRes(n: number): Record<string, unknown> {
  return {
    items: Array.from({ length: n }, (_, i) => fleetRow(i)),
    counts: { shown: n, total: n + 103, removed: 103 },
  };
}

function fleetGraph(n: number): Record<string, unknown> {
  return {
    nodes: Array.from({ length: n }, (_, i) => ({
      id: `bl_${String(i).padStart(8, '0')}`,
      title: `A realistically wordy backlog title about a feature that needs shipping ${i}`,
      type: 'feature', status: 'open', priority: 'med',
      tags: ['mission-control', 'connector-tools', 'output-size', `round-${i % 7}`],
      removed: false,
      counts: { discussion: 12, reviews: 3 },
      updatedAt: 1_755_000_000_000 + i,
    })),
    // One edge per node to its neighbour — denser than the live fleet (66 edges
    // over 90 nodes), so the within-page filter is exercised at worst case.
    edges: Array.from({ length: n - 1 }, (_, i) => ({
      from: `bl_${String(i).padStart(8, '0')}`, to: `bl_${String(i + 1).padStart(8, '0')}`, kind: 'relates-to',
    })),
  };
}

// ── backlog_list ─────────────────────────────────────────────────────────

test('backlog_list: the routine no-arg call is a bounded page with honest meta', () => {
  const out = projectBacklogList(fleetListRes(300), {}) as Record<string, unknown>;
  const items = out.items as Array<Record<string, unknown>>;
  assert.strictEqual(items.length, BACKLOG_LIST_DEFAULT_LIMIT, 'default page size');
  assert.strictEqual(out.total, 300);
  assert.strictEqual(out.shown, BACKLOG_LIST_DEFAULT_LIMIT);
  assert.strictEqual(out.offset, 0);
  assert.strictEqual(out.hasMore, true);
  // The route's counts (incl. removed) survive, so the caller still sees the real set size.
  assert.deepStrictEqual(out.counts, { shown: 300, total: 403, removed: 103 });
  assert.match(String(out.hint || ''), /limit/, 'hint must say how to page');
});

test('backlog_list: rows are slim — actor collapses to kind:id8, no dup version, removed:false omitted', () => {
  const out = projectBacklogList(fleetListRes(3), {}) as Record<string, unknown>;
  const row = (out.items as Array<Record<string, unknown>>)[0];
  assert.strictEqual(row.by, 'local-session:0b9e8f7a', 'lastUpdatedBy must compact to kind:id8');
  assert.strictEqual(row.lastUpdatedBy, undefined, 'the full actor object is addressing detail a list does not need');
  assert.strictEqual(row.version, undefined, 'version duplicates rev');
  assert.strictEqual(row.rev, 21);
  assert.strictEqual(row.removed, undefined, 'removed:false is noise on every row');
  assert.deepStrictEqual(row.counts, { discussion: 12, reviews: 3, edges: 2 });
});

test('backlog_list: a removed row (includeRemoved sweep) still says so', () => {
  const res = fleetListRes(2);
  (res.items as Array<Record<string, unknown>>)[1].removed = true;
  const out = projectBacklogList(res, {}) as Record<string, unknown>;
  assert.strictEqual((out.items as Array<Record<string, unknown>>)[1].removed, true);
});

test('backlog_list: caller limit/offset are honored', () => {
  const out = projectBacklogList(fleetListRes(50), { limit: 5, offset: 48 }) as Record<string, unknown>;
  assert.strictEqual((out.items as unknown[]).length, 2);
  assert.strictEqual(out.offset, 48);
  assert.strictEqual(out.hasMore, false);
});

test('backlog_list: the default page stays under its budget however large the fleet grows', () => {
  const budget = MEASURED_BUDGETS.backlog_list;
  assert.ok(budget, 'backlog_list must stay budgeted');
  const bytes = B(projectBacklogList(fleetListRes(500), {}));
  assert.ok(bytes <= budget.budgetBytes,
    `default page is ${bytes}B, over its ${budget.budgetBytes}B budget — the page count is fixed, so a row got fatter`);
  assert.ok(bytes < DEFAULT_MAX_RESULT_BYTES / 2,
    `default page is ${bytes}B — too close to the ${DEFAULT_MAX_RESULT_BYTES}B ceiling`);
});

// ── backlog_graph ────────────────────────────────────────────────────────

test('backlog_graph: nodes are paged recent-first, edges are within-page, omission is explicit', () => {
  const g = fleetGraph(200);
  const out = projectBacklogGraph(g, {}) as Record<string, unknown>;
  const nodes = out.nodes as Array<Record<string, unknown>>;
  assert.strictEqual(nodes.length, BACKLOG_GRAPH_DEFAULT_NODES);
  // Recent first: highest updatedAt (the last-generated fixture) leads.
  assert.strictEqual(nodes[0].id, 'bl_00000199');
  assert.strictEqual(out.total, 200);
  assert.strictEqual(out.hasMore, true);
  assert.strictEqual(out.edgesTotal, 199, 'the whole visible graph stays countable');
  const edges = out.edges as Array<Record<string, string>>;
  const shownIds = new Set(nodes.map((n) => String(n.id)));
  assert.ok(edges.length > 0, 'within-page edges survive');
  for (const e of edges) {
    assert.ok(shownIds.has(e.from) && shownIds.has(e.to), `edge ${e.from}->${e.to} leaks outside the shown page`);
  }
  assert.strictEqual(out.edgesShown, edges.length);
  assert.match(String(out.hint || ''), /limit/, 'hint must say how to reach the rest');
});

test('backlog_graph: nodes are slim — no counts/updatedAt, removed only when true', () => {
  const g = fleetGraph(3);
  (g.nodes as Array<Record<string, unknown>>)[0].removed = true;
  const out = projectBacklogGraph(g, {}) as Record<string, unknown>;
  const nodes = out.nodes as Array<Record<string, unknown>>;
  // Recent-first: fixture 2 first, fixture 0 (the removed one) last.
  assert.strictEqual(nodes[2].removed, true);
  assert.strictEqual(nodes[0].removed, undefined);
  for (const n of nodes) {
    assert.strictEqual(n.counts, undefined, 'counts are list detail, not graph detail');
    assert.strictEqual(n.updatedAt, undefined, 'updatedAt only served the sort');
    assert.ok(n.id && n.title && n.type && n.status && n.priority, 'drawable identity survives');
  }
});

test('backlog_graph: a raised limit reaches the whole graph', () => {
  const g = fleetGraph(90);
  const out = projectBacklogGraph(g, { limit: 1000 }) as Record<string, unknown>;
  assert.strictEqual((out.nodes as unknown[]).length, 90);
  assert.strictEqual((out.edges as unknown[]).length, 89);
  assert.strictEqual(out.hasMore, false);
});

test('backlog_graph: the default page stays under its budget however large the fleet grows', () => {
  const budget = MEASURED_BUDGETS.backlog_graph;
  assert.ok(budget, 'backlog_graph must stay budgeted');
  const bytes = B(projectBacklogGraph(fleetGraph(500), {}));
  assert.ok(bytes <= budget.budgetBytes,
    `default page is ${bytes}B, over its ${budget.budgetBytes}B budget — the node page is fixed, so a node got fatter or edges densified`);
  assert.ok(bytes < DEFAULT_MAX_RESULT_BYTES / 2,
    `default page is ${bytes}B — too close to the ${DEFAULT_MAX_RESULT_BYTES}B ceiling`);
});
