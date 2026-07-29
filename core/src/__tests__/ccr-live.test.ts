/**
 * ccr-live — classification, liveness, and the honesty rules around bounding.
 *
 * Every fixture field below is taken from a REAL `GET /v1/sessions` response
 * measured on 117 (2026-07-29, 100 rows). The three assumptions these tests pin
 * down are exactly the ones the original spec got wrong:
 *   - the discriminator is `environment_kind`, not `type`
 *   - `cwd` is empty upstream
 *   - `connection_status: connected` does NOT mean live
 */

import { test } from 'node:test';
import assert from 'node:assert';
import {
  classifyKind,
  classifyVia,
  isLive,
  projectRow,
  selectSessions,
  listLiveSessions,
  type RawSession,
} from '../terminal/ccr-live';

/** The live bridge session that motivated the feature, verbatim from the wire. */
const NATIVE_INJECT: RawSession = {
  id: 'session_01BE75qk8VwRHjRXwAMrTvuL',
  title: '117-lm-assist-ccr',
  type: 'internal_session',
  environment_kind: 'bridge',
  environment_id: '',
  connection_status: 'connected',
  session_status: 'running',
  status_bucket: 'working',
  tags: ['remote-control-auto'],
  origin: 'claude_code_cli',
  unread: true,
  created_at: '2026-07-29T04:10:03.577082Z',
  updated_at: '2026-07-29T04:41:06.310351Z',
  external_metadata: { current_branches: { 'langmartai/lm-assist': 'main' } },
  session_context: { cwd: '', model: 'claude-opus-5' },
};

const LM_ASSIST_BRIDGE: RawSession = {
  ...NATIVE_INJECT,
  id: 'session_01EprF5P1LrXLSXjcH6GvBG8',
  title: 'MCP deploy: node targeting',
  tags: ['remote-control-repl'],
  session_status: 'idle',
  status_bucket: 'review_ready',
};

/** Archived BUT still connected — the row shape that breaks a naive liveness check. */
const ARCHIVED_BUT_CONNECTED: RawSession = {
  ...NATIVE_INJECT,
  id: 'session_012rQscqdX6oWFJCDHV6atqg',
  title: 'desktop-gdklatg-quizzical-glacier',
  connection_status: 'connected',
  session_status: 'archived',
  status_bucket: 'completed',
  tags: ['remote-control-repl'],
};

const CLOUD: RawSession = {
  id: 'session_cloudy',
  title: 'a cloud run',
  type: 'internal_session',
  environment_kind: 'anthropic_cloud',
  environment_id: 'env_01WeVmrUzj5WJZ8n1u7VjGfp',
  connection_status: 'disconnected',
  session_status: 'idle',
  status_bucket: 'review_ready',
  tags: [],
};

// ── classification ──────────────────────────────────────────────────────────

test('classifyKind reads environment_kind, not type', () => {
  assert.strictEqual(classifyKind(NATIVE_INJECT), 'local-remote-control');
  assert.strictEqual(classifyKind(CLOUD), 'cloud');
  // `type` is 'internal_session' on BOTH — proof it cannot be the discriminator.
  assert.strictEqual(NATIVE_INJECT.type, CLOUD.type);
});

test('classifyKind falls back to environment_id when environment_kind is unknown', () => {
  assert.strictEqual(classifyKind({ environment_id: 'env_x' }), 'cloud');
  assert.strictEqual(classifyKind({ environment_id: '' }), 'local-remote-control');
  assert.strictEqual(classifyKind({}), 'unknown');
});

test('classifyVia separates a native inject from an lm-assist bridge', () => {
  assert.strictEqual(classifyVia(NATIVE_INJECT), 'native-inject');
  assert.strictEqual(classifyVia(LM_ASSIST_BRIDGE), 'lm-assist-bridge');
  assert.strictEqual(classifyVia(CLOUD), null);
});

// ── liveness: the two-axis rule ─────────────────────────────────────────────

