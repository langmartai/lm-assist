import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { isValidToken, apiAuthEnabled } from '../auth/api-token';
import { buildClaudeVoiceUrl } from './claude-voice-url';
import { createChromeMgr, type ChromeMgr } from './claude-chrome';
import { readClaudeAISession, parseCookieString } from '../utils/claudeai-session';

// Bidirectional claude.ai voice v2 — the Core transport linchpin. Two loopback-paired
// WS bridges per voice session:
//
//   browser ── /voice/claude/ws ──────────► Core (USER bridge, api-token auth)
//                                             │  mints a one-time token, drives a
//                                             │  headless Chrome that opens claude.ai's
//                                             │  voice WS and dials back to:
//   Core ◄── /voice/claude/page-bridge ──── headless Chrome (PAGE bridge, loopback-only,
//                                             one-time-token auth)
//
// Once paired, Core is a VERBATIM pipe: user opus frames → page bridge → claude.ai, and
// claude.ai PCM audio + message_sse text → page bridge → user. The ONLY interpreted frames
// are the page asset's own `{type:'__page_status'}` control JSON, mapped to a small
// {ready|reconnect|error} vocabulary for the browser. The node's claude.ai cookie is loaded
// Core-side and handed to Chrome — it is NEVER sent to the user. Logging is structural
// (frame/byte counts + states), never audio content. `makeChromeMgr` + `loadCookie` +
// `waitForPageBridge` are injectable so the unit test never launches a real browser.

const OPEN = 1;

/** Minimal socket surface satisfied by ws.WebSocket — lets tests inject fakes. */
export interface BridgeSocket {
  readyState: number;
  send(data: string | Buffer, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
}

/** The connect handshake the browser sends as its FIRST frame on the user WS. */
interface ConnectMsg {
  type?: string;
  conversationUuid?: string;
  model?: string;
  effort?: string;
  thinkingMode?: string;
}

/** Injectable dependencies for `bridgeClaudeVoice` (production defaults via `defaultDeps`). */
export interface BridgeDeps {
  /** Returns the (singleton) Chrome manager that hosts voice pages. */
  makeChromeMgr: () => ChromeMgr;
  /** Loads this node's claude.ai Cookie header. Kept Core-side; never sent to the user. */
  loadCookie: () => Promise<string>;
  /** Resolves with the page-bridge socket once THIS node's Chrome dials back with `token`. */
  waitForPageBridge: (token: string) => Promise<BridgeSocket>;
  /** HTTPS terminator port the page-bridge URL points at (wss://127.0.0.1:<port>). */
  httpsPort: number;
  /** One-time bridge-token mint. Defaults to 24 random bytes hex. */
  mintToken?: () => string;
}

const userWss = new WebSocketServer({ noServer: true });
const pageWss = new WebSocketServer({ noServer: true });

// Pending pairings keyed by the one-time bridge token, shared between the user-side
// (registers) and the page-bridge-side (matches + resolves) upgrade paths.
interface PendingBridge {
  resolve: (pageWs: BridgeSocket) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingBridges = new Map<string, PendingBridge>();
const PAGE_BRIDGE_TIMEOUT_MS = 30_000;

export function isClaudeVoiceUpgrade(req: IncomingMessage): boolean {
  if (!req.url) return false;
  return req.url.split('?')[0] === '/voice/claude/ws';
}

export function isClaudeVoicePageBridgeUpgrade(req: IncomingMessage): boolean {
  if (!req.url) return false;
  return req.url.split('?')[0] === '/voice/claude/page-bridge';
}

export interface ClaudeVoiceUpgradeOpts {
  apiKey?: string;
}

/**
 * User-side upgrade (`/voice/claude/ws`). Same api-token gate as the STT relay
 * (honors the LM_ASSIST_API_AUTH=0 kill-switch; accepts the rotating ring token or
 * the `serve --api-key` credential via ?token=). On success, starts `bridgeClaudeVoice`.
 */
export function handleClaudeVoiceUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  opts: ClaudeVoiceUpgradeOpts = {},
): void {
  let token: string | null = null;
  try { token = new URL(req.url || '', 'http://localhost').searchParams.get('token'); } catch { /* noop */ }
  if (apiAuthEnabled()) {
    const ok = isValidToken(token) || (!!opts.apiKey && token === opts.apiKey);
    if (!ok) {
      console.log('[claude-voice] user upgrade REJECTED — invalid/missing token');
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  console.log('[claude-voice] user upgrade OK — starting bridge');
  userWss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    void bridgeClaudeVoice(ws as unknown as BridgeSocket, defaultDeps());
  });
}

/**
 * Page-bridge upgrade (`/voice/claude/page-bridge`). LOOPBACK-ONLY — the bridge is dialed
 * by THIS node's own headless Chrome, so a non-127.0.0.1/::1 peer is rejected outright.
 * The `?token=` must match a pending pairing registered by the user side; on match the two
 * sockets are paired by resolving that pairing's promise.
 */
export function handleClaudeVoicePageBridgeUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  _opts: ClaudeVoiceUpgradeOpts = {},
): void {
  const remote = (socket as unknown as Socket).remoteAddress;
  if (!isLoopbackAddress(remote)) {
    console.log(`[claude-voice] page-bridge upgrade REJECTED — non-loopback peer ${remote ?? '?'}`);
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  let token: string | null = null;
  try { token = new URL(req.url || '', 'http://localhost').searchParams.get('token'); } catch { /* noop */ }
  const pending = token ? pendingBridges.get(token) : undefined;
  if (!pending || !token) {
    console.log('[claude-voice] page-bridge upgrade REJECTED — unknown/expired token');
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  pendingBridges.delete(token);
  clearTimeout(pending.timer);
  console.log('[claude-voice] page-bridge upgrade OK — pairing with user session');
  pageWss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    pending.resolve(ws as unknown as BridgeSocket);
  });
}

