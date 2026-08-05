// Regression suite for the hard per-result byte ceiling (backlog bl_5cc4bad9).
//
// The incident: ONE `mission_list` result was 1,757 KB = 58% of a 110-message
// conversation, and the thread could no longer accept input. Re-measured live before the
// fix, `mission_list` was 923,758 bytes and `mission_query` 960,675 bytes PER CALL —
// each larger than the entire 200K-token context window.
//
// Every test here was MUTATION-VERIFIED: the guard was reverted and the test observed to
// fail, so a green run means the cap is really doing the work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

// This suite drives REAL covered tool names (mission_list) through the live
// configureMcpServer seam to prove the cap. The bootstrap gate sits on that
// same seam and would (a) refuse the un-bootstrapped fake caller and (b) spin
// up the live identity resolver, whose session-cache watcher leaks an open
// handle that hangs `node --test`. The gate is off here — it has its own
// suite (bootstrap-gate.test.ts) whose pure core needs no live deps.
process.env.LM_BOOTSTRAP_GATE = 'off';

import {
  capToolResult,
  maxResultBytes,
  sliceUtf8,
  formatBytes,
  DEFAULT_MAX_RESULT_BYTES,
  MIN_MAX_RESULT_BYTES,
} from '../mcp-server/result-cap';
import type { McpToolResult } from '../mcp-server/configure';

const textResult = (text: string): McpToolResult => ({ content: [{ type: 'text', text }] });
const bytesOfResult = (r: McpToolResult): number =>
  r.content.reduce((n, b) => n + (typeof b.text === 'string' ? Buffer.byteLength(b.text, 'utf8') : 0), 0);

// ─── the ceiling itself ──────────────────────────────────────────────────

test('a result under the ceiling is returned untouched, byte for byte', () => {
  const r = textResult('a small answer');
  const { result, size } = capToolResult(r, 'list_nodes', 1024);
  assert.equal(result.content[0].text, 'a small answer');
  assert.equal(size.truncated, false);
  assert.equal(size.originalBytes, 14);
  assert.equal(size.keptBytes, 14);
});

test('a result over the ceiling is cut to at most the ceiling', () => {
  // Stand-in for the real mission_list: ~900KB, far past any context window.
  const huge = 'x'.repeat(900_000);
  const { result, size } = capToolResult(textResult(huge), 'mission_list', 65_536);
  assert.equal(size.truncated, true);
  assert.equal(size.originalBytes, 900_000);
  assert.ok(
    bytesOfResult(result) <= 65_536,
    `capped result was ${bytesOfResult(result)} bytes, ceiling is 65536`,
  );
});

test('truncation is EXPLICIT — the marker names the bytes dropped and how to get the rest', () => {
  const { result } = capToolResult(textResult('y'.repeat(900_000)), 'mission_list', 65_536);
  const t = result.content[0].text || '';
  assert.match(t, /RESULT TRUNCATED/, 'must announce truncation');
  assert.match(t, /THE OUTPUT ABOVE IS INCOMPLETE/, 'must warn the prefix is not the whole set');
  assert.match(t, /900,000 bytes/, 'must state the original size exactly');
  assert.match(t, /DROPPED/, 'must say bytes were dropped');
  assert.match(t, /limit \/ offset \/ cursor|paging\/filter/, 'must say how to fetch the rest');
  assert.match(t, /mission_list/, 'must name the offending tool');
  assert.match(t, /MCP_RESULT_MAX_BYTES/, 'must name the knob that governs it');
});

test('the cut never splits a UTF-8 codepoint', () => {
  // 3-byte codepoints: any naive byte slice lands mid-sequence and yields U+FFFD.
  const multi = '日'.repeat(50_000); // 150,000 bytes
  const { result } = capToolResult(textResult(multi), 'search', 4_096);
  const t = result.content[0].text || '';
  assert.ok(!t.includes('�'), 'a replacement char means a codepoint was severed');
});

test('error results are capped too — a huge error kills a conversation just the same', () => {
  const r: McpToolResult = { content: [{ type: 'text', text: 'E'.repeat(500_000) }], isError: true };
  const { result, size } = capToolResult(r, 'agent_execute', 65_536);
  assert.equal(size.truncated, true);
  assert.equal(result.isError, true, 'capping must not lose the error flag');
  assert.ok(bytesOfResult(result) <= 65_536);
});

test('image/binary blocks pass through untouched but their cost is reported', () => {
  const r: McpToolResult = {
    content: [
      { type: 'text', text: 'screenshot attached' },
      { type: 'image', data: 'A'.repeat(200_000), mimeType: 'image/png' },
    ],
  };
  const { result, size } = capToolResult(r, 'mobile_screenshot', 65_536);
  // A truncated base64 payload is not a smaller image, it is a corrupt one.
  assert.equal(result.content[1].data?.length, 200_000, 'binary must never be sliced');
  assert.equal(size.binaryBytes, 200_000, 'but its cost must be visible');
  assert.equal(size.truncated, false, 'text was under the ceiling, so nothing was cut');
});

test('the beginning of a result survives — tools put the headline first', () => {
  const body = 'HEADLINE: 3 missions\n' + 'z'.repeat(900_000);
  const { result } = capToolResult(textResult(body), 'mission_list', 65_536);
  assert.match(result.content[0].text || '', /^HEADLINE: 3 missions/);
});

// ─── the configured ceiling ──────────────────────────────────────────────