test('isLive: archived is never live even when connection_status is connected', () => {
  // This is the whole point — 67 rows in one measured page looked like this.
  assert.strictEqual(ARCHIVED_BUT_CONNECTED.connection_status, 'connected');
  assert.strictEqual(isLive(ARCHIVED_BUT_CONNECTED), false);
});

test('isLive: connected, running, or pending all count as live', () => {
  assert.strictEqual(isLive(NATIVE_INJECT), true);
  assert.strictEqual(isLive({ connection_status: 'connected', session_status: 'idle' }), true);
  assert.strictEqual(isLive({ connection_status: 'disconnected', session_status: 'running' }), true);
  assert.strictEqual(isLive({ connection_status: 'disconnected', session_status: 'pending' }), true);
  assert.strictEqual(isLive({ connection_status: 'disconnected', session_status: 'idle' }), false);
});

// ── projection ──────────────────────────────────────────────────────────────

test('projectRow surfaces repo/branch because cwd is empty upstream', () => {
  const p = projectRow(NATIVE_INJECT);
  assert.strictEqual(p.cwd, null, 'empty-string cwd must normalise to null, not ""');
  assert.strictEqual(p.repo, 'langmartai/lm-assist');
  assert.strictEqual(p.branch, 'main');
  assert.strictEqual(p.webUrl, 'https://claude.ai/code/session_01BE75qk8VwRHjRXwAMrTvuL');
  assert.strictEqual(p.model, 'claude-opus-5');
  assert.strictEqual(p.kind, 'local-remote-control');
  assert.strictEqual(p.via, 'native-inject');
  assert.strictEqual(p.live, true);
});

test('projectRow falls back to sources[].url when no branch has been reported', () => {
  const p = projectRow({
    id: 'session_x',
    session_context: { sources: [{ url: 'https://github.com/langmartai/lm-assist', revision: 'main' }] },
  });
  assert.strictEqual(p.repo, 'langmartai/lm-assist');
  assert.strictEqual(p.branch, 'main');
});

test('projectRow drops the heavy fields that blow the output budget', () => {
  const p = projectRow(NATIVE_INJECT) as unknown as Record<string, unknown>;
  // 545 KB per 100 rows lives in these; none may survive projection.
  assert.ok(!('session_context' in p));
  assert.ok(!('external_metadata' in p));
  assert.ok(!('mcp_config' in p));
});

// ── selection + the honesty rules ───────────────────────────────────────────

const ALL = [NATIVE_INJECT, LM_ASSIST_BRIDGE, ARCHIVED_BUT_CONNECTED, CLOUD];

test('default filter returns only live sessions', () => {
  const r = selectSessions(ALL, {}, { scannedPages: 1, upstreamHasMore: false });
  const ids = r.sessions.map((s) => s.id);
  assert.ok(ids.includes(NATIVE_INJECT.id!), 'the live native inject must be listed');
  assert.ok(!ids.includes(ARCHIVED_BUT_CONNECTED.id!), 'archived-but-connected must be excluded');
  assert.strictEqual(r.filter.live, true);
});

test('include_archived widens to everything', () => {
  const r = selectSessions(ALL, { includeArchived: true }, { scannedPages: 1, upstreamHasMore: false });
  assert.strictEqual(r.returned, 4);
});

test('kind filter selects one class', () => {
  const r = selectSessions(ALL, { includeArchived: true, kind: 'cloud' }, { scannedPages: 1, upstreamHasMore: false });
  assert.strictEqual(r.returned, 1);
  assert.strictEqual(r.sessions[0].kind, 'cloud');
});

test('a truncated result SAYS it is truncated — never a bare array', () => {
  const r = selectSessions(ALL, { includeArchived: true, limit: 2 }, { scannedPages: 1, upstreamHasMore: false });
  assert.strictEqual(r.returned, 2);
  assert.strictEqual(r.matched, 4, 'matched must report the pre-limit count');
  assert.strictEqual(r.truncated, true);
  assert.ok(r.note && /only 2 are shown/.test(r.note), `note must state the shortfall, got: ${r.note}`);
});

test('an untruncated result carries no note', () => {
  const r = selectSessions(ALL, { includeArchived: true }, { scannedPages: 1, upstreamHasMore: false });
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.note, undefined);
});

