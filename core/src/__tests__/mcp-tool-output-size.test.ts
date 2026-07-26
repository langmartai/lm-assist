/**
 * Standing guard: no MCP tool may quietly grow big enough to kill a conversation.
 *
 * On 2026-07-25 one `mission_list` call returned 1,757 KB and consumed 58% of a
 * live 110-message conversation, leaving it permanently unable to accept input.
 * The audit that followed (docs/mcp-tool-output-audit.md) found three tools
 * LARGER than that one which nobody was tracking. This test exists so the next
 * one is caught by CI instead of by a dead conversation.
 *
 * THE ANTI-ROT MECHANISM is the coverage test, not the size test. A ceiling
 * alone cannot notice a tool that was added after the audit. So:
 *
 *   1. every tool on the live surface must be either budgeted or explicitly
 *      excused in tool-output-budget.ts — a new tool with no entry FAILS, which
 *      forces whoever adds it to state what bounds its output;
 *   2. a budgeted tool may shrink freely but may not grow past its budget;
 *   3. the ext-plugin hard cap must still exist.
 *
 * The size checks need a running Core with real data, so they self-skip when
 * one is not reachable (same idiom as voice-audio-flow.test.ts) — a developer
 * laptop without Core running gets a clean skip, CI with Core up gets the guard.
 * The coverage and cap checks are pure and always run.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MEASURED_BUDGETS, NOT_MEASURED, EXT_TOOL_PREFIX, EXT_AGGREGATOR_CAP_BYTES,
  TOOL_OUTPUT_SOFT_BYTES, TOOL_OUTPUT_HARD_BYTES,
} from '../mcp-server/tool-output-budget';

const PORT = Number(process.env.LM_TEST_MCP_PORT || (__dirname.includes('node_modules') ? 3100 : 3200));
/**
 * Per-call cap. Deliberately tight: the slowest legitimate tool measured 5.7s,
 * so 15s is generous for a real answer while stopping one wedged tool from
 * dominating the run. This is not hypothetical — `bootstrap` and
 * `session_status` were both observed hanging indefinitely on prod during this
 * audit (see docs/mcp-tool-output-audit.md), and a 90s per-call timeout turned
 * a 3s sweep into a 93s one.
 */
const TIMEOUT_MS = Number(process.env.LM_TOOL_SIZE_CALL_TIMEOUT_MS || 15_000);

function apiToken(): string | null {
  for (const f of ['api-token', 'api-token-dev']) {
    try {
      const t = fs.readFileSync(path.join(os.homedir(), '.lm-assist', f), 'utf8').trim();
      if (t) return t;
    } catch { /* next */ }
  }
  return null;
}

/** A StreamableHTTP response is either plain JSON or a single SSE `data:` frame. */
function parseMcp(raw: string): any {
  const s = raw.trim();
  if (s.startsWith('event:') || s.startsWith('data:')) {
    const joined = s.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    try { return JSON.parse(joined); } catch { return null; }
  }
  try { return JSON.parse(s); } catch { return null; }
}

async function rpc(method: string, params: unknown): Promise<any> {
  const tok = apiToken();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(tok ? { 'x-api-key': tok } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ac.signal,
    });
    return parseMcp(await res.text());
  } finally { clearTimeout(t); }
}

/**
 * Bytes of a tool result that actually land in context. Image blocks are
 * counted as a flat nominal cost, NOT by base64 length: Claude tokenizes an
 * image by dimensions (~≤1600 tokens), so charging a 950 KB screenshot its byte
 * length would flag the wrong tools.
 */
const IMAGE_NOMINAL_BYTES = 6_000;
function resultTextBytes(result: any): number {
  const content = result?.content;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content) {
    if (typeof c?.text === 'string') n += Buffer.byteLength(c.text, 'utf8');
    else if (c?.type === 'image') n += IMAGE_NOMINAL_BYTES;
  }
  return n;
}

async function liveToolNames(): Promise<string[] | null> {
  try {
    const r = await rpc('tools/list', {});
    const tools = r?.result?.tools;
    if (!Array.isArray(tools) || tools.length === 0) return null;
    return tools.map((t: any) => String(t.name));
  } catch { return null; }
}

let cachedNames: string[] | null | undefined;
async function toolNames(): Promise<string[] | null> {
  if (cachedNames === undefined) cachedNames = await liveToolNames();
  return cachedNames;
}

// ── pure checks — always run ─────────────────────────────────────────────

test('the budget file is internally consistent', () => {
  assert.ok(TOOL_OUTPUT_SOFT_BYTES < TOOL_OUTPUT_HARD_BYTES, 'soft ceiling must be below hard');
  for (const [name, b] of Object.entries(MEASURED_BUDGETS)) {
    assert.ok(
      b.budgetBytes >= b.measuredBytes,
      `${name}: budget ${b.budgetBytes} is below its own measured ${b.measuredBytes} — the guard would fail on a clean run`,
    );
    // Anything meaningfully over the hard ceiling is tracked debt and must say so,
    // otherwise a big tool could sit in the table labelled SAFE forever.
    if (b.measuredBytes > TOOL_OUTPUT_HARD_BYTES) {
      assert.notStrictEqual(
        b.verdict, 'SAFE',
        `${name}: measured ${b.measuredBytes}B exceeds the hard ceiling but is marked SAFE`,
      );
    }
  }
  const overlap = Object.keys(MEASURED_BUDGETS).filter((n) => n in NOT_MEASURED);
  assert.deepStrictEqual(overlap, [], `tools both measured and excused: ${overlap.join(', ')}`);
});

