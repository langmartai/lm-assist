import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isVoiceSttUpgrade, bridgeVoiceSocket, type SttLike } from '../voice-relay';
import type { IncomingMessage } from 'node:http';

test('isVoiceSttUpgrade matches only the voice path', () => {
  assert.equal(isVoiceSttUpgrade({ url: '/voice/stt/ws?token=x' } as IncomingMessage), true);
  assert.equal(isVoiceSttUpgrade({ url: '/voice/stt/ws' } as IncomingMessage), true);
  assert.equal(isVoiceSttUpgrade({ url: '/ttyd/1234' } as IncomingMessage), false);
  assert.equal(isVoiceSttUpgrade({ url: undefined } as IncomingMessage), false);
});

/** Fake browser WS: captures sent frames, is an EventEmitter for message/close/error. */
class FakeWs extends EventEmitter {
  readyState = 1; // OPEN
  sent: string[] = [];
  closed = false;
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; }
}

/** Fake STT client: records calls, is an EventEmitter for transcript/error/close. */
class FakeStt extends EventEmitter implements SttLike {
  connected = false;
  audio: Buffer[] = [];
  finalized = false;
  closedStt = false;
  async connect() { this.connected = true; }
  sendAudio(buf: Buffer) { this.audio.push(buf); }
  async finalize() { this.finalized = true; return 'ok'; }
  close() { this.closedStt = true; }
}

test('bridge: connects, announces ready, forwards audio + finalize, relays transcript/error', async () => {
  const ws = new FakeWs();
  const stt = new FakeStt();
  await bridgeVoiceSocket(ws, async () => stt);

  assert.equal(stt.connected, true, 'stt.connect() awaited');
  assert.deepEqual(JSON.parse(ws.sent.at(-1)!), { type: 'ready' }, 'ready announced');

  // browser → stt: binary audio
  ws.emit('message', Buffer.from([9, 8, 7]), true);
  assert.equal(stt.audio.length, 1);
  assert.deepEqual([...stt.audio[0]], [9, 8, 7], 'binary forwarded as audio');

  // browser → stt: finalize control frame
  ws.emit('message', Buffer.from('{"type":"finalize"}'), false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(stt.finalized, true, 'finalize() invoked');

  // stt → browser: transcript + error relayed as JSON
  stt.emit('transcript', 'hello there', true);
  assert.deepEqual(JSON.parse(ws.sent.at(-1)!), { type: 'transcript', text: 'hello there', final: true });
  stt.emit('error', new Error('boom'));
  assert.deepEqual(JSON.parse(ws.sent.at(-1)!), { type: 'error', message: 'boom' });
});

test('bridge: a failing connect reports an error and closes', async () => {
  const ws = new FakeWs();
  await bridgeVoiceSocket(ws, async () => { throw new Error('no oauth token'); });
  assert.deepEqual(JSON.parse(ws.sent.at(-1)!), { type: 'error', message: 'no oauth token' });
  assert.equal(ws.closed, true, 'socket closed after connect failure');
});
