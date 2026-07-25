import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { isValidToken, apiAuthEnabled } from '../auth/api-token';
import { buildClaudeVoiceUrl } from './claude-voice-url';
import { createChromeMgr, type ChromeMgr, type VoiceChannel } from './claude-chrome';
import { readClaudeAISession, parseCookieString } from '../utils/claudeai-session';

// Bidirectional claude.ai voice v2 — the Core transport linchpin. ONE user WS per voice
// session, bridged to claude.ai's voice WS through a headless Chrome page:
//
//   browser ── /voice/claude/ws ──► Core (USER bridge, api-token auth)
//                                     │  loads the node's claude.ai cookie, drives a headless
//                                     │  Chrome that opens claude.ai's SAME-ORIGIN voice WS,
//                                     │  and bridges every frame over Puppeteer CDP bindings
//                                     │  (page.exposeFunction page->Core, page.evaluate
//                                     │  Core->page) — NOT a loopback WS. claude.ai's CSP
//                                     │  (connect-src 'self') forbids the page connecting back
//                                     │  to Core, but a CDP binding is CSP-immune.
//
// Core is a VERBATIM pipe: user opus frames → channel → claude.ai, and claude.ai PCM audio +
// message_sse text → channel → user. The ONLY interpreted frames are the asset's own voice-WS
// lifecycle signals (up_open/up_close/up_error), mapped to a small {ready|reconnect|error}
// vocabulary for the browser. The node's claude.ai cookie is loaded Core-side and handed to
// Chrome — it is NEVER sent to the user. Logging is structural (frame/byte counts + states),
// never audio content. `makeChromeMgr` + `loadCookie` are injectable so the unit test never
// launches a real browser.

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
  /** WHO speaks back — a `CLAUDE_VOICES` id; unknown/absent degrades to the default. */
  voice?: string;
}

/** Injectable dependencies for `bridgeClaudeVoice` (production defaults via `defaultDeps`). */
export interface BridgeDeps {
  /** Returns the (singleton) Chrome manager that hosts voice pages. */
  makeChromeMgr: () => ChromeMgr;
  /** Loads this node's claude.ai Cookie header. Kept Core-side; never sent to the user. */
  loadCookie: () => Promise<string>;
}

const userWss = new WebSocketServer({ noServer: true });

