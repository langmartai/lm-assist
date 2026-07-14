import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { AddressInfo } from 'node:net';
import { STTClient, buildUrl } from '../stt-client';

test('buildUrl carries the spike query params + keyterms', () => {
  const u = buildUrl({ baseUrl: 'https://api.anthropic.com', keyterms: ['Oanda', 'Bcf'] });
  assert.match(u, /^wss:\/\/api\.anthropic\.com\/api\/ws\/speech_to_text\/voice_stream\?/);
  assert.match(u, /encoding=linear16/);
  assert.match(u, /sample_rate=16000/);
  assert.match(u, /use_conversation_engine=true/);
  assert.match(u, /stt_provider=deepgram-nova3/);
  assert.match(u, /keyterms=Oanda/);
  assert.match(u, /keyterms=Bcf/);
});

/** Spin a mock voice_stream server; drive a full connect→audio→transcript→finalize cycle. */
test('STTClient: connect sends KeepAlive, forwards audio, emits interim+final, finalize sends CloseStream', async () => {
  const wss = new WebSocketServer({ port: 0 });
  const port = await new Promise<number>((r) => wss.on('listening', () => r((wss.address() as AddressInfo).port)));

  const serverMsgs: string[] = [];
  let gotBinary = false;
  let serverConn: WsSocket | null = null;
  wss.on('connection', (ws) => {
    serverConn = ws;
    ws.on('message', (data, isBinary) => {
      if (isBinary) { gotBinary = true; return; }
      serverMsgs.push(data.toString());
    });
  });

  const client = new STTClient({ token: 'test-token', baseUrl: `ws://127.0.0.1:${port}` });
  const transcripts: Array<{ text: string; final: boolean }> = [];
  client.on('transcript', (text: string, final: boolean) => transcripts.push({ text, final }));

  await client.connect();
  // Give the server a tick to receive the initial KeepAlive.
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(serverMsgs.includes('{"type":"KeepAlive"}'), 'initial KeepAlive sent on open');

  client.sendAudio(Buffer.from([1, 2, 3, 4]));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(gotBinary, true, 'binary audio forwarded to the WS');

  // Server streams an interim then an endpoint (finalizes the interim).
  serverConn!.send('{"type":"TranscriptText","data":"hello world"}');
  serverConn!.send('{"type":"TranscriptEndpoint"}');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(transcripts[0], { text: 'hello world', final: false }, 'interim transcript emitted');
  assert.deepEqual(transcripts.find((t) => t.final), { text: 'hello world', final: true }, 'final transcript on endpoint');

  const reason = await client.finalize();
  assert.ok(serverMsgs.includes('{"type":"CloseStream"}'), 'finalize sends CloseStream');
  assert.equal(typeof reason, 'string');

  client.close();
  await new Promise<void>((r) => wss.close(() => r()));
});

test('STTClient: surfaces a mid-stream error frame', async () => {
  const wss = new WebSocketServer({ port: 0 });
  const port = await new Promise<number>((r) => wss.on('listening', () => r((wss.address() as AddressInfo).port)));
  wss.on('connection', (ws) => ws.send('{"type":"TranscriptError","description":"bad audio"}'));

  const client = new STTClient({ token: 't', baseUrl: `ws://127.0.0.1:${port}` });
  const err = await new Promise<Error>(async (resolve) => {
    client.on('error', resolve);
    await client.connect();
  });
  assert.match(err.message, /bad audio/);
  client.close();
  await new Promise<void>((r) => wss.close(() => r()));
});
