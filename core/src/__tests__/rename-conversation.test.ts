import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
// `import * as fs` compiles to an __importStar COPY whose properties are
// getters — mock.method reads descriptor.value and sees undefined on those.
// Bind the REAL module object instead; the copies other modules hold delegate
// to it through those same getters, so stubbing here is visible to them.
import fs = require('fs');
import * as os from 'os';
import * as path from 'path';
import {
  normalizeConversationName,
  renameConversation,
  MAX_CONVERSATION_NAME_LEN,
} from '../utils/claudeai-session';
import { createClaudeAiCache } from '../claudeai-cache';

/**
 * Renaming a claude.ai conversation.
 *
 * The wire contract here is EMPIRICAL, not inferred — probed live against
 * claude.ai on 2026-07-26 against a throwaway conversation:
 *
 *   PUT   /chat_conversations/:uuid  {name}        -> 202  (the rename)
 *   PATCH /chat_conversations/:uuid  {name}        -> 405
 *   POST  /chat_conversations/:uuid  {name}        -> 405
 *   POST  /chat_conversations/:uuid/rename         -> 404
 *   POST  /chat_conversations/:uuid/title {title}  -> 400 "message_content is required."
 *
 * That last line is why these tests assert the METHOD and PATH so bluntly:
 * `/title` reads like the rename endpoint but is the auto-title GENERATOR, and
 * a well-meaning "fix" back to it would break renaming while still looking
 * plausible in review. If this test fails, re-probe before changing it.
 */

const ORG = '7cad1e03-e98e-42ca-8571-311a4ce74b8b';
const CONV = 'ad16a217-0324-471a-a34b-65a6ac7d3fef';

const realReadFileSync = fs.readFileSync;

/** Make readClaudeAISession() see a session with an org cookie, without touching the real one. */
function stubSession(): void {
  mock.method(fs, 'readFileSync', (p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (typeof p === 'string' && p.endsWith('claudeai-session.json')) {
      return JSON.stringify({ cookie: `lastActiveOrg=${ORG}; sessionKey=REDACTED` });
    }
    return (realReadFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  });
}

afterEach(() => { mock.restoreAll(); });

// ── name validation ────────────────────────────────────────────────────────

test('normalizeConversationName trims and collapses whitespace to one line', () => {
  assert.equal(normalizeConversationName('  hello   world  '), 'hello world');
  assert.equal(normalizeConversationName('multi\nline\ttitle'), 'multi line title');
});

test('normalizeConversationName rejects blank names', () => {
  // A blank title would make the chat unfindable in the sidebar.
  assert.throws(() => normalizeConversationName(''), /must not be empty/);
  assert.throws(() => normalizeConversationName('   \n\t '), /must not be empty/);
});

test('normalizeConversationName rejects non-strings', () => {
  assert.throws(() => normalizeConversationName(undefined), /must be a string/);
  assert.throws(() => normalizeConversationName(42), /must be a string/);
});

test('normalizeConversationName bounds length', () => {
  const ok = 'x'.repeat(MAX_CONVERSATION_NAME_LEN);
  assert.equal(normalizeConversationName(ok).length, MAX_CONVERSATION_NAME_LEN);
  assert.throws(() => normalizeConversationName('x'.repeat(MAX_CONVERSATION_NAME_LEN + 1)), /<= 200 chars/);
});

// ── wire contract ──────────────────────────────────────────────────────────

test('renameConversation issues PUT /chat_conversations/:uuid with {name}', async () => {
  stubSession();
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: String(init.method), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ uuid: CONV, name: 'New Title' }), { status: 202, statusText: 'Accepted' });
  });

  const r = await renameConversation(CONV, 'New Title');

  assert.equal(calls.length, 1, 'fetch was called exactly once');
  const seen = calls[0];
  assert.equal(seen.method, 'PUT', 'rename is a PUT — POST/PATCH both 405 upstream');
  assert.equal(seen.url, `https://claude.ai/api/organizations/${ORG}/chat_conversations/${CONV}`);
  assert.ok(!seen.url.endsWith('/title'), '/title is the auto-title generator, not the rename endpoint');
  // Sibling PUTs to this same resource (settings, is_starred) carry
  // ?rendering_mode=raw — the rename is the one with no query string.
  assert.ok(!seen.url.includes('?'), 'rename PUT carries no query string');
  assert.deepEqual(seen.body, { name: 'New Title' }, 'upstream field is `name`, not `title`');
  assert.equal(r.status, 202);
  assert.equal(r.body.name, 'New Title');
});

test('renameConversation normalizes the name before sending it', async () => {
  stubSession();
  const sentNames: unknown[] = [];
  mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    sentNames.push(JSON.parse(String(init.body)).name);
    return new Response('{}', { status: 202 });
  });

  await renameConversation(CONV, '  spaced   out  ');
  assert.deepEqual(sentNames, ['spaced out']);
});

test('renameConversation rejects a bad uuid before any network call', async () => {
  stubSession();
  let called = false;
  mock.method(globalThis, 'fetch', async () => { called = true; return new Response('{}', { status: 200 }); });

  await assert.rejects(() => renameConversation('not-a-uuid', 'x'), /Invalid conversation UUID/);
  assert.equal(called, false, 'must not hit the network with a malformed uuid');
});

test('renameConversation rejects a blank name before any network call', async () => {
  stubSession();
  let called = false;
  mock.method(globalThis, 'fetch', async () => { called = true; return new Response('{}', { status: 200 }); });

  await assert.rejects(() => renameConversation(CONV, '   '), /must not be empty/);
  assert.equal(called, false);
});

test('renameConversation surfaces an upstream failure instead of throwing', async () => {
  stubSession();
  mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 403, statusText: 'Forbidden' }));

  const r = await renameConversation(CONV, 'x');
  assert.equal(r.status, 403);
  assert.equal(r.body.error.message, 'nope');
});

// ── cache coherence ────────────────────────────────────────────────────────

test('cache.updateName keeps the list index from serving a stale title', async () => {
  // GET /claude-ai/conversations answers from listIndex() with NO TTL, so a
  // rename that skips this makes the OLD title stick around indefinitely.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeai-cache-test-'));
  try {
    const cache = createClaudeAiCache({ cacheDir: dir, ttlSec: 600 });
    await cache.set(CONV, { uuid: CONV, name: 'Old Title', updated_at: '2026-07-26T00:00:00Z' });

    await cache.updateName(CONV, 'Fresh Title');

    const idx = await cache.listIndex();
    assert.equal(idx.find((e) => e.uuid === CONV)?.name, 'Fresh Title');
    // the per-conversation blob must not contradict the index
    const blob = await cache.get(CONV);
    assert.equal(blob?.name, 'Fresh Title');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cache.updateName is a no-op for an uncached conversation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeai-cache-test-'));
  try {
    const cache = createClaudeAiCache({ cacheDir: dir, ttlSec: 600 });
    await cache.updateName(CONV, 'Whatever');   // must not throw or invent an entry
    assert.deepEqual(await cache.listIndex(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