export function isClaudeVoiceUpgrade(req: IncomingMessage): boolean {
  if (!req.url) return false;
  return req.url.split('?')[0] === '/voice/claude/ws';
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
 * Pair a user WS to a claude.ai voice session and pipe frames through the headless-Chrome
 * voice channel. Resolves once the channel is opened and wired (or a handled setup failure
 * has closed the socket) — never rejects, so the `void`-called production path leaves no
 * unhandled rejection.
 */
export function bridgeClaudeVoice(userWs: BridgeSocket, deps: BridgeDeps): Promise<void> {
  const sid = randomBytes(4).toString('hex');
  const t0 = Date.now();
  const vlog = (m: string) => { try { console.log(`[claude-voice ${sid}] ${m}`); } catch { /* noop */ } };

  let channel: VoiceChannel | null = null;
  let connected = false;
  let upFrames = 0, upCtrl = 0, downFrames = 0, downMsgs = 0;

  let resolvePaired: () => void = () => {};
  const paired = new Promise<void>((res) => { resolvePaired = res; });
  let settled = false;
  const settle = () => { if (!settled) { settled = true; resolvePaired(); } };

  const closeChannel = (ch: VoiceChannel | null) => {
    if (!ch) return;
    try { void ch.close().catch(() => { /* best-effort tab reclaim */ }); } catch { /* noop */ }
  };

  const closeAll = (code?: number, reason?: string) => {
    try { if (userWs.readyState === OPEN) userWs.close(code, reason); } catch { /* noop */ }
    // Reclaim the headless-Chrome voice tab — closing the user WS never closes it. Null-out
    // first so repeated closeAll() calls (user close + local close + guard) close it at most once.
    if (channel) {
      const c = channel;
      channel = null;
      closeChannel(c);
    }
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
      // Time-to-first-audio-frame, measured from the user's WS opening. THE latency number for
      // the startup work (docs/superpowers/specs/2026-07-25-voice-v2-latency-hardening-design.md
      // §6) — compare it across cold / warm-browser / primed-page starts.
      if (upFrames === 1) vlog(`first user audio frame relayed to channel (+${Date.now() - t0}ms)`);
      if (channel) { try { channel.send(data, true); } catch { /* noop */ } }
      return;
    }
    // Post-connect user text = control frames. `close` is a LOCAL teardown and `connect` is
    // the already-consumed handshake — neither is forwarded. EVERY other control frame
    // (interrupt / keep_alive, plus Plan-B tool_result / turn_end / approval) is relayed
    // VERBATIM to the channel (which passes it to claude.ai's voice WS) — otherwise
    // server-side barge-in etc. are silently dropped. Forward the raw bytes AS A TEXT frame
    // (binary:false) so claude.ai still sees JSON, not a binary audio frame.
    let msg: { type?: string };
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'close') { closeAll(); return; }
    if (msg.type === 'connect') return; // handshake already ran — never re-forward it
    if (channel) {
      upCtrl++;
      vlog(`user control frame relayed to channel (type=${msg.type ?? '?'}, #${upCtrl})`);
      try { channel.send(data, false); } catch { /* noop */ }
    }
  });
  userWs.on('close', () => {
    vlog(`user closed: up=${upFrames} ctrl=${upCtrl} downBin=${downFrames} downMsg=${downMsgs} ${Date.now() - t0}ms`);
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
      const voiceUrl = buildClaudeVoiceUrl({
        org: org || '',
        conv: String(connectMsg.conversationUuid),
        model: connectMsg.model,
        effort: connectMsg.effort,
        thinkingMode: connectMsg.thinkingMode,
        voice: connectMsg.voice,
      });

      const mgr = deps.makeChromeMgr();
      let opened: VoiceChannel;
      try {
        // Phase timings: `prime` is the persistent-page path (a reuse is ~100ms, a cold prime is
        // the Chrome launch + navigate + CF settle), `page` is this session's own voice tab.
        const tPrime = Date.now();
        await mgr.ensureLoaded(cookie);
        const primeMs = Date.now() - tPrime;
        const tPage = Date.now();
        opened = await mgr.openVoicePage(voiceUrl, {
          // claude.ai -> Core -> user. Binary is PCM audio (forward verbatim as a binary
          // frame); text is message_sse JSON (forward verbatim as a string). The asset's own
          // voice-WS lifecycle arrives via onStatus, mapped to {ready|reconnect|error}.
          onFrame: (frameData: Buffer, binary: boolean) => {
            if (userWs.readyState !== OPEN) return;
            if (binary) {
              downFrames++;
              try { userWs.send(frameData, { binary: true }); } catch { /* noop */ }
            } else {
              downMsgs++;
              try { userWs.send(frameData.toString()); } catch { /* noop */ }
            }
          },
          onStatus: (state, info) => mapPageStatus({ state, timeout: info?.timeout, code: info?.code, reason: info?.reason, clean: info?.clean }),
        });
        vlog(`chrome setup: prime=${primeMs}ms page=${Date.now() - tPage}ms total=${Date.now() - t0}ms`);
      } catch (err) {
        vlog(`chrome relay setup failed: ${(err as Error).message}`);
        toUser({ type: 'error', message: 'voice relay failed to start' });
        closeAll();
        return;
      }

      // The user may have hung up while Chrome was still coming up. Wiring a freshly-opened
      // channel (and its tab) to a closed user socket would leak the tab — reclaim it instead.
      if (userWs.readyState !== OPEN) {
        vlog('user left during setup — closing the freshly-opened voice channel');
        closeChannel(opened);
        return;
      }

      channel = opened;
      vlog('voice channel opened — relaying');
    } finally {
      settle();
    }
  }

  function mapPageStatus(msg: { state?: string; timeout?: boolean; code?: number; reason?: string; clean?: boolean }): void {
    // Diagnostic tail: the close CODE + reason + wasClean the asset now reports (previously
    // discarded — which is why a prod up_error was undiagnosable without a page-level dig).
    const detail = `${msg.code != null ? ` code=${msg.code}` : ''}${msg.reason ? ` reason=${JSON.stringify(String(msg.reason).slice(0, 80))}` : ''}${msg.clean != null ? ` clean=${msg.clean}` : ''}${msg.timeout ? ' (timeout)' : ''}`;
    // The asset reconnects ONCE if claude.ai closed before its handshake (transient upstream/CF
    // reject). Purely informational — no user frame; the retry either succeeds (up_open -> ready)
    // or the second close reports up_close -> error.
    if (msg.state === 'up_retry') { vlog(`page_status up_retry${detail} — claude.ai closed before init; reconnecting once`); return; }
    let out: { type: string } | null = null;
    if (msg.state === 'up_open') out = { type: 'ready' };
    else if (msg.state === 'up_close') out = msg.timeout === true ? { type: 'reconnect' } : { type: 'error' };
    else if (msg.state === 'up_error') out = { type: 'error' };
    if (out) {
      vlog(`page_status ${msg.state}${detail} -> ${out.type}`);
      toUser(out);
    }
  }

  return paired;
}

// ── production defaults ──────────────────────────────────────────────────────

/** `lastActiveOrg` cookie → org UUID for the voice URL. */
function orgFromCookieHeader(cookie: string): string | undefined {
  return parseCookieString(cookie)['lastActiveOrg'];
}

// ONE headless Chrome is reused across voice sessions (createChromeMgr hands out a channel
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

function defaultDeps(): BridgeDeps {
  return {
    makeChromeMgr: defaultMakeChromeMgr,
    loadCookie: defaultLoadCookie,
  };
}
