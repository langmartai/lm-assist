import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  bridgeClaudeVoice,
  isClaudeVoiceUpgrade,
  isClaudeVoicePageBridgeUpgrade,
  defaultWaitForPageBridge,
  _pendingBridgeCountForTest,
  type BridgeSocket,
} from '../voice/claude-voice-relay';
import type { ChromeMgr } from '../voice/claude-chrome';
import type { IncomingMessage } from 'node:http';

/**
 * Fake WS: EventEmitter for message/close/error, records every send with its binary flag so
 * the test can distinguish relayed audio (Buffer, binary) from control JSON (string). Tracks
 * whether a `message` listener was ever attached (`messageWired`) so a test can prove the page
 * bridge was NOT wired to a dead user socket. Mirrors the fake style in voice-relay.test.ts.
 */
class FakeWs extends EventEmitter {
  readyState = 1; // OPEN
  sent: Array<{ data: string | Buffer; binary: boolean }> = [];
  messageWired = false;
  send(data: string | Buffer, opts?: { binary?: boolean }): void {
    this.sent.push({ data, binary: !!opts?.binary });
  }
  close(): void {
    this.readyState = 3;
  }
  on(event: string, listener: (...args: any[]) => void): this {
    if (event === 'message') this.messageWired = true;
    return super.on(event, listener);
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));
const connectFrame = (conversationUuid = 'C') =>
  Buffer.from(JSON.stringify({ type: 'connect', conversationUuid }));

/** ChromeMgr whose openVoicePage RESOLVES with a page; `onClose` fires when that page closes. */
function mgrWithPage(onClose: () => void): ChromeMgr {
  return {
    ensureLoaded: async () => {},
    openVoicePage: async () => ({ evaluate: async () => undefined, close: async () => { onClose(); }, on: () => {} }),
    teardownIfIdle: async () => {},
  };
}
/** ChromeMgr whose openVoicePage REJECTS — models a Chrome-less node (launch_failed). */
function mgrThatFailsOpen(msg: string): ChromeMgr {
  return {
    ensureLoaded: async () => {},
    openVoicePage: async () => { throw new Error(msg); },
    teardownIfIdle: async () => {},
  };
}
/** ChromeMgr for the happy-path relay tests (page never asserted on). */
const fakeChromeMgr: ChromeMgr = mgrWithPage(() => {});

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

// ── teardown / failure state machine (C1 crash, I1 tab leak, I2 half-open bridge) ────────────

test('C1: openVoicePage failure cancels the REAL pending-bridge registry entry (no 30s leak)', async () => {
  const before = _pendingBridgeCountForTest();
  const user = new FakeWs();
  const paired = bridgeClaudeVoice(user as unknown as BridgeSocket, {
    makeChromeMgr: () => mgrThatFailsOpen('launch_failed: no system Chrome'),
    loadCookie: async () => 'sessionKey=x; lastActiveOrg=O',
    // REAL registry-backed waiter — proves cancelPendingBridge clears the entry + its 30s timer.
    waitForPageBridge: defaultWaitForPageBridge,
    httpsPort: 3849,
    mintToken: () => 'tokC1a',
  });
  user.emit('message', connectFrame(), false);
  await paired;

  assert.equal(_pendingBridgeCountForTest(), before, 'pending-bridge entry cleaned up (old code left it ~30s)');
  assert.ok(user.sent.some((s) => typeof s.data === 'string' && JSON.parse(s.data).type === 'error'), 'user told relay failed');
  assert.equal(user.readyState, 3, 'user socket closed on setup failure');
});

test('C1: a rejecting page-bridge promise on the setup-failure path never becomes an unhandled rejection', async () => {
  const user = new FakeWs();
  const rejections: unknown[] = [];
  const onUnhandled = (err: unknown) => rejections.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const paired = bridgeClaudeVoice(user as unknown as BridgeSocket, {
      makeChromeMgr: () => mgrThatFailsOpen('launch_failed'),
      loadCookie: async () => 'sessionKey=x; lastActiveOrg=O',
      // Mirrors the default 30s reject timer, compressed to 5ms. bridgeClaudeVoice returns on
      // the openVoicePage throw WITHOUT awaiting this — only the early .catch keeps its later
      // rejection from crashing Core (there is no unhandledRejection handler in the repo).
      waitForPageBridge: () => new Promise<BridgeSocket>((_res, rej) => setTimeout(() => rej(new Error('bridge-timeout')), 5)),
      httpsPort: 3849,
      mintToken: () => 'tokC1b',
    });
    user.emit('message', connectFrame(), false);
    await paired;
    await new Promise((r) => setTimeout(r, 25)); // let the 5ms reject fire + be swallowed
    assert.equal(rejections.length, 0, 'no unhandled rejection escaped the setup-failure path');
    assert.ok(user.sent.some((s) => typeof s.data === 'string' && JSON.parse(s.data).type === 'error'), 'user told relay failed');
    assert.equal(user.readyState, 3, 'user socket closed');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('I1: the voice tab (openVoicePage page) is closed on normal teardown', async () => {
  const user = new FakeWs();
  const page = new FakeWs();
  let tabClosed = false;
  const paired = bridgeClaudeVoice(user as unknown as BridgeSocket, {
    makeChromeMgr: () => mgrWithPage(() => { tabClosed = true; }),
    loadCookie: async () => 'sessionKey=x; lastActiveOrg=O',
    waitForPageBridge: async () => page as unknown as BridgeSocket,
    httpsPort: 3849,
    mintToken: () => 'tokI1',
  });
  user.emit('message', connectFrame(), false);
  await paired;
  assert.equal(tabClosed, false, 'tab stays open while the session is live');

  // User hangs up → teardown must reclaim the tab (old closeAll only closed WS sockets).
  user.readyState = 3;
  user.emit('close');
  await tick();
  assert.equal(tabClosed, true, 'voice tab reclaimed on teardown');
});

test('I2: user leaves during setup → page bridge is NOT wired and the tab is reclaimed', async () => {
  const user = new FakeWs();
  const page = new FakeWs();
  let tabClosed = false;
  let resolveGate!: (s: BridgeSocket) => void;
  const gate = new Promise<BridgeSocket>((r) => { resolveGate = r; });

  const paired = bridgeClaudeVoice(user as unknown as BridgeSocket, {
    makeChromeMgr: () => mgrWithPage(() => { tabClosed = true; }),
    loadCookie: async () => 'sessionKey=x; lastActiveOrg=O',
    waitForPageBridge: () => gate, // held open until the test releases it
    httpsPort: 3849,
    mintToken: () => 'tokI2',
  });
  user.emit('message', connectFrame(), false);
  await tick(); // advance setup to `await gate` (page handle captured, pairing pending)

  // User hangs up BEFORE the page bridge pairs.
  user.readyState = 3;
  user.emit('close');
  // ...then the page bridge finally connects.
  resolveGate(page as unknown as BridgeSocket);
  await tick();
  await paired;

  assert.equal(page.messageWired, false, 'no relay wired onto a dead user socket (half-open bridge avoided)');
  assert.equal((page as unknown as { readyState: number }).readyState, 3, 'freshly-paired page bridge closed');
  assert.equal(tabClosed, true, 'voice tab reclaimed');
});
