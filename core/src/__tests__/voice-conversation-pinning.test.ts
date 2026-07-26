import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationPageUrl } from '../voice/claude-chrome';

// Regression for bl_91ebabe8: a voice page that loaded the bare origin let the claude.ai SPA
// restore the LAST-USED conversation, and claude.ai attributed the spoken turn to that page's
// active conversation — so transcripts surfaced as `human` messages in unrelated chats. The
// page must be pinned to the same conversation the voice WS targets.
const CONV = '0363e03c-45bb-4b74-8967-406d941f569f';
const WS = `wss://claude.ai/api/ws/voice/organizations/7cad1e03-e98e-42ca-8571-311a4ce74b8b/chat_conversations/${CONV}?voice=buttery&model=claude-opus-5`;

test('page URL pins to the conversation the voice WS targets', () => {
  assert.equal(conversationPageUrl(WS), `https://claude.ai/chat/${CONV}`);
});

test('two different conversations never share a page URL', () => {
  const other = WS.replace(CONV, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.notEqual(conversationPageUrl(WS), conversationPageUrl(other));
});

test('unrecoverable or hostile uuids fall back to null (caller keeps old behaviour)', () => {
  assert.equal(conversationPageUrl('wss://claude.ai/api/ws/voice/whatever'), null);
  assert.equal(conversationPageUrl(''), null);
  // never let a path segment escape the origin or traverse
  assert.equal(conversationPageUrl(WS.replace(CONV, encodeURIComponent('../../evil'))), null);
  assert.equal(conversationPageUrl(WS.replace(CONV, encodeURIComponent('a/b'))), null);
});
