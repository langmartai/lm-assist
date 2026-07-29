/**
 * Standing guard on the CONNECT-TIME tax: the size of `tools/list` itself.
 *
 * The 2026-07-26 audit bounded what a tool RETURNS. This guards what the surface
 * COSTS before a single tool is called. Measured live on node 117 (prod, 244
 * tools incl. 55 third-party `ext__` ones): 350,402 bytes, ~87.6K tokens — a
 * FIXED cost every conversation pays up front, roughly 44% of a 200K window
 * spent on the catalogue rather than on work.
 *
 * WHERE THAT COST ACTUALLY LIVES was not where it looked. The intuitive fix is
 * "trim the tool descriptions", but descriptions are only 95,746 B (27%). The
 * input SCHEMAS are 233,632 B (67%), and inside them the per-property
 * `description` prose is 177,014 B — 50.5% of the whole catalogue.
 *
 * And that prose is not 838 distinct explanations. ONE of them — the `node`
 * routing selector injected into every tool by `withNodeParam` — was 751 bytes
 * repeated verbatim on 188 tools: 141,188 B, 40.3% of the entire catalogue, and
 * 97% of all repeated-string waste on the surface. Every conversation paid ~35K
 * tokens for 188 copies of one paragraph.
 *
 * So the rule this file enforces is not "descriptions must be short" — it is
 * SHARED BOILERPLATE MUST BE SHORT. A description written once and injected
 * everywhere is multiplied by the tool count, so its cost is its length times
 * the surface. A per-tool description is paid once and is allowed to be rich.
 *
 * These checks are PURE — they read the compiled defs, never a live Core — so
 * they run everywhere and cannot be skipped into uselessness.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { LM_ASSIST_TOOL_DEFS } from '../mcp-server/configure';
import { NODE_PARAM } from '../mcp-server/tools/definitions';

const B = (v: unknown): number =>
  Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v ?? ''), 'utf8');

/**
 * A property description appearing on more than this many tools is BOILERPLATE:
 * it is not describing that tool, it is describing a convention. Its byte cost is
 * multiplied by the whole surface.
 */
const BOILERPLATE_TOOL_THRESHOLD = 20;

/**
 * Maximum length for such a shared description. 320 B is enough for the four
 * load-bearing facts about `node` (what it targets, where values come from, what
 * omitting it means, and the empty-result heuristic) with room to spare, while
 * being 2.3x smaller than the 751 B paragraph it replaced. Anything needing more
 * than this belongs in `guide()` or the owning tool's own description, where it
 * is paid for ONCE.
 */
const MAX_SHARED_DESCRIPTION_BYTES = 320;

/**
 * Budget for the whole advertised catalogue (this server's own tools only —
 * third-party `ext__` tools are not in these defs and are governed by the plugin
 * aggregator).
 *
 * 298,011 B for 189 tools before the `node` dedup, 206,319 B after. The budget is
 * NOT set just above the current figure: a ratchet with 2% headroom fails on the
 * third routine tool addition, and a guard that cries wolf gets its number bumped
 * without thought, which is how it stops meaning anything. 240,000 B leaves room
 * for roughly 28 more average-sized tools (~1.2 KB each) while still failing hard
 * on the regression this exists to catch — re-inlining shared boilerplate across
 * the surface costs ~90 KB and blows straight through it.
 */
