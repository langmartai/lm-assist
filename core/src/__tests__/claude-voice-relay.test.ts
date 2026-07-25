import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  bridgeClaudeVoice,
  isClaudeVoiceUpgrade,
  type BridgeSocket,
} from '../voice/claude-voice-relay';
import type { ChromeMgr, VoiceChannel, VoiceChannelHandlers } from '../voice/claude-chrome';
import type { IncomingMessage } from 'node:http';

/**
 * Fake WS (the USER socket): EventEmitter for message/close/error, records every send with its
 * binary flag so a test can distinguish relayed audio (Buffer, binary) from control JSON
 * (string). Mirrors the fake style in voice-relay.test.ts.
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

/** Fake voice channel (the Chrome-side handle openVoicePage returns): records each send with
 *  its binary flag + counts close() calls, so a test can assert uplink framing + tab reclaim. */
class FakeChannel {
  sent: Array<{ data: Buffer; binary: boolean }> = [];
  closed = 0;
  send(data: Buffer, binary: boolean): void {
    this.sent.push({ data, binary });
  }
  close(): Promise<void> {
    this.closed++;
    return Promise.resolve();
  }
}

interface Captured { handlers?: VoiceChannelHandlers; voiceUrl?: string }

/** ChromeMgr whose openVoicePage captures the wiring handlers + returns `channel`. An optional
 *  `gate` lets a test hold openVoicePage open to model "user hangs up mid-setup". */
