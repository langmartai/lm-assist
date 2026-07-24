import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { WebSocketServer } from 'ws';
import { resolveChromePath } from '../voice/voice-v2-capability';
import { bridgeClaudeVoice, type BridgeSocket } from '../voice/claude-voice-relay';
import type { ChromeMgr } from '../voice/claude-chrome';

/**
 * THE regression test the voice-v2 ship was missing.
 *
 * The merged Plan A e2e asserted only that `{ready}` arrived — and that is exactly how a
 * completely dead audio path reached production: `{ready}` proves the TRANSPORT came up and
 * says nothing at all about audio. Prod ran with `up=0` (not one uplink frame) while reporting
 * a healthy `page_status up_open -> ready`.
 *
 * So this test asserts AUDIO FLOWS:
 *
 *   [real headless Chrome + a fake mic device]
 *       web/public/voice/claude-voice-engine.js        <- the real engine asset, not a stub
 *           getUserMedia -> resample 48k->16k -> WebCodecs Opus -> onFrame
 *               |  ws.send(opus)
 *               v
 *       real ws server -> bridgeClaudeVoice(userWs, { makeChromeMgr: stub, loadCookie })
 *               |
 *               +-- ASSERT the relay's channel received binary frames
 *
 * claude.ai is stubbed at the documented `makeChromeMgr` seam, so this needs no cookies and no
 * network — but everything on our side of that seam is real: real Chrome, real capture, real
 * encode, real socket, real relay pipe.
 *
 * The stub deliberately DELAYS `up_open`, so frames are produced before the relay is ready and
 * the click-time-mic path (design §4) is genuinely exercised: we assert those early frames were
 * buffered and flushed, not silently dropped by a `readyState === OPEN` guard. (The gate's own
 * semantics — cap, ordering, idempotent open — are unit-tested in
 * web/src/lib/claude-voice-uplink.test.ts; the glue below is a deliberately minimal stand-in.)
 *
 * NOT passed: `--autoplay-policy=no-user-gesture-required`. The engine must keep working under
 * the real autoplay condition, or this stops covering the bug it exists for.
 */

/** Same 3 levels up from both `core/src/__tests__` (tsx) and `core/dist-test/__tests__` (npm test). */
const ENGINE_PATH = path.resolve(__dirname, '..', '..', '..', 'web', 'public', 'voice', 'claude-voice-engine.js');

const CHROME_PATH = resolveChromePath();
const skip = !CHROME_PATH
  ? 'no system Chrome resolved — this environment cannot run the audio e2e'
  : !fs.existsSync(ENGINE_PATH)
    ? `voice engine asset not found at ${ENGINE_PATH}`
    : false;

/** Long enough that frames must be buffered, short enough to keep the suite well inside the
 *  runner's 60s per-file bisect bound. */
const READY_DELAY_MS = 600;
const DEADLINE_MS = 25_000;

function pageHtml(wsUrl: string): string {
  return `<!doctype html><html><body><script type="module">
window.__r = { frames: 0, framesBeforeReady: 0, sent: 0, ready: false, err: null };
(async () => {
  try {
    const ws = new WebSocket(${JSON.stringify(wsUrl)});
    ws.binaryType = 'arraybuffer';
    let ring = [];
    const send = (f) => { if (ws.readyState === 1) { ws.send(f); window.__r.sent++; } };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connect', conversationUuid: 'conv-e2e' }));
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let f; try { f = JSON.parse(ev.data); } catch (e) { return; }
      if (f.type === 'ready') {
        window.__r.ready = true;
        const pending = ring; ring = [];
        for (const x of pending) send(x);
      } else if (f.type === 'error') {
        window.__r.err = f.message || 'relay error';
      }
    };
    // Mirrors the hook: the socket is created, then the mic opens IMMEDIATELY — not on {ready}.
    const m = await import('/engine.js');
    const engine = m.createClaudeVoiceEngine();
    await engine.start({
      onFrame: (opus) => {
        window.__r.frames++;
        if (window.__r.ready) send(opus);
        else { window.__r.framesBeforeReady++; ring.push(opus); if (ring.length > 250) ring.splice(0, ring.length - 250); }
      },
      onState: (s) => { if (s === 'error') window.__r.err = 'engine error'; },
    });
  } catch (e) { window.__r.err = String((e && e.message) || e); }
})();
</script></body></html>`;
}