test('unscanned upstream pages are disclosed', () => {
  const r = selectSessions(ALL, { includeArchived: true }, { scannedPages: 1, upstreamHasMore: true });
  assert.strictEqual(r.upstreamHasMore, true);
  assert.ok(r.note && /more pages/.test(r.note), `note must disclose unscanned pages, got: ${r.note}`);
});

test('limit is clamped to the hard ceiling and floor', () => {
  // 40, not 100: a projected row measures ~495 B and the budget is 25,000, so a
  // ceiling of 100 measured 49,982 B — an overrun the bound is supposed to stop.
  const big = selectSessions(ALL, { limit: 99999 }, { scannedPages: 1, upstreamHasMore: false });
  assert.strictEqual(big.filter.limit, 40);
  const small = selectSessions(ALL, { limit: 0 }, { scannedPages: 1, upstreamHasMore: false });
  assert.strictEqual(small.filter.limit, 1);
});

test('the ceiling keeps a full-limit result inside the MCP output budget', () => {
  // Regression guard for the real failure mode: a bound that only LOOKS bounded.
  // Row shape is what costs bytes, so synthesise a full page of realistic rows.
  const many: RawSession[] = Array.from({ length: 200 }, (_, i) => ({
    ...LM_ASSIST_BRIDGE,
    id: `session_${'0'.repeat(4)}${i}AbCdEfGhIjKlMnOpQrSt`,
    title: 'Mission: a representative long session title that a real row carries · abcdef12',
  }));
  const r = selectSessions(many, { includeArchived: true, limit: 9999 }, { scannedPages: 1, upstreamHasMore: true });
  const bytes = Buffer.byteLength(JSON.stringify(r));
  assert.strictEqual(r.returned, 40, 'ceiling must cap the slice');
  assert.ok(bytes < 25_000, `full-limit result must stay under the 25,000 B budget, measured ${bytes}`);
});

test('counts describe the SCANNED set, not the returned slice', () => {
  const r = selectSessions(ALL, { limit: 1 }, { scannedPages: 1, upstreamHasMore: false });
  assert.strictEqual(r.returned, 1);
  assert.strictEqual(r.counts.localRemoteControl, 3);
  assert.strictEqual(r.counts.cloud, 1);
  assert.strictEqual(r.scanned, 4);
});

// ── paging ──────────────────────────────────────────────────────────────────

test('listLiveSessions stops after one page by default', async () => {
  let calls = 0;
  const r = await listLiveSessions({ includeArchived: true }, async () => {
    calls++;
    return { rows: ALL, hasMore: true, lastId: 'session_last' };
  });
  assert.strictEqual(calls, 1, 'default pages=1 must not crawl');
  assert.strictEqual(r.upstreamHasMore, true);
  assert.ok(r.note && /more pages/.test(r.note));
});

test('listLiveSessions follows last_id across the pages it was allowed', async () => {
  const seen: Array<string | null> = [];
  await listLiveSessions({ includeArchived: true, pages: 3 }, async (after) => {
    seen.push(after);
    return { rows: [NATIVE_INJECT], hasMore: true, lastId: `after-${seen.length}` };
  });
  assert.deepStrictEqual(seen, [null, 'after-1', 'after-2']);
});

test('listLiveSessions stops early when upstream runs out', async () => {
  let calls = 0;
  const r = await listLiveSessions({ includeArchived: true, pages: 5 }, async () => {
    calls++;
    return { rows: [NATIVE_INJECT], hasMore: false, lastId: null };
  });
  assert.strictEqual(calls, 1);
  assert.strictEqual(r.upstreamHasMore, false);
  assert.strictEqual(r.note, undefined);
});

test('pages is clamped to the ceiling', async () => {
  let calls = 0;
  await listLiveSessions({ includeArchived: true, pages: 999 }, async () => {
    calls++;
    return { rows: [NATIVE_INJECT], hasMore: true, lastId: `x${calls}` };
  });
  assert.strictEqual(calls, 5, 'must not exceed MAX_PAGES');
});