test('the ext-plugin aggregator still hard-caps third-party results', () => {
  // The ext surface is the only one with a universal cap. If this constant or
  // the capResult call ever goes away, 55+ tools whose bodies live outside this
  // repo lose their only bound — so assert the mechanism, not just the number.
  assert.strictEqual(EXT_AGGREGATOR_CAP_BYTES, 1024 * 1024);
  const model = fs.readFileSync(path.join(__dirname, '..', 'mcp-server', 'plugins', 'model.js'), 'utf8');
  assert.match(model, /maxResultBytes/, 'PLUGIN_LIMITS.maxResultBytes disappeared from the plugin model');
  const client = fs.readFileSync(path.join(__dirname, '..', 'mcp-server', 'plugins', 'client.js'), 'utf8');
  assert.match(client, /capResult/, 'capResult disappeared — plugin results would flow through uncapped');
  assert.match(client, /maxResultBytes/, 'client no longer reads the cap');
});

// ── live checks — need a running Core ────────────────────────────────────

test('every tool on the live surface is classified (this is what stops the audit rotting)', async (t) => {
  const names = await toolNames();
  if (!names) return t.skip(`no Core on :${PORT}`);

  const unclassified = names
    .filter((n) => !n.startsWith(EXT_TOOL_PREFIX))
    .filter((n) => !(n in MEASURED_BUDGETS) && !(n in NOT_MEASURED));

  assert.deepStrictEqual(
    unclassified, [],
    `${unclassified.length} tool(s) on the surface have no output-size classification.\n` +
    `Add each to MEASURED_BUDGETS (read-only, safe to invoke) or NOT_MEASURED (with a reason) ` +
    `in core/src/mcp-server/tool-output-budget.ts:\n  ${unclassified.join('\n  ')}\n` +
    `This check exists so a tool added after the 2026-07-26 audit cannot ship unmeasured.`,
  );
});

test('no budgeted read-only tool has grown past its budget', async (t) => {
  const names = await toolNames();
  if (!names) return t.skip(`no Core on :${PORT}`);
  const live = new Set(names);

  const failures: string[] = [];
  const newlyOver: string[] = [];
  const hung: string[] = [];

  // A full sweep of ~70 live tool calls measured 97-121s, which would eat half
  // the batch runner's 240s budget on its own (scripts/run-tests.js) — and per
  // that runner's own lesson, a suite that runs long is a suite that gets
  // disabled. So the sweep is wall-clock bounded and ordered
  // BIGGEST-BUDGET-FIRST, so the tools that can actually kill a conversation are
  // always the ones that get checked, and the tail is dropped loudly rather than
  // silently. Set LM_TOOL_SIZE_FULL=1 for the exhaustive run (CI nightly / the
  // scheduled fleet check).
  const deadline = Date.now() + Number(process.env.LM_TOOL_SIZE_BUDGET_MS || 25_000);
  const full = process.env.LM_TOOL_SIZE_FULL === '1';
  const ordered = Object.entries(MEASURED_BUDGETS).sort((a, b) => b[1].measuredBytes - a[1].measuredBytes);
  const skipped: string[] = [];

  for (const [name, budget] of ordered) {
    if (!live.has(name)) continue; // tool retired or not on this node — not a size failure
    if (!full && Date.now() > deadline) { skipped.push(name); continue; }
    // Args are deliberately empty: the audit is about what a caller gets when
    // they do NOT pass a limit, which is the case that killed the conversation.
    const args = name === 'data_query' ? { dataset: 'knowledge' }
      : name === 'search' || name === 'search_memory' ? { query: 'voice' }
      : {};
    let bytes: number;
    try {
      const r = await rpc('tools/call', { name, arguments: args });
      if (!r?.result) continue;      // refusal/transport hiccup — not a size signal
      bytes = resultTextBytes(r.result);
    } catch {
      // Aborted at TIMEOUT_MS. A tool that will not answer is a real problem,
      // but it is a liveness problem, not a size regression — report it and
      // keep going rather than failing this guard for the wrong reason.
      hung.push(name);
      continue;
    }
    if (bytes === 0) continue;       // needs an id we did not supply

    if (bytes > budget.budgetBytes) {
      failures.push(
        `${name}: ${bytes}B exceeds its budget of ${budget.budgetBytes}B ` +
        `(was ${budget.measuredBytes}B at the audit, ${budget.bound}/${budget.verdict})`,
      );
    }
    if (bytes > TOOL_OUTPUT_HARD_BYTES && budget.verdict === 'SAFE') {
      newlyOver.push(`${name}: ${bytes}B is over the ${TOOL_OUTPUT_HARD_BYTES}B hard ceiling but is marked SAFE`);
    }
  }

  if (hung.length) {
    t.diagnostic(
      `tool(s) did not answer within ${TIMEOUT_MS}ms and were not size-checked: ${hung.join(', ')}. ` +
      `That is a liveness problem worth chasing separately — see the bootstrap/session_status ` +
      `hang recorded in docs/mcp-tool-output-audit.md.`,
    );
  }

  // Never let a bounded sweep read as full coverage — say what was dropped.
  if (skipped.length) {
    t.diagnostic(
      `time budget reached; ${skipped.length} smaller tool(s) not measured this run ` +
      `(largest budgets were checked first): ${skipped.join(', ')}. ` +
      `Run with LM_TOOL_SIZE_FULL=1 for the exhaustive sweep.`,
    );
  }

  assert.deepStrictEqual(
    [...failures, ...newlyOver], [],
    `MCP tool output grew past budget:\n  ${[...failures, ...newlyOver].join('\n  ')}\n` +
    `Either the tool needs a cap/pagination, or the fleet grew and the budget needs a ` +
    `deliberate bump in core/src/mcp-server/tool-output-budget.ts (bump it knowingly — ` +
    `these numbers are the early warning, not paperwork).`,
  );
});
