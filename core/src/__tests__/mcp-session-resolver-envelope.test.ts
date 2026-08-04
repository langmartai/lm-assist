/** The resolver must read the claude.ai list through the ClaudeAIResponse ENVELOPE.
 *
 *  `listConversations()` resolves to `{status, statusText, headers, body}` — the rows are at
 *  `body.data`. Measured against prod 0.1.135 with a healthy cookie, HTTP 200:
 *
 *    top-level keys:            [ 'status', 'statusText', 'headers', 'body' ]
 *    resp.conversations:        undefined
 *    resp.data:                 undefined          <-- the two the resolver used to read
 *    Object.keys(resp.body):    [ 'data', 'has_more' ]
 *    Array.isArray(resp.body.data): true
 *
 *  So `resp?.conversations ?? resp?.data ?? []` could only ever produce `[]`, and
 *  `out.claudeAi` was NEVER populated on a real call — the resolver silently failed to
 *  identify a claude.ai caller on every request.
 *
 *  It stayed hidden because the failure is indistinguishable from success: `[]` is a
 *  legitimate "no conversations", and the branch sits inside a `try {} catch {}` whose
 *  comment reads "claude.ai not configured / deadline -> omit". A healthy, configured,
 *  200-OK cookie looked exactly like an unconfigured one.
 *
 *  And it survived BECAUSE OF the existing tests, not despite them: every other resolver
 *  test injects a BARE ARRAY (`conversations: async () => []`), a shape the real
 *  `listConversations` never returns. The tests encoded a contract the production code
 *  does not have. These tests inject the REAL envelope.
 *
 *  Third instance of one bug class — read-conversation.ts and list-claudeai-conversations.ts
 *  (2f4e31f, 7c7e631) were the first two. The unwrap now goes through the single exported
 *  `extractConversationRows` helper so there is no fourth hand-rolled copy to get wrong. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRecencyCandidates, __resetRecencyCacheForTest, type RecencyDeps,
} from '../mcp-server/mcp-session-resolver';

const ROW = { uuid: 'conv-1', name: 'A chat', updated_at: '2026-07-25T00:00:00Z' };
const NEWER = { uuid: 'conv-2', name: 'Newer chat', updated_at: '2026-07-26T00:00:00Z' };

function depsReturning(resp: unknown): RecencyDeps {
  return { conversations: async () => resp, sessions: () => [] };
}

/** Capture stderr writes (console.error) for the duration of `fn`. */
async function withCapturedStderr(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { await fn(); } finally { console.error = orig; }
  return lines;
}

test('THE REAL SHAPE: rows at body.data resolve the claude.ai caller', async () => {
  __resetRecencyCacheForTest();
  const r = await resolveRecencyCandidates(depsReturning({
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: { data: [ROW], has_more: false },
  }));
  assert.equal(r.claudeAi?.id, 'conv-1', 'the envelope hop was missed — claudeAi is unpopulated on every real call');
  assert.equal(r.claudeAi?.label, 'A chat');
  assert.equal(r.claudeAi?.updatedAt, '2026-07-25T00:00:00Z');
});

test('THE REAL SHAPE: most-recently-updated conversation still wins inside the envelope', async () => {
  __resetRecencyCacheForTest();
  const r = await resolveRecencyCandidates(depsReturning({
    status: 200, statusText: 'OK', headers: {},
    body: { data: [ROW, NEWER], has_more: false },
  }));
  assert.equal(r.claudeAi?.id, 'conv-2', 'recency ordering must survive the unwrap');
});

test('an envelope wrapping a BARE ARRAY body (legacy upstream) also resolves', async () => {
  __resetRecencyCacheForTest();
  const r = await resolveRecencyCandidates(depsReturning({
    status: 200, statusText: 'OK', headers: {}, body: [ROW],
  }));
  assert.equal(r.claudeAi?.id, 'conv-1');
});

test('a bare array with no envelope still resolves (the shape every other test injects)', async () => {
  __resetRecencyCacheForTest();
  const r = await resolveRecencyCandidates(depsReturning([ROW]));
  assert.equal(r.claudeAi?.id, 'conv-1', 'the pre-existing branch must not regress');
});

test('genuinely EMPTY is quiet — it is not a parse failure', async () => {
  __resetRecencyCacheForTest();
  let r!: Awaited<ReturnType<typeof resolveRecencyCandidates>>;
  const errs = await withCapturedStderr(async () => {
    r = await resolveRecencyCandidates(depsReturning({
      status: 200, statusText: 'OK', headers: {}, body: { data: [], has_more: false },
    }));
  });
  assert.equal(r.claudeAi, undefined, 'no conversations means no candidate');
  assert.deepEqual(errs, [], 'an account with zero conversations must not be reported as a defect');
});

test('an UNRECOGNISABLE shape is reported, never silently treated as empty', async () => {
  __resetRecencyCacheForTest();
  let r!: Awaited<ReturnType<typeof resolveRecencyCandidates>>;
  const errs = await withCapturedStderr(async () => {
    r = await resolveRecencyCandidates(depsReturning({
      status: 200, statusText: 'OK', headers: {}, body: { unexpected: 'drifted upstream' },
    }));
  });
  assert.equal(r.claudeAi, undefined, 'an unparseable payload yields no candidate');
  assert.equal(errs.length, 1, 'silence is the actual bug here — a drifted shape must announce itself');
  assert.match(errs[0], /claude\.ai/i);
  assert.match(errs[0], /shape/i);
});

test('a thrown upstream stays quiet on this channel (not configured / deadline is normal)', async () => {
  __resetRecencyCacheForTest();
  const boom: RecencyDeps = {
    conversations: async () => { throw new Error('No claude.ai session configured'); },
    sessions: () => [],
  };
  let r!: Awaited<ReturnType<typeof resolveRecencyCandidates>>;
  const errs = await withCapturedStderr(async () => { r = await resolveRecencyCandidates(boom); });
  assert.equal(r.claudeAi, undefined);
  assert.deepEqual(errs, [], 'an unconfigured node is an expected state, not a shape defect');
});
