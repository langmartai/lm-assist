import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFilter, compactResult, compactRecord, numArg, boolArg } from '../mcp-server/tools/data-tools-format';

/**
 * Guards two LLM-usability fixes for the data_* MCP tools, both found by an
 * end-to-end run through the live langmart connector on 2026-06-20:
 *  (1) data_query silently returned 0 rows for a symbolic operator (`>=`, `=`)
 *      because the engine only knows named ops {eq,ne,gt,gte,lt,lte,in,contains}
 *      and an unknown op falls through to `return false` — a confidently-wrong
 *      empty result with no error.
 *  (2) data_search/data_query returned FULL record bodies; one knowledge record
 *      is ~50KB, so 3 results = ~63KB and blew the MCP token cap → the tool
 *      result was unusable (dumped to a file).
 */

// ---- (1) filter operator normalization ----

test('normalizeFilter maps symbolic operators to the engine names', () => {
  assert.deepEqual(normalizeFilter([{ field: 'n', op: '>=', value: 2 }]), [{ field: 'n', op: 'gte', value: 2 }]);
  assert.deepEqual(normalizeFilter([{ field: 'n', op: '>', value: 2 }]), [{ field: 'n', op: 'gt', value: 2 }]);
  assert.deepEqual(normalizeFilter([{ field: 'n', op: '<=', value: 2 }]), [{ field: 'n', op: 'lte', value: 2 }]);
  assert.deepEqual(normalizeFilter([{ field: 'n', op: '<', value: 2 }]), [{ field: 'n', op: 'lt', value: 2 }]);
  assert.deepEqual(normalizeFilter([{ field: 'n', op: '=', value: 2 }]), [{ field: 'n', op: 'eq', value: 2 }]);
  assert.deepEqual(normalizeFilter([{ field: 'n', op: '==', value: 2 }]), [{ field: 'n', op: 'eq', value: 2 }]);
  assert.deepEqual(normalizeFilter([{ field: 'n', op: '!=', value: 2 }]), [{ field: 'n', op: 'ne', value: 2 }]);
});

test('normalizeFilter passes canonical operators through unchanged', () => {
  for (const op of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains']) {
    assert.equal(normalizeFilter([{ field: 'f', op, value: 1 }])![0].op, op);
  }
});

test('normalizeFilter throws a clear, listing error on an unknown operator', () => {
  assert.throws(
    () => normalizeFilter([{ field: 'n', op: 'approx', value: 2 }]),
    /BAD_FILTER_OP[\s\S]*gte[\s\S]*contains/,
  );
});

test('normalizeFilter accepts regex/wildcard/nin/exists and preserves flags', () => {
  assert.equal(normalizeFilter([{ field: 't', op: 'regex', value: 'a.*' }])![0].op, 'regex');
  assert.equal(normalizeFilter([{ field: 't', op: 'wildcard', value: 'a*' }])![0].op, 'wildcard');
  assert.equal(normalizeFilter([{ field: 't', op: 'nin', value: [1, 2] }])![0].op, 'nin');
  assert.equal(normalizeFilter([{ field: 't', op: 'exists', value: true }])![0].op, 'exists');
  assert.equal(normalizeFilter([{ field: 't', op: 'regex', value: 'a', flags: 'i' }])![0].flags, 'i');
});

test('normalizeFilter rejects an invalid regex pattern with a clear error', () => {
  assert.throws(() => normalizeFilter([{ field: 't', op: 'regex', value: '(' }]), /BAD_REGEX/);
});

test('normalizeFilter rejects a non-array filter (the silently-ignored object form)', () => {
  assert.throws(() => normalizeFilter({ name: 'beta' } as any), /BAD_FILTER/);
});

test('normalizeFilter treats null/undefined as "no filter"', () => {
  assert.equal(normalizeFilter(undefined), undefined);
  assert.equal(normalizeFilter(null), undefined);
  assert.deepEqual(normalizeFilter([]), []);
});

// ---- numeric arg coercion (MCP connector sends number args as strings) ----

test('numArg coerces numeric strings — the connector stringifies number args', () => {
  assert.equal(numArg('10'), 10);   // arrives as a string over the hub relay
  assert.equal(numArg(10), 10);     // already a number (stdio path)
  assert.equal(numArg('0'), 0);
  assert.equal(numArg('  42 '), 42);
});

test('numArg rejects non-numeric / empty as undefined (use the default)', () => {
  assert.equal(numArg(undefined), undefined);
  assert.equal(numArg(''), undefined);
  assert.equal(numArg('abc'), undefined);
  assert.equal(numArg(null), undefined);
  assert.equal(numArg(NaN), undefined);
});

test('boolArg accepts bool/"true"/1, rejects everything else (connector stringifies bools too)', () => {
  for (const v of [true, 'true', 1, '1']) assert.equal(boolArg(v), true);
  for (const v of [false, 'false', 0, '0', undefined, null, 'no', '']) assert.equal(boolArg(v), false);
});

// ---- (2) bounded projection ----

test('compactResult shrinks a huge query result well under the MCP cap', () => {
  const big = {
    records: [{
      id: 'K057', version: 1,
      fields: { title: 'big', type: 'schema', parts: Array.from({ length: 50 }, (_, i) => ({ partId: 'p' + i, summary: 'x'.repeat(500) })) },
      text: 'y'.repeat(22000),
    }],
    total: 1,
  };
  const out: any = compactResult(big);
  const size = JSON.stringify(out).length;
  assert.ok(size < 3000, `expected compacted query < 3000 chars, got ${size}`);
  assert.equal(out.total, 1);
  assert.equal(out.records[0].id, 'K057');
});

test('compactResult handles the bare-array search shape and preserves score+id', () => {
  const arr = [{ id: 'K1', score: 0.91, version: 1, fields: { title: 'a' }, text: 'short text' }];
  const out: any = compactResult(arr);
  assert.ok(Array.isArray(out));
  assert.equal(out[0].id, 'K1');
  assert.equal(out[0].score, 0.91);
});

test('compactResult leaves small records fully intact (no lossy compaction)', () => {
  const small = { records: [{ id: 'r1', version: 1, fields: { name: 'alpha', n: 1, tag: 'x' }, text: 'the first alpha record' }], total: 1 };
  const out: any = compactResult(small);
  assert.equal(out.records[0].fields.name, 'alpha');
  assert.equal(out.records[0].fields.n, 1);
  assert.equal(out.records[0].text, 'the first alpha record');
});

test('compactRecord truncates a giant single record but keeps id and notes truncation', () => {
  const rec = { id: 'K057', version: 1, fields: { title: 't' }, text: 'z'.repeat(40000) };
  const out: any = compactRecord(rec, 12000);
  const size = JSON.stringify(out).length;
  assert.ok(size <= 12000, `expected <= 12000, got ${size}`);
  assert.equal(out.id, 'K057');
  assert.ok(typeof out.text === 'string' && out.text.length < 40000);
});
