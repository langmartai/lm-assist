import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { isValidToken, apiAuthEnabled } from '../auth/api-token';
import { getValidAccessToken, detectClaudeCodeVersion } from '../utils/claude-oauth';
import { STTClient } from './stt-client';

// Browser → Core → Anthropic STT relay. The browser opens `wss://<core>/voice/stt/ws?token=<api-token>`
// (it can't set WS headers, so the api-token rides the query string), streams linear16 PCM binary
// frames up, and receives {type:'transcript',text,final} JSON down. Core holds the OAuth token and
// speaks the real voice_stream protocol via STTClient — the browser never sees the OAuth token.

// Minimal STT surface the bridge needs — lets tests inject a fake without a real WS.
export interface SttLike {
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  connect(): Promise<void>;
  sendAudio(buf: Buffer): void;
  finalize(): Promise<string>;
  close(): void;
}
// Minimal browser-socket surface (satisfied by ws.WebSocket).
export interface BrowserSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
}
const OPEN = 1;

const wss = new WebSocketServer({ noServer: true });

export function isVoiceSttUpgrade(req: IncomingMessage): boolean {
  if (!req.url) return false;
  return req.url.split('?')[0] === '/voice/stt/ws';
}

export function handleVoiceSttUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, serverApiKey?: string): void {
  let token: string | null = null;
  try { token = new URL(req.url || '', 'http://localhost').searchParams.get('token'); } catch { /* noop */ }
  // Mirror the HTTP auth path (rest-server): honor the LM_ASSIST_API_AUTH=0 kill-switch and accept
  // either the rotating ring token or the `serve --api-key` credential.
  if (apiAuthEnabled()) {
    const ok = isValidToken(token) || (!!serverApiKey && token === serverApiKey);
    if (!ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => { void bridgeVoiceSocket(ws as unknown as BrowserSocket); });
}

/** Default STT factory: a real STTClient bound to this node's OAuth token. */
async function defaultMakeClient(): Promise<SttLike> {
  const { accessToken } = await getValidAccessToken();
  const ver = detectClaudeCodeVersion();
  return new STTClient({ token: accessToken, userAgent: `claude-cli/${ver} (external, cli)` });
}

/** Bridge a browser socket to an STT client. `makeClient` is injectable for tests. */
export async function bridgeVoiceSocket(ws: BrowserSocket, makeClient: () => Promise<SttLike> = defaultMakeClient): Promise<void> {
  let stt: SttLike | null = null;
  const closeAll = (code?: number, reason?: string) => {
    try { stt?.close(); } catch { /* noop */ }
    try { if (ws.readyState === OPEN) ws.close(code, reason); } catch { /* noop */ }
  };

  try {
    stt = await makeClient();
    stt.on('transcript', (...a: unknown[]) => {
      if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'transcript', text: a[0] as string, final: !!a[1] }));
    });
    stt.on('error', (...a: unknown[]) => {
      const message = (a[0] as Error)?.message ?? String(a[0]);
      if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'error', message }));
    });
    stt.on('close', () => closeAll());
    await stt.connect();
    if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'ready' }));
  } catch (err) {
    if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'error', message: (err as Error).message }));
    closeAll();
    return;
  }

  ws.on('message', (...a: unknown[]) => {
    const data = a[0] as Buffer;
    const isBinary = !!a[1];
    if (isBinary) { stt?.sendAudio(data); return; }
    let msg: { type?: string };
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'finalize') void stt?.finalize();
    else if (msg.type === 'close') closeAll();
  });
  ws.on('close', () => { try { stt?.close(); } catch { /* noop */ } });
  ws.on('error', () => closeAll());
}
