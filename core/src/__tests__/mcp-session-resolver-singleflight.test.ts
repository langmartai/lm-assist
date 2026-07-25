/** Caller-identity resolution must be SINGLE-FLIGHT under concurrency.
 *
 *  Measured on prod 117 (2026-07-25), backlog_create through the connector transport:
 *    without the `_actor` hint (plain API, no identity resolution): server_ms p50 = 8ms
 *    with it (the real MCP path), only 4 concurrent:                server_ms p50 = 8804ms, max 14867ms
 *
 *  The cache is written only AFTER the network call returns, so N concurrent callers all
 *  miss it, all hit claude.ai at once, and all queue on a single-threaded Core — the
 *  2.5s per-call timeout cannot even fire on time once the loop is saturated. Latency
 *  like that is what walks a write into the relay's fixed 25s local / 30s gateway
 *  cutoffs, and a write that commits and then blows the cutoff IS the lost ack.
 *
 *  The resolver's own header says it is "resolved only for bootstrap/session_status";
 *  the backlog/mission write paths later put it on every write, which is how a rare
 *  read-path cost became a hot write-path cost. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRecencyCandidates, __resetRecencyCacheForTest, type RecencyDeps,
} from '../mcp-server/mcp-session-resolver';

function slowDeps(delayMs: number, counter: { n: number }): RecencyDeps {
  return {
    conversations: async () => {
      counter.n++;
      await new Promise((r) => setTimeout(r, delayMs));
      return [{ uuid: 'conv-1', name: 'A chat', updated_at: '2026-07-25T00:00:00Z' }];
    },
    sessions: () => [],
  };
}

test('concurrent callers share ONE resolution instead of each firing its own', async () => {
  __resetRecencyCacheForTest();
  const c = { n: 0 };
  const deps = slowDeps(60, c);
  const results = await Promise.all(Array.from({ length: 8 }, () => resolveRecencyCandidates(deps)));
  assert.equal(c.n, 1, `expected 1 underlying resolution, got ${c.n} — the thundering herd is back`);
  for (const r of results) assert.equal(r.claudeAi?.id, 'conv-1');
  // and they really are the same resolution, not 8 lucky-identical ones
  for (const r of results) assert.equal(r.resolvedAt, results[0].resolvedAt);
});

test('a later caller is served from cache without re-resolving', async () => {
  __resetRecencyCacheForTest();
  const c = { n: 0 };
  const deps = slowDeps(5, c);
  await resolveRecencyCandidates(deps);
  await resolveRecencyCandidates(deps);
  await resolveRecencyCandidates(deps);
  assert.equal(c.n, 1, 'the 8s TTL still applies after the in-flight join');
});

test('a failing resolution does not wedge the single-flight slot', async () => {
  __resetRecencyCacheForTest();
  let calls = 0;
  const boom: RecencyDeps = {
    conversations: async () => { calls++; throw new Error('claude.ai down'); },
    sessions: () => [],
  };
  const first = await resolveRecencyCandidates(boom);
  assert.ok(first, 'a failed upstream still yields a (degraded) result, never a throw');
  __resetRecencyCacheForTest();
  await resolveRecencyCandidates(boom);
  assert.equal(calls, 2, 'the slot was released, so a later caller can retry');
});

test('the session candidate still resolves (most recently modified wins)', async () => {
  __resetRecencyCacheForTest();
  const deps: RecencyDeps = {
    conversations: async () => [],
    sessions: () => [
      { sessionId: 'old-sess', cacheData: { fileMtime: 100 } },
      { sessionId: 'new-sess', cacheData: { fileMtime: 900 } },
    ],
  };
  const r = await resolveRecencyCandidates(deps);
  assert.equal(r.claudeCode?.id, 'new-sess');
});
