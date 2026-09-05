/**
 * SessionCacheSync must actually deliver the mechanical session summary to the hub.
 *
 * This path shipped broken in the initial release (eacdfb2, 2026-02-18) and stayed
 * broken for six months on every node: `grep -c 'SessionCacheSync] Synced'` across all
 * retained logs returned 0. Two independent defects, neither of which any test covered:
 *
 *   1. `fetchSessions()` read `body.sessions`, but `GET /sessions` is wrapResponse-enveloped
 *      — the array lives at `body.data.sessions`. It therefore saw zero sessions on every
 *      tick and logged "No sessions to sync" forever.
 *   2. The payload mapper read `summary`/`messageCount`/`costUsd`/`updatedAt`/`inputTokens`,
 *      none of which the API emits. It emits `sessionSummary`/`numTurns`/`totalCostUsd`/
 *      `lastModified`/`usage.inputTokens`. 7 of 11 fields shipped undefined.
 *
 * The hub receiver (LangMartDesign assist-api tier-agent-gateway-manager.ts) upserts these
 * into `tier_agent_session_cache` by the OUTGOING names, so the outgoing contract is fixed
 * and it is the source-key mapping that has to bend. These tests pin both halves.
 */
import { test } from 'node:test';
import * as assert from 'node:assert';
import { SessionCacheSync, type WebSocketSender } from '../session-cache-sync';

/** A real /sessions row, captured verbatim from GET :3100/sessions?limit=1. */
const API_SESSION_ROW = {
  sessionId: 'a39ced8c-ec73-4569-8ef1-7b84fbb45438',
  projectPath: '/home/ubuntu',
  sessionSummary: 'Read-only analysis task — 7T | Bash',
  model: 'claude-sonnet-5',
  numTurns: 7,
  totalCostUsd: 1.2124252500000001,
  createdAt: '2026-08-14T03:18:42.125Z',
  lastModified: '2026-08-14T03:19:54.362Z',
  usage: {
    inputTokens: 14,
    outputTokens: 14665,
    cacheCreationInputTokens: 114549,
    cacheReadInputTokens: 259598,
  },
  filePath: '/home/ubuntu/.claude/projects/-home-ubuntu/a39ced8c.jsonl',
  lastUserMessage: 'do the thing',
  size: 12345,
  taskCount: 0,
  userPromptCount: 3,
  modelUsage: {},
};

/** The exact envelope `wrapResponse()` produces. */
function envelopedBody(sessions: unknown[]) {
  return {
    success: true,
    data: { sessions, total: sessions.length, returned: sessions.length, runningCount: 0 },
    meta: { durationMs: 1 },
  };
}

type Sent = { type?: string; sessions?: Array<Record<string, unknown>> };

/** Collects what the sync would put on the wire, with a socket that is genuinely connected. */
function connectedSocket(sent: Sent[]): WebSocketSender {
  return {
    isConnected: () => true,
    send: (data: unknown) => { sent.push(data as Sent); },
  };
}

/** Swaps global fetch for one that serves `body`, and restores it afterwards. */
async function withStubbedFetch(body: unknown, fn: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('sync delivers sessions from a wrapResponse-enveloped /sessions body', async () => {
  const sent: Sent[] = [];
  const sync = new SessionCacheSync({ localApiPort: 3200 });
  sync.setWebSocket(connectedSocket(sent));

  await withStubbedFetch(envelopedBody([API_SESSION_ROW]), () => sync.sync());

  assert.strictEqual(sent.length, 1, 'expected exactly one session_cache_sync message on the wire');
  assert.strictEqual(sent[0].type, 'session_cache_sync');
  assert.strictEqual(sent[0].sessions?.length, 1, 'the enveloped session must survive the unwrap');
  assert.strictEqual(sent[0].sessions?.[0].sessionId, API_SESSION_ROW.sessionId);
});

test('sync maps the API field names onto the hub payload contract', async () => {
  const sent: Sent[] = [];
  const sync = new SessionCacheSync({ localApiPort: 3200 });
  sync.setWebSocket(connectedSocket(sent));

  await withStubbedFetch(envelopedBody([API_SESSION_ROW]), () => sync.sync());

  const payload = sent[0]?.sessions?.[0];
  assert.ok(payload, 'no session payload was sent');

  // The hub upserts by these names; each one is a column in tier_agent_session_cache.
  assert.strictEqual(payload.summary, API_SESSION_ROW.sessionSummary, 'summary <- sessionSummary');
  assert.strictEqual(payload.messageCount, API_SESSION_ROW.numTurns, 'messageCount <- numTurns');
  assert.strictEqual(payload.costUsd, API_SESSION_ROW.totalCostUsd, 'costUsd <- totalCostUsd');
  assert.strictEqual(payload.updatedAt, API_SESSION_ROW.lastModified, 'updatedAt <- lastModified');
  assert.strictEqual(payload.lastActivityAt, API_SESSION_ROW.lastModified, 'lastActivityAt <- lastModified');
  assert.strictEqual(payload.inputTokens, API_SESSION_ROW.usage.inputTokens, 'inputTokens <- usage.inputTokens');
  assert.strictEqual(payload.outputTokens, API_SESSION_ROW.usage.outputTokens, 'outputTokens <- usage.outputTokens');

  // These already matched and must not regress.
  assert.strictEqual(payload.projectPath, API_SESSION_ROW.projectPath);
  assert.strictEqual(payload.model, API_SESSION_ROW.model);
  assert.strictEqual(payload.createdAt, API_SESSION_ROW.createdAt);
});

test('sync still accepts a bare (un-enveloped) sessions body', async () => {
  // Defensive: the unwrap must not become a hard dependency on the envelope, so a
  // future route change back to a bare body cannot re-break delivery silently.
  const sent: Sent[] = [];
  const sync = new SessionCacheSync({ localApiPort: 3200 });
  sync.setWebSocket(connectedSocket(sent));

  await withStubbedFetch({ sessions: [API_SESSION_ROW] }, () => sync.sync());

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].sessions?.length, 1);
});

test('sync sends nothing when the API returns no sessions', async () => {
  const sent: Sent[] = [];
  const sync = new SessionCacheSync({ localApiPort: 3200 });
  sync.setWebSocket(connectedSocket(sent));

  await withStubbedFetch(envelopedBody([]), () => sync.sync());

  assert.strictEqual(sent.length, 0, 'an empty session list must not put a message on the wire');
});

test('sync skips entirely when the socket is not connected', async () => {
  const sent: Sent[] = [];
  const sync = new SessionCacheSync({ localApiPort: 3200 });
  sync.setWebSocket({ isConnected: () => false, send: (d) => { sent.push(d as Sent); } });

  let fetched = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { fetched = true; throw new Error('should not be reached'); }) as unknown as typeof globalThis.fetch;
  try {
    await sync.sync();
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.strictEqual(sent.length, 0);
  assert.strictEqual(fetched, false, 'a disconnected sync must not even hit the local API');
});
