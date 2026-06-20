import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_STATUS_HANDLERS,
  SESSION_STATUS_TOOL_DEFS,
  enrichBootstrapWithIdentity,
  matchSessionByToolUseId,
  describeCandidates,
  identityHeader,
} from '../mcp-server/mcp-session-resolver';
import { runWithMcpContext } from '../mcp-server/principal-context';

/**
 * Session self-awareness: the connector passes no conversation id or caller-type, so lm-assist
 * resolves the most-recently-active claude.ai conversation AND Claude Code session as CANDIDATES
 * and the LLM picks the one matching its runtime. These guard the shape + graceful degradation
 * (claude.ai isn't configured in the test env → that candidate is reported unavailable, no crash).
 */

test('session_status returns both candidate framings + the "pick your runtime" note, never crashes', async () => {
  const r = await SESSION_STATUS_HANDLERS.session_status({});
  const t = r.content[0].text as string;
  assert.match(t, /claudeAiConversation/);
  assert.match(t, /claudeCodeSession/);
  assert.match(t, /pick|matching your runtime/i);
  assert.match(t, /bootstrap/i);
});

test('enrichBootstrapWithIdentity prepends the identity block + keeps the original bootstrap text', async () => {
  const original = { content: [{ type: 'text', text: 'BOOTSTRAP_BODY_MARKER' }] };
  const out = await enrichBootstrapWithIdentity(original as any);
  const t = out.content[0].text as string;
  assert.match(t, /your session identity/i);
  assert.match(t, /BOOTSTRAP_BODY_MARKER/); // original content preserved
  assert.match(t, /recorded as BOOTSTRAPPED/i);
});

test('session_status tool is advertised read-only with no required args', () => {
  const def = SESSION_STATUS_TOOL_DEFS.find((d) => d.name === 'session_status');
  assert.ok(def);
  assert.equal((def as any).annotations.readOnlyHint, true);
  assert.deepEqual((def as any).inputSchema.required, []);
});

// ── precise tool-call-id identification ────────────────────────────────────
// Verified LIVE: the connector DOES carry a unique id per call —
// `_meta["claudecode/toolUseId"]` is the calling conversation's tool_use block id
// (a `toolu_…`). The worker echoed `toolu_013FqFduTAdYYUhMwmVvaGFG` and that exact id
// was the `tool_use` id in the caller's JSONL. So we can pin the EXACT session instead
// of guessing by recency. matchSessionByToolUseId is the pure core of that match.

test('matchSessionByToolUseId returns the session whose toolUses contains the exact toolu id', () => {
  const sessions = [
    { sessionId: 'sess-A', filePath: '/p/a.jsonl', cacheData: { cwd: '/home/a', fileMtime: 100, toolUses: [{ id: 'toolu_X' }, { id: 'toolu_Y' }] } },
    { sessionId: 'sess-B', filePath: '/p/b.jsonl', cacheData: { cwd: '/home/b', fileMtime: 200, toolUses: [{ id: 'toolu_Z' }] } },
  ];
  const m = matchSessionByToolUseId(sessions as any, 'toolu_Z');
  assert.ok(m, 'should find the session carrying the toolu id');
  assert.equal(m!.id, 'sess-B');
  assert.equal(m!.label, '/home/b');
});

test('matchSessionByToolUseId returns null when no session carries the toolu id', () => {
  assert.equal(matchSessionByToolUseId([], 'toolu_missing'), null);
  const sessions = [{ sessionId: 'sess-A', filePath: '/p/a.jsonl', cacheData: { toolUses: [{ id: 'toolu_X' }] } }];
  assert.equal(matchSessionByToolUseId(sessions as any, 'toolu_none'), null);
});

test('describeCandidates is DEFINITIVE when precise, two-candidate "pick your runtime" otherwise', () => {
  const precise = describeCandidates({ claudeCode: { id: 'sess-B', label: '/home/b' }, precise: true, resolvedAt: 0 });
  assert.match(precise, /sess-B/);
  assert.match(precise, /CONFIRMED|matched|tool-call id/i);
  assert.doesNotMatch(precise, /If you are a claude\.ai/i); // no hedging once confirmed

  const heur = describeCandidates({ claudeAi: { id: 'uuid-1', label: 'Chat' }, claudeCode: { id: 'sess-A' }, resolvedAt: 0 });
  assert.match(heur, /claude\.ai/i);
  assert.match(heur, /Claude Code/i);
});

test('identityHeader: precise pins the caller exactly; heuristic asks the LLM to pick', () => {
  const precise = identityHeader({ claudeCode: { id: 'sess-B', label: '/home/b' }, precise: true, resolvedAt: 0 });
  assert.match(precise, /pins the caller exactly|CONFIRMED/i);
  assert.match(precise, /sess-B/);
  assert.match(precise, /BOOTSTRAPPED/);
  assert.doesNotMatch(precise, /pick the one matching/i);

  const heur = identityHeader({ claudeAi: { id: 'u1', label: 'Chat' }, claudeCode: { id: 'sA' }, resolvedAt: 0 });
  assert.match(heur, /pick the one matching|most-recently-active/i);
  assert.match(heur, /BOOTSTRAPPED/);
});

test('the request context can carry the caller tool-call id (drives the precise match)', async () => {
  // The resolver reads the toolUseId from the per-request MCP context; here we only assert
  // that running inside the context with a toolUseId never throws and still returns a result
  // (in the test env no cached session carries it → graceful fall back to recency).
  await runWithMcpContext({ principal: 'local', toolUseId: 'toolu_does_not_exist' } as any, async () => {
    const r = await SESSION_STATUS_HANDLERS.session_status({});
    assert.match(r.content[0].text as string, /claudeCodeSession/);
  });
});
