import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  bridgeClaudeVoice,
  isClaudeVoiceUpgrade,
  isClaudeVoicePageBridgeUpgrade,
  type BridgeSocket,
} from '../voice/claude-voice-relay';
import type { ChromeMgr } from '../voice/claude-chrome';
import type { IncomingMessage } from 'node:http';

/**
 * Fake WS: EventEmitter for message/close/error, records every send with its
 * binary flag so the test can distinguish relayed audio (Buffer, binary) from
 * control JSON (string). Mirrors the fake style in voice-relay.test.ts.
 */
class FakeWs extends EventEmitter {
  readyState = 1; // OPEN
  sent: Array<{ data: string | Buffer; binary: boolean }> = [];
  send(data: string | Buffer, opts?: { binary?: boolean }): void {
    this.sent.push({ data, binary: !!opts?.binary });
  }
  close(): void {
    this.readyState = 3;
  }
}

/** Fake ChromeMgr — never touches a real browser; both ops resolve. */
const fakeChromeMgr: ChromeMgr = {
  ensureLoaded: async () => {},
  openVoicePage: async () => ({ evaluate: async () => undefined, close: async () => {}, on: () => {} }),
  teardownIfIdle: async () => {},
};

test('isClaudeVoiceUpgrade / isClaudeVoicePageBridgeUpgrade match only their own paths', () => {
  assert.equal(isClaudeVoiceUpgrade({ url: '/voice/claude/ws?token=x' } as IncomingMessage), true);
  assert.equal(isClaudeVoiceUpgrade({ url: '/voice/claude/ws' } as IncomingMessage), true);
  assert.equal(isClaudeVoiceUpgrade({ url: '/voice/claude/page-bridge' } as IncomingMessage), false);
  assert.equal(isClaudeVoiceUpgrade({ url: undefined } as IncomingMessage), false);

  assert.equal(isClaudeVoicePageBridgeUpgrade({ url: '/voice/claude/page-bridge?token=y' } as IncomingMessage), true);
  assert.equal(isClaudeVoicePageBridgeUpgrade({ url: '/voice/claude/ws' } as IncomingMessage), false);
  assert.equal(isClaudeVoicePageBridgeUpgrade({ url: '/voice/stt/ws' } as IncomingMessage), false);
});

test('bridgeClaudeVoice: relays binary both ways verbatim + maps __page_status control', async () => {
  const user = new FakeWs();
  const page = new FakeWs();

  const paired = bridgeClaudeVoice(user as unknown as BridgeSocket, {
    makeChromeMgr: () => fakeChromeMgr,
    loadCookie: async () => 'sessionKey=sk-ant-sid-x; lastActiveOrg=ORG',
    // The test supplies the page-bridge socket out of band (no real Chrome / token pairing).
    waitForPageBridge: async () => page as unknown as BridgeSocket,
    httpsPort: 3849,
    mintToken: () => 'tok',
  });

  // Drive the connect handshake, then wait for pairing to complete.
  user.emit('message', Buffer.from(JSON.stringify({ type: 'connect', conversationUuid: 'C', model: 'claude-opus-4-8' })), false);
  await paired;

  // (a) a user binary frame reaches the page bridge, verbatim + flagged binary.
  user.emit('message', Buffer.from([1, 2, 3]), true);
  const up = page.sent.find((s) => Buffer.isBuffer(s.data));
  assert.ok(up, 'page bridge received the user binary frame');
  assert.deepEqual([...(up!.data as Buffer)], [1, 2, 3], 'user audio forwarded verbatim');
  assert.equal(up!.binary, true, 'forwarded as a binary frame');

  // (b) a page-bridge binary frame reaches the user, verbatim.
  page.emit('message', Buffer.from([7, 8, 9]), true);
  const down = user.sent.find((s) => Buffer.isBuffer(s.data));
  assert.ok(down, 'user received the page-bridge binary frame');
  assert.deepEqual([...(down!.data as Buffer)], [7, 8, 9], 'claude.ai audio forwarded verbatim');

  // (c) __page_status up_open → user gets {type:'ready'}
  page.emit('message', Buffer.from(JSON.stringify({ type: '__page_status', state: 'up_open' })), false);
  assert.ok(
    user.sent.some((s) => typeof s.data === 'string' && JSON.parse(s.data).type === 'ready'),
    'up_open mapped to {type:ready}',
  );

  // (d) __page_status up_close with timeout:true → user gets {type:'reconnect'}
  page.emit('message', Buffer.from(JSON.stringify({ type: '__page_status', state: 'up_close', timeout: true })), false);
  assert.ok(
    user.sent.some((s) => typeof s.data === 'string' && JSON.parse(s.data).type === 'reconnect'),
    'up_close+timeout mapped to {type:reconnect}',
  );

  // extra: up_close (no timeout) and up_error both map to {type:'error'}
  page.emit('message', Buffer.from(JSON.stringify({ type: '__page_status', state: 'up_close' })), false);
  page.emit('message', Buffer.from(JSON.stringify({ type: '__page_status', state: 'up_error' })), false);
  const errs = user.sent.filter((s) => typeof s.data === 'string' && JSON.parse(s.data).type === 'error');
  assert.ok(errs.length >= 2, 'non-timeout close and up_error both map to {type:error}');
});

test('bridgeClaudeVoice: a claude.ai message_sse text frame is forwarded verbatim to the user', async () => {
  const user = new FakeWs();
  const page = new FakeWs();
  const paired = bridgeClaudeVoice(user as unknown as BridgeSocket, {
    makeChromeMgr: () => fakeChromeMgr,
    loadCookie: async () => 'sessionKey=sk-ant-sid-x; lastActiveOrg=ORG',
    waitForPageBridge: async () => page as unknown as BridgeSocket,
    httpsPort: 3849,
    mintToken: () => 'tok',
  });
  user.emit('message', Buffer.from(JSON.stringify({ type: 'connect', conversationUuid: 'C' })), false);
  await paired;

  const sse = JSON.stringify({ type: 'message_start', foo: 1 });
  page.emit('message', Buffer.from(sse), false);
  assert.ok(user.sent.some((s) => s.data === sse), 'non-__page_status page text forwarded verbatim');
});