/**
 * Pair a user WS to a claude.ai voice session and pipe frames. Resolves once the page
 * bridge is paired and wired (or a handled setup failure has closed the sockets) — never
 * rejects, so the `void`-called production path leaves no unhandled rejection.
 */
export function bridgeClaudeVoice(userWs: BridgeSocket, deps: BridgeDeps): Promise<void> {
  const sid = randomBytes(4).toString('hex');
  const t0 = Date.now();
  const vlog = (m: string) => { try { console.log(`[claude-voice ${sid}] ${m}`); } catch { /* noop */ } };

  let pageWs: BridgeSocket | null = null;
  let connected = false;
  let upFrames = 0, downFrames = 0, downMsgs = 0;

  let resolvePaired: () => void = () => {};
  const paired = new Promise<void>((res) => { resolvePaired = res; });
  let settled = false;
  const settle = () => { if (!settled) { settled = true; resolvePaired(); } };

  const closeAll = (code?: number, reason?: string) => {
    try { if (pageWs && pageWs.readyState === OPEN) pageWs.close(code, reason); } catch { /* noop */ }
    try { if (userWs.readyState === OPEN) userWs.close(code, reason); } catch { /* noop */ }
  };
  const toUser = (obj: Record<string, unknown>) => {
    if (userWs.readyState === OPEN) { try { userWs.send(JSON.stringify(obj)); } catch { /* noop */ } }
  };

  userWs.on('message', (...a: unknown[]) => {
    const data = a[0] as Buffer;
    const isBinary = !!a[1];
    if (!connected) {
      // First frame must be the connect handshake; ignore stray audio before it.
      if (isBinary) return;
      let msg: ConnectMsg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type !== 'connect' || !msg.conversationUuid) {
        vlog('first user frame was not a valid connect — ignoring');
        return;
      }
      connected = true;
      void startBridge(msg);
      return;
    }
    if (isBinary) {
      upFrames++;
      if (upFrames === 1) vlog('first user audio frame relayed to page bridge');
      if (pageWs && pageWs.readyState === OPEN) { try { pageWs.send(data, { binary: true }); } catch { /* noop */ } }
      return;
    }
    // Post-connect user text: only an explicit close is meaningful here.
    let msg: { type?: string };
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'close') closeAll();
  });
  userWs.on('close', () => {
    vlog(`user closed: up=${upFrames} downBin=${downFrames} downMsg=${downMsgs} ${Date.now() - t0}ms`);
    closeAll();
    settle();
  });
  userWs.on('error', () => { vlog('user socket error'); closeAll(); settle(); });

  async function startBridge(connectMsg: ConnectMsg): Promise<void> {
    try {
      let cookie: string;
      try {
        cookie = await deps.loadCookie();
      } catch (err) {
        vlog(`cookie load failed: ${(err as Error).message}`);
        toUser({ type: 'error', message: 'no claude.ai session on this node' });
        closeAll();
        return;
      }

      const org = orgFromCookieHeader(cookie);
      const mint = deps.mintToken ?? (() => randomBytes(24).toString('hex'));
      const token = mint();
      const voiceUrl = buildClaudeVoiceUrl({
        org: org || '',
        conv: String(connectMsg.conversationUuid),
        model: connectMsg.model,
        effort: connectMsg.effort,
        thinkingMode: connectMsg.thinkingMode,
      });
      const bridgeUrl = `wss://127.0.0.1:${deps.httpsPort}/voice/claude/page-bridge?token=${encodeURIComponent(token)}`;

      // Register the pending pairing BEFORE opening the page so the loopback page-bridge
      // WS can match this token the instant Chrome dials back.
      const bridgePromise = deps.waitForPageBridge(token);

      const mgr = deps.makeChromeMgr();
      try {
        await mgr.ensureLoaded(cookie);
        await mgr.openVoicePage(voiceUrl, bridgeUrl);
      } catch (err) {
        vlog(`chrome relay setup failed: ${(err as Error).message}`);
        toUser({ type: 'error', message: 'voice relay failed to start' });
        closeAll();
        return;
      }

      try {
        pageWs = await bridgePromise;
      } catch (err) {
        vlog(`page bridge did not connect: ${(err as Error).message}`);
        toUser({ type: 'error', message: 'voice page bridge timed out' });
        closeAll();
        return;
      }

      vlog('page bridge paired — relaying');
      wirePageBridge(pageWs);
    } finally {
      settle();
    }
  }

  function wirePageBridge(pw: BridgeSocket): void {
    pw.on('message', (...a: unknown[]) => {
      const data = a[0] as Buffer;
      const isBinary = !!a[1];
      if (isBinary) {
        downFrames++;
        if (userWs.readyState === OPEN) { try { userWs.send(data, { binary: true }); } catch { /* noop */ } }
        return;
      }
      const text = data.toString();
      let msg: { type?: string; state?: string; timeout?: boolean } | null;
      try { msg = JSON.parse(text); } catch { msg = null; }
      if (msg && msg.type === '__page_status') { mapPageStatus(msg); return; }
      // claude.ai message_sse text — forward verbatim to the user.
      downMsgs++;
      if (userWs.readyState === OPEN) { try { userWs.send(text); } catch { /* noop */ } }
    });
    pw.on('close', () => { vlog('page bridge closed'); closeAll(); });
    pw.on('error', () => { vlog('page bridge socket error'); closeAll(); });
  }

  function mapPageStatus(msg: { state?: string; timeout?: boolean }): void {
    let out: { type: string } | null = null;
    if (msg.state === 'up_open') out = { type: 'ready' };
    else if (msg.state === 'up_close') out = msg.timeout === true ? { type: 'reconnect' } : { type: 'error' };
    else if (msg.state === 'up_error') out = { type: 'error' };
    if (out) {
      vlog(`page_status ${msg.state}${msg.timeout ? ' (timeout)' : ''} -> ${out.type}`);
      toUser(out);
    }
  }

  return paired;
}

