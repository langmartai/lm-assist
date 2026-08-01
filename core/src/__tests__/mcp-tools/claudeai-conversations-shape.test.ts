import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractConversationRows } from '../../mcp-server/tools/list-claudeai-conversations';

/**
 * list_claudeai_conversations returned a bare "Unexpected response shape from
 * claude.ai." on EVERY call — deterministic, not intermittent.
 *
 * Root cause: `listConversations` -> `claudeaiGet` resolves to a
 * ClaudeAIResponse envelope `{ status, statusText, headers, body }`, but the
 * tool read `resp.data`. The rows live at `resp.body.data`, so `resp.data` was
 * always `undefined` -> not an array -> the opaque refusal.
 *
 * The REST route already got this right (claude-ai.routes.ts ~L381 goes through
 * `r.body` and accepts both shapes, verified live 2026-07-21); only the MCP
 * surface drifted. These tests pin BOTH hops so the two surfaces cannot diverge
 * again: the `.body` unwrap, and the `chat_conversations_v2` `{data, has_more}`
 * envelope vs the legacy bare array.
 */

const ROWS = [
  { uuid: 'fab43e09-7d4d-4c28-9470-6d83b071c0af', name: 'Setting up local CCR session' },
  { uuid: '11111111-2222-3333-4444-555555555555', name: 'Another chat' },
];

function claudeAiResponse(body: unknown) {
  return { status: 200, statusText: 'OK', headers: {}, body };
}

test('extractConversationRows: ClaudeAIResponse wrapping a v2 {data, has_more} envelope (the bug)', () => {
  const resp = claudeAiResponse({ data: ROWS, has_more: true });
  assert.deepEqual(extractConversationRows(resp), ROWS);
});

test('extractConversationRows: ClaudeAIResponse wrapping a legacy bare array', () => {
  assert.deepEqual(extractConversationRows(claudeAiResponse(ROWS)), ROWS);
});

test('extractConversationRows: an already-unwrapped v2 envelope still works', () => {
  assert.deepEqual(extractConversationRows({ data: ROWS, has_more: false }), ROWS);
});

test('extractConversationRows: an already-unwrapped bare array still works', () => {
  assert.deepEqual(extractConversationRows(ROWS), ROWS);
});

test('extractConversationRows: an empty result is [], NOT a shape failure', () => {
  // An empty account must read as "no conversations", never as the opaque
  // "Unexpected response shape" — that conflation is what hid this bug.
  assert.deepEqual(extractConversationRows(claudeAiResponse({ data: [], has_more: false })), []);
});

test('extractConversationRows: a genuinely unrecognizable shape returns undefined', () => {
  assert.equal(extractConversationRows(claudeAiResponse({ conversations: ROWS })), undefined);
  assert.equal(extractConversationRows(null), undefined);
  assert.equal(extractConversationRows('nope'), undefined);
});
