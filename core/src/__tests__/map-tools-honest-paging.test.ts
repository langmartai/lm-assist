/**
 * A BOUNDED answer must also be an HONEST one (backlog bl_8a737823).
 *
 * `memory_map` was already bounded — 827,724 B pre-cap was cut to a 60-record
 * default, measuring 36,053 B live on node 117. That fixed the liveness problem
 * and left a subtler one: it returned a BARE ARRAY. 60 records out of 1,313 is
 * indistinguishable from a map that only HAS 60, so a model reads the short list
 * as complete and concludes a memory does not exist when it was simply on page 2.
 *
 * That is the same failure the central truncation marker exists to prevent, and
 * the repo's own `paginate()` says so: "a bare truncated array reads as a
 * complete one". The map tools now report total/shown/offset/hasMore and, when
 * rows remain, the exact next call.
 *
 * These maps are the ACCUMULATE-FOREVER shape: records are never pruned, and
 * every host mirror re-emits the full set, so the payload is a function of how
 * long the fleet has run. `rule_map` is the same code path one incident behind —
 * it had no default limit at all — so it gets the same treatment.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { mapPage, EXPANDED_TOOL_DEFS } from '../mcp-server/tools/expanded';

const envelope = (total: number, shown: number, offset = 0, limit = 60) =>
  JSON.stringify({
    total, shown, offset, limit,
    records: Array.from({ length: shown }, (_, i) => ({ recordId: `m${offset + i}` })),
  });

function schemaOf(name: string): Record<string, unknown> {
  const def = (EXPANDED_TOOL_DEFS as ReadonlyArray<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>)
    .find((t) => t.name === name);
  assert.ok(def, `${name} not found in EXPANDED_TOOL_DEFS`);
  return def!.inputSchema?.properties || {};
}

test('a partial page says so, and says exactly how to get the rest', () => {
  const out = JSON.parse(mapPage(envelope(1313, 60), (n) => `memory_map({offset:${n}, limit:60})`));
  assert.strictEqual(out.total, 1313);
  assert.strictEqual(out.shown, 60);
  assert.strictEqual(out.hasMore, true);
  assert.match(out.more, /1253 more record/, 'must say how many were dropped');
  assert.match(out.more, /memory_map\(\{offset:60, limit:60\}\)/, 'must name the exact next call');
  assert.strictEqual(out.records.length, 60);
});

test('a complete page does NOT nag', () => {
  const out = JSON.parse(mapPage(envelope(12, 12), (n) => `memory_map({offset:${n}})`));
  assert.strictEqual(out.hasMore, false);
  assert.strictEqual(out.more, undefined, 'a full answer must not carry a paging nudge');
});

test('the last page is recognised as the last page', () => {
  const out = JSON.parse(mapPage(envelope(100, 40, 60), (n) => `memory_map({offset:${n}})`));
  assert.strictEqual(out.hasMore, false, 'offset 60 + 40 shown = 100 total');
  assert.strictEqual(out.offset, 60);
});

test('non-envelope output passes through untouched', () => {
  // `--stats` and `--format md` have their own shapes, and a CLI that has not been
  // rebuilt still emits a bare array. None of them may be mangled into an envelope.
  const stats = JSON.stringify({ total: 5, byProject: { a: 5 } });
  assert.strictEqual(mapPage(stats, () => 'x'), stats);
  const bareArray = JSON.stringify([{ recordId: 'a' }]);
  assert.strictEqual(mapPage(bareArray, () => 'x'), bareArray);
  assert.strictEqual(mapPage('not json at all', () => 'x'), 'not json at all');
});

test('both map tools expose offset so the nudge is followable', () => {
  for (const tool of ['memory_map', 'rule_map']) {
    const props = schemaOf(tool);
    assert.ok(props.limit, `${tool} must expose limit`);
    assert.ok(props.offset, `${tool} must expose offset`);
  }
});
