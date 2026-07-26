/**
 * Row bounds for the data service (backlog bl_47b5c8d8).
 *
 * `data_query` was the last tool on the surface that TRUNCATED into a dead end:
 * measured live on node 117 it produced 962,799 bytes for one call, got cut to
 * 65,856 by the central ceiling, and its schema was {dataset, query, key, node}
 * — so the truncation marker's advice ("narrow the call: pass limit/offset")
 * named arguments the tool did not have. Repeating the call returned the same
 * prefix forever.
 *
 * Datasets are USER-EXTENSIBLE, so no static per-tool byte budget can be right;
 * the bound has to be a row count in the owning service. Two different numbers
 * do two different jobs here, and conflating them is what breaks things:
 *
 *   - MAX_QUERY_ROWS is a HARD CEILING in the service. It exists to stop an
 *     unbounded full-store return, and it must never silently truncate a
 *     legitimate internal enumeration.
 *   - DEFAULT_MCP_QUERY_ROWS is a SMALL DEFAULT at the MCP layer only. It is
 *     what actually protects a conversation, and it applies to LLM callers
 *     alone — the REST route the web UI uses is untouched, same as the mission
 *     projections.
 *
 * The third bug here is not about size at all: `q.limit` was never coerced, and
 * the relay serialises number args as STRINGS (documented for data_get in
 * data-tools-format.ts). `rows.slice(offset, offset + limit)` with a string
 * limit CONCATENATES — offset 10 + "50" = "1050" — so a caller asking for 50
 * rows got 1,040.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  applyQuery, boundQuerySpec, MAX_QUERY_ROWS, rowArg,
} from '../data/backends/query-filter';
import { DATA_TOOL_DEFS, DEFAULT_MCP_QUERY_ROWS } from '../mcp-server/tools/data-tools';
import type { DataRecord } from '../data/types';

const rows = (n: number): DataRecord[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, fields: { i } }) as unknown as DataRecord);

function schemaOf(name: string): Record<string, unknown> {
  const def = DATA_TOOL_DEFS.find((t) => t.name === name);
  assert.ok(def, `${name} is not in DATA_TOOL_DEFS`);
  return (def as { inputSchema?: { properties?: Record<string, unknown> } }).inputSchema?.properties || {};
}

// ── the coercion bug ─────────────────────────────────────────────────────

test('a numeric-STRING limit is coerced, not string-concatenated', () => {
  // The relay sends number args as strings. Before the fix this returned 1,040
  // rows (slice(10, 10 + "50") -> slice(10, "1050")), silently ignoring the cap.
  const r = applyQuery(rows(2000), { offset: 10, limit: '50' as unknown as number });
  assert.strictEqual(r.records.length, 50, 'string limit must bound to 50 rows');
  assert.strictEqual(r.total, 2000, 'total must report the pre-pagination count');
});

test('a numeric-STRING offset is coerced too', () => {
  const r = applyQuery(rows(100), { offset: '10' as unknown as number, limit: 5 });
  assert.strictEqual(r.records.length, 5);
  assert.deepStrictEqual(r.records.map((x) => x.id), ['r10', 'r11', 'r12', 'r13', 'r14']);
});

test('rowArg rejects junk rather than propagating NaN into a slice', () => {
  assert.strictEqual(rowArg('abc', 7), 7);
  assert.strictEqual(rowArg(undefined, 7), 7);
  assert.strictEqual(rowArg(-1, 7), 7, 'negative row counts are not meaningful');
  assert.strictEqual(rowArg('25', 7), 25);
  assert.strictEqual(rowArg(25.9, 7), 25);
});

// ── the hard ceiling ─────────────────────────────────────────────────────

test('an ABSENT limit is bounded by the ceiling instead of returning the whole store', () => {
  // `const limit = q.limit ?? out.length` was the unbounded default: every row
  // in the dataset, for the vector and knowledge backends the entire store.
  const r = applyQuery(rows(MAX_QUERY_ROWS + 500), {});
  assert.strictEqual(r.records.length, MAX_QUERY_ROWS);
  assert.strictEqual(r.total, MAX_QUERY_ROWS + 500, 'total still reports the true count');
});

test('a limit above the ceiling is clamped', () => {
  const r = applyQuery(rows(MAX_QUERY_ROWS + 500), { limit: MAX_QUERY_ROWS * 10 });
  assert.strictEqual(r.records.length, MAX_QUERY_ROWS);
});

test('THE CEILING MUST NOT TRUNCATE AN INTERNAL ENUMERATION', () => {
  // mission-store.ts, workflow-store.ts, mission-views-store.ts and
  // doc-store.ts all load their whole dataset with an explicit {limit: 10000}.
  // A ceiling below that would silently drop missions, workflows and backlog
  // items — the stores would look empty-ish with no error anywhere. This is the
  // constraint that sets the number, so it is asserted, not assumed.
  const INTERNAL_ENUMERATION_LIMIT = 10_000;
  assert.ok(
    MAX_QUERY_ROWS >= INTERNAL_ENUMERATION_LIMIT,
    `MAX_QUERY_ROWS (${MAX_QUERY_ROWS}) is below the {limit:${INTERNAL_ENUMERATION_LIMIT}} used by ` +
    `mission-store/workflow-store/doc-store — it would silently truncate them`,
  );
  const r = applyQuery(rows(INTERNAL_ENUMERATION_LIMIT), { limit: INTERNAL_ENUMERATION_LIMIT });
  assert.strictEqual(r.records.length, INTERNAL_ENUMERATION_LIMIT);
});

test('boundQuerySpec always yields a concrete, bounded limit/offset', () => {
  assert.deepStrictEqual(boundQuerySpec({}), { limit: MAX_QUERY_ROWS, offset: 0 });
  assert.deepStrictEqual(boundQuerySpec({ limit: 10, offset: 5 }), { limit: 10, offset: 5 });
  // Preserves the rest of the spec untouched.
  const withFilter = boundQuerySpec({ filter: [{ field: 'a', op: 'eq', value: 1 }] as never });
  assert.ok(Array.isArray(withFilter.filter), 'filter must survive normalisation');
});

// ── the dead end is gone ─────────────────────────────────────────────────

test('data_query advertises limit/offset so the truncation marker gives followable advice', () => {
  const props = schemaOf('data_query');
  assert.ok(props.limit, 'data_query must expose a top-level `limit`');
  assert.ok(props.offset, 'data_query must expose a top-level `offset`');
});

test('data_keys advertises limit/offset instead of ignoring its arguments', () => {
  const props = schemaOf('data_keys');
  assert.ok(props.limit, 'data_keys must expose `limit`');
  assert.ok(props.offset, 'data_keys must expose `offset`');
});

test('the MCP default is small enough to leave a conversation usable', () => {
  // A summarised knowledge record measured 966 B on node 117 (962,799 B / 997
  // records). The default must land well under the 64 KiB result ceiling so the
  // guardrail stays a backstop rather than shaping the routine call.
  const MEASURED_BYTES_PER_SUMMARISED_RECORD = 966;
  const projected = DEFAULT_MCP_QUERY_ROWS * MEASURED_BYTES_PER_SUMMARISED_RECORD;
  assert.ok(
    projected < 32_768,
    `default page of ${DEFAULT_MCP_QUERY_ROWS} rows projects to ${projected} B — at or above half the ceiling`,
  );
});