test('audio flows end-to-end: the real engine captures in real Chrome and the relay receives opus (up>0)', { skip }, async () => {
  const engineSource = fs.readFileSync(ENGINE_PATH, 'utf-8');

  let upBinary = 0;
  let upBytes = 0;
  const chromeStub: ChromeMgr = {
    ensureLoaded: async () => {},
    openVoicePage: async (_voiceUrl, handlers) => {
      // Delay the ready signal so the page necessarily buffers before it can send.
      const t = setTimeout(() => handlers.onStatus('up_open'), READY_DELAY_MS);
      t.unref?.();
      return {
        send: (data: Buffer, binary: boolean) => { if (binary) { upBinary++; upBytes += data.length; } },
        close: async () => {},
      };
    },
    teardownIfIdle: async () => {},
  };

  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    void bridgeClaudeVoice(ws as unknown as BridgeSocket, {
      makeChromeMgr: () => chromeStub,
      loadCookie: async () => 'sessionKey=test-only; lastActiveOrg=org-e2e',
    });
  });
  await new Promise<void>((r) => wss.on('listening', () => r()));
  const wsPort = (wss.address() as { port: number }).port;

  const server = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/engine.js')) {
      res.setHeader('content-type', 'application/javascript');
      res.end(engineSource);
    } else {
      res.setHeader('content-type', 'text/html');
      res.end(pageHtml(`ws://127.0.0.1:${wsPort}/voice/claude/ws`));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const httpPort = (server.address() as { port: number }).port;

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH as string,
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      // Auto-grant the mic and feed it Chrome's synthetic tone — the only way to assert on real
      // captured audio in CI. Deliberately NOT --autoplay-policy=no-user-gesture-required.
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    ],
  });

  type PageResult = { frames: number; framesBeforeReady: number; sent: number; ready: boolean; err: string | null };
  let r: PageResult = { frames: 0, framesBeforeReady: 0, sent: 0, ready: false, err: null };
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${httpPort}/`, { waitUntil: 'load' });

    const deadline = Date.now() + DEADLINE_MS;
    for (;;) {
      r = await page.evaluate(() => (globalThis as any).__r) as PageResult;
      if (r.err) break;
      // Success needs BOTH: the ring was flushed, and audio actually reached the relay.
      if (r.framesBeforeReady > 0 && upBinary >= r.framesBeforeReady && upBinary > 0) break;
      if (Date.now() >= deadline) break;
      await new Promise((res) => setTimeout(res, 100));
    }
  } finally {
    // Leak nothing: run-tests.js reports a suite that keeps the loop alive as HUNG, not as slow.
    await browser.close().catch(() => {});
    await new Promise<void>((res) => server.close(() => res()));
    await new Promise<void>((res) => wss.close(() => res()));
  }

  assert.equal(r.err, null, `page reported an error: ${r.err}`);
  // The bug that shipped: the engine produced ZERO frames. This is the assertion that catches it.
  assert.ok(r.frames > 0, 'the engine must actually capture and encode audio (0 frames = the shipped bug)');
  assert.ok(r.framesBeforeReady > 0, 'frames must have been produced BEFORE {ready} — otherwise the buffering path went untested');
  // The assertion the merged Plan A e2e was missing: {ready} alone is not audio.
  assert.ok(upBinary > 0, `the relay must RECEIVE opus frames, not merely report ready (up=${upBinary})`);
  assert.ok(
    upBinary >= r.framesBeforeReady,
    `frames captured before {ready} must be flushed, not dropped (buffered=${r.framesBeforeReady}, relay got ${upBinary})`,
  );
  assert.ok(upBytes > 0, 'received frames must carry payload bytes');
});