test('the default ceiling clears the largest BY-DESIGN result', () => {
  // Measured live on this fleet: bootstrap is 55,572 bytes and is meant to be big (it
  // loads every use case in one call). A future edit that drops the default below it
  // would silently start truncating onboarding.
  const MEASURED_BOOTSTRAP_BYTES = 55_572;
  assert.ok(
    DEFAULT_MAX_RESULT_BYTES > MEASURED_BOOTSTRAP_BYTES,
    `default ${DEFAULT_MAX_RESULT_BYTES} must exceed bootstrap's measured ${MEASURED_BOOTSTRAP_BYTES}`,
  );
});

test('MCP_RESULT_MAX_BYTES overrides the default', () => {
  assert.equal(maxResultBytes({ MCP_RESULT_MAX_BYTES: '200000' } as NodeJS.ProcessEnv), 200_000);
});

test('a malformed or dangerously small ceiling falls back to the default, never disables the guard', () => {
  for (const bad of ['', 'lots', '-1', '0', String(MIN_MAX_RESULT_BYTES - 1)]) {
    assert.equal(
      maxResultBytes({ MCP_RESULT_MAX_BYTES: bad } as NodeJS.ProcessEnv),
      DEFAULT_MAX_RESULT_BYTES,
      `"${bad}" must fall back, not weaken the ceiling`,
    );
  }
  assert.equal(maxResultBytes({} as NodeJS.ProcessEnv), DEFAULT_MAX_RESULT_BYTES);
});

test('sliceUtf8 / formatBytes helpers', () => {
  assert.equal(sliceUtf8('abcdef', 3), 'abc');
  assert.equal(sliceUtf8('abc', 99), 'abc');
  assert.equal(sliceUtf8('日本', 4), '日'); // 4 bytes lands mid second codepoint
  assert.equal(formatBytes(512), '512B');
  assert.equal(formatBytes(65_536), '64.0KB');
  assert.equal(formatBytes(1_757_000), '1.68MB');
});

// ─── applied by the shared seam, so BOTH surfaces get it ─────────────────

/** Drive the real CallTool handler that `configureMcpServer` registers. Both transports
 *  (stdio + HTTP) register through this exact function, so what is proven here holds for
 *  both — see the wiring test below, which pins that they really do. */
async function callThroughSeam(toolName: string, result: McpToolResult): Promise<McpToolResult> {
  const { configureMcpServer } = require('../mcp-server/configure');
  const { CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const handlers = new Map<unknown, (req: unknown) => Promise<McpToolResult>>();
  const fakeServer = { setRequestHandler: (schema: unknown, fn: never) => handlers.set(schema, fn) };
  configureMcpServer(fakeServer, async () => result);
  const handler = handlers.get(CallToolRequestSchema);
  assert.ok(handler, 'configureMcpServer must register a CallTool handler');
  return handler({ params: { name: toolName, arguments: {} } });
}

test('an oversized result is truncated when it goes through the shared MCP seam', async () => {
  const res = await callThroughSeam('mission_list', textResult('q'.repeat(900_000)));
  const t = res.content[0].text || '';
  assert.match(t, /RESULT TRUNCATED/, 'the seam must apply the cap');
  assert.ok(
    Buffer.byteLength(t, 'utf8') < 900_000 / 10,
    `seam returned ${Buffer.byteLength(t, 'utf8')} bytes — the cap did not fire`,
  );
});

test('the footer survives truncation and reports the size', async () => {
  const res = await callThroughSeam('mission_list', textResult('q'.repeat(900_000)));
  const t = res.content[0].text || '';
  // The footer is appended AFTER the cap precisely so it can never be the thing cut off.
  assert.match(t, /⟦lm-assist/, 'origin footer must still be present on a truncated result');
  assert.match(t, /TRUNCATED/, 'footer must flag the truncation');
  assert.match(t, /879\.0KB→|→6[0-9.]+KB/, 'footer must show before→after bytes');
});

test('a normal result gets a byte count in its footer', async () => {
  const res = await callThroughSeam('list_nodes', textResult('two nodes online'));
  const t = res.content[0].text || '';
  assert.match(t, /⟦lm-assist/, 'origin footer present');
  assert.match(t, /· 16B/, 'footer must report the result size so cost is visible');
});

test('BOTH MCP surfaces route through configureMcpServer, so neither can bypass the cap', () => {
  // This is what actually makes the guarantee fleet-wide. If a future surface dispatched
  // tools without going through this seam, every test above would still pass while that
  // surface stayed uncapped.
  const src = join(__dirname, '..', '..', 'src');
  const stdio = readFileSync(join(src, 'mcp-server', 'index.ts'), 'utf-8');
  const http = readFileSync(join(src, 'routes', 'core', 'mcp.routes.ts'), 'utf-8');
  for (const [name, code] of [['stdio', stdio], ['http', http]] as const) {
    assert.match(code, /configureMcpServer\(/, `${name} surface must dispatch through configureMcpServer`);
  }
  // …and the seam must actually apply the cap.
  const configure = readFileSync(join(src, 'mcp-server', 'configure.ts'), 'utf-8');
  assert.match(configure, /capToolResult\(/, 'the shared seam must apply the byte ceiling');
  // Ordering is load-bearing: cap BEFORE the footer, else the footer gets cut off.
  assert.ok(
    configure.indexOf('capToolResult(') < configure.indexOf('withOriginTag(result, name'),
    'the cap must run BEFORE the footer is appended',
  );
});