function makeMgr(channel: FakeChannel, captured: Captured, opts: { gate?: Promise<void> } = {}): ChromeMgr {
  return {
    ensureLoaded: async () => {},
    openVoicePage: async (voiceUrl, handlers): Promise<VoiceChannel> => {
      captured.voiceUrl = voiceUrl;
      captured.handlers = handlers;
      if (opts.gate) await opts.gate;
      return channel;
    },
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

const tick = () => new Promise<void>((r) => setImmediate(r));
const connectFrame = (conversationUuid = 'C') =>
  Buffer.from(JSON.stringify({ type: 'connect', conversationUuid }));

test('isClaudeVoiceUpgrade matches only /voice/claude/ws', () => {
  assert.equal(isClaudeVoiceUpgrade({ url: '/voice/claude/ws?token=x' } as IncomingMessage), true);
  assert.equal(isClaudeVoiceUpgrade({ url: '/voice/claude/ws' } as IncomingMessage), true);
  assert.equal(isClaudeVoiceUpgrade({ url: '/voice/claude/page-bridge' } as IncomingMessage), false);
  assert.equal(isClaudeVoiceUpgrade({ url: '/voice/stt/ws' } as IncomingMessage), false);
  assert.equal(isClaudeVoiceUpgrade({ url: undefined } as IncomingMessage), false);
});

test('the connect frame\'s voice reaches the claude.ai WS URL (and an unknown one degrades)', async () => {
  // The whole point of the feature: WHO speaks back is chosen in the browser, travels in the
  // connect handshake, and must survive into the WS query — it is fixed at connect, so if it
  // is dropped here the user silently gets the default voice for the entire call.
  async function urlFor(connect: Record<string, unknown>): Promise<string> {
    const captured: Captured = {};
    const user = new FakeWs();
    const paired = bridgeClaudeVoice(user as unknown as BridgeSocket, {
      makeChromeMgr: () => makeMgr(new FakeChannel(), captured),
      loadCookie: async () => 'sessionKey=sk-ant-sid-x; lastActiveOrg=ORG',
    });
    user.emit('message', Buffer.from(JSON.stringify({ type: 'connect', conversationUuid: 'C', ...connect })), false);
    await paired;
    return captured.voiceUrl!;
  }

  assert.match(await urlFor({ voice: 'glassy' }), /[?&]voice=glassy(&|$)/);
  assert.match(await urlFor({ voice: 'rounded', model: 'claude-opus-4-8' }), /[?&]voice=rounded(&|$)/);
  // Omitted -> claude.ai's default, i.e. today's shipped behaviour is unchanged.
  assert.match(await urlFor({}), /[?&]voice=buttery(&|$)/);
  // Unknown -> default rather than a rejected upgrade.
  assert.match(await urlFor({ voice: 'nonsense' }), /[?&]voice=buttery(&|$)/);
});

test('bridgeClaudeVoice: user binary → channel.send(data,true); onFrame both ways; status mapping', async () => {
  const user = new FakeWs();
  const channel = new FakeChannel();
  const captured: Captured = {};
  const paired = bridgeClaudeVoice(user as unknown as BridgeSocket, {
    makeChromeMgr: () => makeMgr(channel, captured),
    loadCookie: async () => 'sessionKey=sk-ant-sid-x; lastActiveOrg=ORG',
  });

  // Drive the connect handshake, then wait for the channel to open.
  user.emit('message', Buffer.from(JSON.stringify({ type: 'connect', conversationUuid: 'C', model: 'claude-opus-4-8' })), false);
  await paired;
  assert.ok(captured.handlers, 'openVoicePage received the wiring handlers');

  // (a) a user binary frame reaches the channel, verbatim + flagged binary.
  user.emit('message', Buffer.from([1, 2, 3]), true);
  const up = channel.sent.find((s) => s.binary);
  assert.ok(up, 'channel received the user binary frame');
  assert.deepEqual([...up!.data], [1, 2, 3], 'user audio forwarded verbatim');
  assert.equal(up!.binary, true, 'forwarded as a binary frame');

  // (b) a claude.ai binary frame (onFrame binary) reaches the user, verbatim.
  captured.handlers!.onFrame(Buffer.from([7, 8, 9]), true);
  const down = user.sent.find((s) => Buffer.isBuffer(s.data));
  assert.ok(down, 'user received the claude.ai binary frame');
  assert.deepEqual([...(down!.data as Buffer)], [7, 8, 9], 'claude.ai audio forwarded verbatim');
  assert.equal(down!.binary, true);

  // (c) a claude.ai message_sse text frame (onFrame text) is forwarded to the user as a string.
  const sse = JSON.stringify({ type: 'message_start', foo: 1 });
  captured.handlers!.onFrame(Buffer.from(sse, 'utf8'), false);
  assert.ok(user.sent.some((s) => s.data === sse), 'text frame forwarded verbatim as a string');

  // (d) onStatus('up_open') → user gets {type:'ready'}
  captured.handlers!.onStatus('up_open');
  assert.ok(
    user.sent.some((s) => typeof s.data === 'string' && JSON.parse(s.data).type === 'ready'),
    'up_open mapped to {type:ready}',
  );

  // (e) onStatus('up_close', {timeout:true}) → user gets {type:'reconnect'}
  captured.handlers!.onStatus('up_close', { timeout: true });
  assert.ok(
    user.sent.some((s) => typeof s.data === 'string' && JSON.parse(s.data).type === 'reconnect'),
    'up_close+timeout mapped to {type:reconnect}',
  );

  // (f) a DIRTY close (unclean, non-1000) and up_error both map to {type:'error'}
  captured.handlers!.onStatus('up_close', { code: 1006, clean: false });
  captured.handlers!.onStatus('up_error');
  const errs = user.sent.filter((s) => typeof s.data === 'string' && JSON.parse(s.data).type === 'error');
  assert.ok(errs.length >= 2, 'unclean close and up_error both map to {type:error}');
});

// Regression: a CLEAN close was reported to the browser as {type:'error'}, so claude.ai ending a
// session normally surfaced as "Voice error" after a conversation that had worked. Reproduced
// live on prod before the fix — real speech -> Listening -> Thinking ->
// `page_status up_close code=1000 clean=true -> error`.
test('a CLEAN upstream close (code 1000 / wasClean) is {type:ended}, never {type:error}', async () => {
  for (const close of [{ code: 1000, clean: true }, { code: 1000 }, { code: 1005, clean: true }]) {
    const user = new FakeWs();
    const captured: Captured = {};
    const paired = bridgeClaudeVoice(user as unknown as BridgeSocket, {
      makeChromeMgr: () => makeMgr(new FakeChannel(), captured),
      loadCookie: async () => 'sessionKey=x; lastActiveOrg=O',
    });
    user.emit('message', Buffer.from(JSON.stringify({ type: 'connect', conversationUuid: 'C' })), false);
    await paired;
    captured.handlers!.onStatus('up_close', close);
    const types = user.sent.filter((x) => typeof x.data === 'string').map((x) => JSON.parse(x.data as string).type);
    assert.ok(types.includes('ended'), `clean close ${JSON.stringify(close)} must map to {type:ended}`);
    assert.ok(!types.includes('error'), `clean close ${JSON.stringify(close)} must NOT map to {type:error}`);
  }
});

test('the idle cutoff (4008) still means reconnect, and a dirty close carries its code to the browser', async () => {
  const user = new FakeWs();
  const captured: Captured = {};
  const paired = bridgeClaudeVoice(user as unknown as BridgeSocket, {
    makeChromeMgr: () => makeMgr(new FakeChannel(), captured),
    loadCookie: async () => 'sessionKey=x; lastActiveOrg=O',
  });
  user.emit('message', Buffer.from(JSON.stringify({ type: 'connect', conversationUuid: 'C' })), false);
  await paired;
  // claude.ai's ~10min inactivity cutoff (lm-mobile §3a) — recoverable, not an error.
  captured.handlers!.onStatus('up_close', { code: 4008, timeout: true, clean: true });
  const afterTimeout = user.sent.filter((x) => typeof x.data === 'string').map((x) => JSON.parse(x.data as string).type);
  assert.ok(afterTimeout.includes('reconnect'), '4008 stays reconnect even though wasClean is true');
  assert.ok(!afterTimeout.includes('ended'), 'the timeout branch must win over the clean-close branch');

  captured.handlers!.onStatus('up_close', { code: 1006, clean: false });
  const err = user.sent.map((x) => (typeof x.data === 'string' ? JSON.parse(x.data as string) : null))
    .find((f) => f && f.type === 'error');
  assert.ok(err, 'an unclean close is still an error');
  assert.match(String(err.message), /1006/, 'the close CODE reaches the browser, so the user need not read core-prod.log');
});

test('post-connect user control frames: interrupt/keep_alive → channel.send(text); close + connect are not forwarded', async () => {
  const user = new FakeWs();
  const channel = new FakeChannel();
  const captured: Captured = {};
  const paired = bridgeClaudeVoice(user as unknown as BridgeSocket, {
    makeChromeMgr: () => makeMgr(channel, captured),
    loadCookie: async () => 'sessionKey=x; lastActiveOrg=O',
  });
  user.emit('message', connectFrame(), false);
  await paired;

  // The `type` of every TEXT frame (binary:false) the channel received.
  const textTypes = () =>
    channel.sent
      .filter((s) => !s.binary)
      .map((s) => { try { return JSON.parse(s.data.toString()).type; } catch { return undefined; } });

  // interrupt → forwarded verbatim as a TEXT frame (server-side barge-in reaches claude.ai).
  user.emit('message', Buffer.from(JSON.stringify({ type: 'interrupt' })), false);
  assert.ok(textTypes().includes('interrupt'), 'interrupt forwarded to the channel');
  assert.ok(channel.sent.every((s) => !s.binary), 'control frames forwarded as text, never binary');

  // keep_alive → forwarded too (any non-connect/close control frame).
  user.emit('message', Buffer.from(JSON.stringify({ type: 'keep_alive' })), false);
  assert.ok(textTypes().includes('keep_alive'), 'keep_alive forwarded to the channel');

  // a post-pair connect → NOT re-forwarded (the handshake already ran).
  user.emit('message', Buffer.from(JSON.stringify({ type: 'connect', conversationUuid: 'C2' })), false);
  assert.ok(!textTypes().includes('connect'), 'a post-pair connect is not re-forwarded');

  // close → NOT forwarded; it is a LOCAL teardown that also reclaims the voice channel/tab.
  user.emit('message', Buffer.from(JSON.stringify({ type: 'close' })), false);
  assert.ok(!textTypes().includes('close'), 'close is not forwarded to the channel');
  assert.equal(user.readyState, 3, 'close triggered local teardown');
  assert.equal(channel.closed, 1, 'close reclaimed the voice channel/tab');
});

test('cookie load failure → user told no session + socket closed (openVoicePage never reached)', async () => {
  const user = new FakeWs();
  const paired = bridgeClaudeVoice(user as unknown as BridgeSocket, {
    makeChromeMgr: () => makeMgr(new FakeChannel(), {}),
    loadCookie: async () => { throw new Error('no claude.ai session'); },
  });
  user.emit('message', connectFrame(), false);
  await paired;
  assert.ok(user.sent.some((s) => typeof s.data === 'string' && JSON.parse(s.data).type === 'error'), 'user told relay failed');
  assert.equal(user.readyState, 3, 'user socket closed on cookie failure');
});

test('openVoicePage failure → user told relay failed + socket closed (no dangling channel)', async () => {
  const user = new FakeWs();
  const paired = bridgeClaudeVoice(user as unknown as BridgeSocket, {
    makeChromeMgr: () => mgrThatFailsOpen('launch_failed: no system Chrome'),
    loadCookie: async () => 'sessionKey=x; lastActiveOrg=O',
  });
  user.emit('message', connectFrame(), false);
  await paired;
  assert.ok(user.sent.some((s) => typeof s.data === 'string' && JSON.parse(s.data).type === 'error'), 'user told relay failed');
  assert.equal(user.readyState, 3, 'user socket closed on setup failure');
});

test('a setup failure never becomes an unhandled rejection', async () => {
  const user = new FakeWs();
  const rejections: unknown[] = [];
  const onUnhandled = (err: unknown) => rejections.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const paired = bridgeClaudeVoice(user as unknown as BridgeSocket, {
      makeChromeMgr: () => mgrThatFailsOpen('launch_failed'),
      loadCookie: async () => 'sessionKey=x; lastActiveOrg=O',
    });
    user.emit('message', connectFrame(), false);
    await paired;
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(rejections.length, 0, 'no unhandled rejection escaped the setup-failure path');
    assert.ok(user.sent.some((s) => typeof s.data === 'string' && JSON.parse(s.data).type === 'error'), 'user told relay failed');
    assert.equal(user.readyState, 3, 'user socket closed');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('I1: normal teardown (user close) reclaims the voice channel/tab', async () => {
  const user = new FakeWs();
  const channel = new FakeChannel();
  const paired = bridgeClaudeVoice(user as unknown as BridgeSocket, {
    makeChromeMgr: () => makeMgr(channel, {}),
    loadCookie: async () => 'sessionKey=x; lastActiveOrg=O',
  });
  user.emit('message', connectFrame(), false);
  await paired;
  assert.equal(channel.closed, 0, 'channel stays open while the session is live');

  // User hangs up → teardown must reclaim the tab (closing the user WS never closes it).
  user.readyState = 3;
  user.emit('close');
  await tick();
  assert.equal(channel.closed, 1, 'voice channel/tab reclaimed on teardown');
});

test('I2: user leaves DURING setup → freshly-opened channel is closed (tab reclaimed), never wired to the dead user', async () => {
  const user = new FakeWs();
  const channel = new FakeChannel();
  const captured: Captured = {};
  let releaseGate!: () => void;
  const gate = new Promise<void>((r) => { releaseGate = r; });

  const paired = bridgeClaudeVoice(user as unknown as BridgeSocket, {
    makeChromeMgr: () => makeMgr(channel, captured, { gate }),
    loadCookie: async () => 'sessionKey=x; lastActiveOrg=O',
  });
  user.emit('message', connectFrame(), false);
  await tick(); // advance setup to `await gate` inside openVoicePage (handlers captured, channel pending)
  assert.ok(captured.handlers, 'handlers captured before the user left');

  // User hangs up BEFORE the channel opens.
  user.readyState = 3;
  user.emit('close');
  // ...then the channel finally opens.
  releaseGate();
  await paired;
  await tick(); // flush the post-gate continuation that reclaims the channel

  assert.equal(channel.closed, 1, 'freshly-opened channel closed because the user had already left');

  // A late claude.ai frame must NOT be forwarded onto the dead user socket.
  const before = user.sent.length;
  captured.handlers!.onFrame(Buffer.from([1, 2, 3]), true);
  assert.equal(user.sent.length, before, 'no frame relayed to a closed user socket');
});