// ── production defaults ──────────────────────────────────────────────────────

/** Strict loopback (NOT the machine's LAN IPs) — the page bridge is always same-host. */
function isLoopbackAddress(ip: string | undefined | null): boolean {
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** `lastActiveOrg` cookie → org UUID for the voice URL. */
function orgFromCookieHeader(cookie: string): string | undefined {
  return parseCookieString(cookie)['lastActiveOrg'];
}

// ONE headless Chrome is reused across voice sessions (createChromeMgr hands out a page
// per session and idles the browser down when unused).
let sharedChromeMgr: ChromeMgr | null = null;
function defaultMakeChromeMgr(): ChromeMgr {
  if (!sharedChromeMgr) sharedChromeMgr = createChromeMgr();
  return sharedChromeMgr;
}

async function defaultLoadCookie(): Promise<string> {
  const cfg = readClaudeAISession();
  if (!cfg || !cfg.cookie) throw new Error('no claude.ai session configured on this node');
  return cfg.cookie;
}

/** Default pairing wait: registers the token, times out + cleans up if Chrome never dials. */
function defaultWaitForPageBridge(token: string): Promise<BridgeSocket> {
  return new Promise<BridgeSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingBridges.delete(token);
      reject(new Error(`page bridge did not connect within ${PAGE_BRIDGE_TIMEOUT_MS}ms`));
    }, PAGE_BRIDGE_TIMEOUT_MS);
    timer.unref?.();
    pendingBridges.set(token, { resolve, timer });
  });
}

/** HTTPS terminator port — same resolution as rest-server's maybeStartHttps / the terminator. */
function resolveHttpsPort(): number {
  const isProdInstall = process.env.LM_ASSIST_PROD === 'true' || __dirname.includes('node_modules');
  const webPort = parseInt(
    process.env.WEB_PORT || process.env.ASSIST_WEB_PORT || (isProdInstall ? '3848' : '3948'),
    10,
  );
  return parseInt(process.env.LM_HTTPS_PORT || String(webPort + 1), 10);
}

function defaultDeps(): BridgeDeps {
  return {
    makeChromeMgr: defaultMakeChromeMgr,
    loadCookie: defaultLoadCookie,
    waitForPageBridge: defaultWaitForPageBridge,
    httpsPort: resolveHttpsPort(),
    mintToken: () => randomBytes(24).toString('hex'),
  };
}