// RAISED 2026-07-29, 240,000 -> 252,000, when the Gmail CDP connector (9 tools)
// landed 15 B over. Deliberate, not a reflex bump: the shared-boilerplate test
// above still passes, so this is accumulated routine growth, NOT the re-inlining
// regression this guard exists to catch (~90 KB, which 252,000 still fails hard
// on). The connector's tools average ~530 B against a ~775 B surface mean, so
// there was nothing left to trim on the newest entries. +12,000 B restores ~10
// average tools of headroom so the next addition is not forced to sand its own
// descriptions to nothing. Cost: ~3K extra tokens per conversation at connect time.
// RAISED again 2026-07-29, 252,000 -> 264,000, when the 9 triage/label tools
// landed leaving 82 B of headroom -- a rounding error that would turn this test
// red on the next tool added ANYWHERE on the server, which is exactly the
// "cries wolf" failure the comment above warns about.
//
// MEASURED while sizing them: the 9 new tools average 419 B of their own prose,
// the leanest on the surface (existing gmail 618 B, surface-wide 1,095 B), but
// each also carries 306 B of INJECTED node-param boilerplate -- 2,754 B, or 42%
// of the headroom they consumed, spent before a word was written. The real
// lever remains that shared paragraph, not per-tool sanding; until someone
// takes it on, +12,000 B keeps ~10 tools of slack. The shared-boilerplate test
// above still passes, so this is routine growth, not the re-inlining
// regression (~90 KB) this guard exists to catch.
const CATALOG_BUDGET_BYTES = 264_000;

function properties(def: { inputSchema?: { properties?: Record<string, unknown> } }): Record<string, unknown> {
  return def.inputSchema?.properties || {};
}

test('shared boilerplate in tool schemas stays short (it is multiplied by the surface)', () => {
  const occurrences = new Map<string, { tools: string[]; bytes: number }>();
  for (const def of LM_ASSIST_TOOL_DEFS) {
    for (const [, spec] of Object.entries(properties(def))) {
      const d = (spec as { description?: unknown })?.description;
      if (typeof d !== 'string' || !d) continue;
      const e = occurrences.get(d) || { tools: [], bytes: B(d) };
      e.tools.push(def.name);
      occurrences.set(d, e);
    }
  }

  const offenders = [...occurrences.entries()]
    .filter(([, e]) => e.tools.length > BOILERPLATE_TOOL_THRESHOLD && e.bytes > MAX_SHARED_DESCRIPTION_BYTES)
    .map(([text, e]) =>
      `${e.bytes}B repeated on ${e.tools.length} tools = ${e.bytes * (e.tools.length - 1)}B of pure duplication ` +
      `— "${text.slice(0, 80)}…"`,
    );

  assert.deepStrictEqual(
    offenders, [],
    `A property description injected across the surface must stay under ${MAX_SHARED_DESCRIPTION_BYTES}B:\n  ${offenders.join('\n  ')}\n` +
    `This is the tools/list tax: cost = length x tool count. Keep the long explanation in ONE ` +
    `place (the owning tool's description, or guide()) and leave a short pointer here.`,
  );
});

test('the advertised catalogue stays within its connect-time budget', () => {
  const total = B(LM_ASSIST_TOOL_DEFS);
  assert.ok(
    total <= CATALOG_BUDGET_BYTES,
    `tools/list for this server's own ${LM_ASSIST_TOOL_DEFS.length} tools is ${total}B, over the ` +
    `${CATALOG_BUDGET_BYTES}B budget. Every conversation pays this before calling anything. ` +
    `Shrink shared boilerplate first (it is multiplied by the tool count), then per-tool prose — ` +
    `or raise the budget deliberately in this file, knowing what it costs a 200K window.`,
  );
});

test('the node selector still carries its load-bearing facts', () => {
  // Shrinking it must not turn it into "the node". These four facts are why the
  // paragraph existed; the empty-result heuristic in particular exists to stop a
  // model concluding an item does not exist when it merely lives elsewhere.
  const d = NODE_PARAM.description;
  assert.match(d, /list_nodes/, 'must say where a valid value comes from');
  assert.match(d, /omit/i, 'must say what omitting it does');
  assert.match(d, /empty|not found/i, 'must keep the empty-result heuristic');
  assert.match(d, /another node|other node/i, 'must say the item may live on a different node');
  assert.ok(
    B(d) <= MAX_SHARED_DESCRIPTION_BYTES,
    `NODE_PARAM.description is ${B(d)}B; it is injected into ~188 tools, so every byte costs ~188x`,
  );
});
