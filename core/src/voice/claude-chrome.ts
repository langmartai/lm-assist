import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveChromePath } from './voice-v2-capability';

// Puppeteer lifecycle for the voice-v2 relay: launch/reuse ONE headless system Chrome, keep it
// primed with the node's claude.ai cookie (ensureLoaded — this also lets THIS Chrome mint its
// own cf_clearance; Cloudflare binds that cookie to the client's TLS/JA fingerprint, so a value
// copied from a different client fails the challenge — see the design doc's spike finding), then
// hand out one voice CHANNEL per session (openVoicePage) with the Task 3 relay asset injected.
// `launch`/`chromePath` are injectable so unit tests never touch a real browser — see
// core/src/__tests__/claude-chrome.test.ts.
//
// Transport: the injected asset bridges the SAME-ORIGIN claude.ai voice WS <-> Core over
// Puppeteer CDP bindings — page->Core via a `page.exposeFunction('__lmToCore', ...)` native
// binding, Core->page via `page.evaluate(globalThis.__lmFromCore, env)`. This is NOT a loopback
// WebSocket: claude.ai's CSP (connect-src 'self') forbids the page from connecting to Core, but
// a CDP binding is a native binding, not a network connection, so it is CSP-immune. No loopback
// TLS is involved (the earlier SPKI-pinned wss bridge is gone).
//
// Startup cost is the whole point of the second design pass (docs/superpowers/specs/
// 2026-07-25-voice-v2-latency-hardening-design.md). Two mechanisms, doing different jobs:
//   - CONDITION-BASED readiness (waitForClaudeReady) replaces the two blind 10s sleeps that used
//     to dominate every session. VOICE_CHROME_SETTLE_MS is now a CAP, not a floor.
//   - A PERSISTENT PRIMED PAGE + a real CF keepalive removes the per-session REPEAT: ensureLoaded
//     used to navigate a throwaway page and close it again every single session.

const DEFAULT_IDLE_MS = 300_000;
/** CAP on the readiness poll — NOT a fixed sleep (it was, before the latency pass). */
const DEFAULT_SETTLE_MS = 10_000;
const DEFAULT_READY_POLL_MS = 250;
/** Recycle the long-lived primed page periodically so a leaked page can't live forever. */
const DEFAULT_PRIMED_MAX_AGE_MS = 1_800_000;
/** Below __cf_bm's ~10min working lifetime, so the cookie is never stale when a call starts. */
const DEFAULT_CF_KEEPALIVE_MS = 480_000;
const DEFAULT_IDLE_SWEEP_MS = 60_000;

const CLAUDE_AI_URL = 'https://claude.ai/';
const CLAUDE_AI_COOKIE_URL = 'https://claude.ai';

/**
 * The page a VOICE session must sit on: the conversation the voice WS is for.
 *
 * Loading the bare origin instead let the claude.ai SPA restore whatever conversation was
 * last used in this (shared, long-lived) browser — and claude.ai attributes a voice turn to
 * the page's ACTIVE conversation, not to the uuid in the WS URL. The observable result was
 * transcripts from one voice session landing as `human` messages in an UNRELATED
 * conversation (bl_91ebabe8: 8 stray messages in one, 6 and 5 in two others, while the
 * intended target got 2). Pinning the page to /chat/<conv> keeps the page context and the
 * WS target on the same conversation.
 *
 * Returns null when the uuid can't be recovered, so the caller falls back to the old
 * behaviour rather than navigating somewhere wrong.
 */
export function conversationPageUrl(voiceWsUrl: string): string | null {
  const m = /\/chat_conversations\/([^/?#]+)/.exec(voiceWsUrl || '');
  if (!m) return null;
  const conv = decodeURIComponent(m[1]);
  // Guard the path segment: only a plain uuid-ish token, never a traversal or a new origin.
  if (!/^[A-Za-z0-9._-]+$/.test(conv)) return null;
  return `https://claude.ai/chat/${encodeURIComponent(conv)}`;
}
// A REAL Chrome User-Agent — NOT the default headless "HeadlessChrome/..." token. Per
// lm-mobile's validated CF findings (docs/claude-voice-implementation.md §4), the claude.ai
// voice-WS upgrade needs Cookie + Origin: https://claude.ai + a Chrome UA; a headless UA draws
// Cloudflare's bot challenge and the WS up_errors (the intermittent prod variant). Set via the
// launch arg so every page (priming + voice) presents it.
const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
/** Logged by NAME when present. Cookie VALUES are never read, logged, or persisted. */
const CF_COOKIE_NAMES = ['cf_clearance', '__cf_bm', '__cflb', 'cf_chl_rc_m'];

function envInt(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Same-origin `GET /api/account` inside the page; resolves to the HTTP status (0 if the
 * evaluate or the fetch itself failed).
 *
 * This IS the `__cf_bm` refresh the shipped CF fix requires (0f33806 / lm-mobile §4): the HTTP
 * API is not CF-challenged, the browser applies its Set-Cookie into its own jar, so the voice-WS
 * upgrade that follows presents fresh, non-stale CF cookies. Every readiness poll and every
 * keepalive tick therefore also freshens the cookie — the GET happens strictly MORE often than
 * it did behind the old blind sleep, never less. CSP `connect-src 'self'` permits it.
 *
 * A no-op JS ping would NOT do this. Only a real same-origin request makes Cloudflare re-issue
 * Set-Cookie, which is why the keepalive below calls exactly this function.
 */
async function probeAccount(page: any): Promise<number> {
  try {
    const status = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/account', { credentials: 'include', headers: { accept: 'application/json' } });
        return r.status;
      } catch (e) {
        return 0;
      }
    });
    return Number(status) || 0;
  } catch {
    return 0; // page gone / navigating — treated as "not ready"
  }
}

/** Cookie NAMES in the page's jar. Values are deliberately never touched. Names are NOT unique
 *  in a real jar — Cloudflare sets __cf_bm on both `claude.ai` and `.claude.ai` — so the caller
 *  dedupes for logging; presence checks are unaffected either way. */
async function cookieNames(page: any): Promise<string[]> {
  try {
    const list = await page.cookies(CLAUDE_AI_COOKIE_URL);
    if (!Array.isArray(list)) return [];
    return list.map((c: any) => String(c?.name ?? '')).filter(Boolean);
  } catch {
    return []; // injected test fakes have no .cookies(); a real failure is just "unknown"
  }
}

/** The CF cookies present, deduped + stable-ordered, for a readable one-line log. */
function cfPresent(names: string[]): string {
  return CF_COOKIE_NAMES.filter((n) => names.includes(n)).join(',');
}

/** One readiness sample: is claude.ai answering, and has Cloudflare minted a clearance cookie? */
async function probeOnce(page: any): Promise<{ status: number; names: string[]; cf: boolean }> {
  const status = await probeAccount(page);
  const names = await cookieNames(page);
  return { status, names, cf: names.includes('cf_clearance') };
}

export interface ReadyProbe {
  /** Both signals seen: `/api/account` 200 AND cf_clearance in the jar. */
  ready: boolean;
  ms: number;
  status: number;
  cfClearance: boolean;
  names: string[];
}

/**
 * Poll the REAL signals instead of sleeping a fixed 10s.
 *
 * Ready = same-origin `GET /api/account` returns 200 (claude.ai is answering this browser) AND
 * `cf_clearance` is in the jar (Cloudflare's JS challenge has been solved by this Chrome, for
 * this egress IP — the cookie the WS upgrade actually needs).
 *
 * On cap we PROCEED rather than fail: a 200 without cf_clearance just means Cloudflare never
 * challenged this already-trusted browser, and the asset's own reconnect-once still covers a
 * transient reject. This is strictly stronger than what it replaces — a blind sleep confirmed
 * neither signal.
 *
 * `capMs <= 0` returns immediately WITHOUT probing (tests set VOICE_CHROME_SETTLE_MS=0 so no
 * unit test pays for, or has to fake, the poll).
 */
async function waitForClaudeReady(page: any, capMs: number, pollMs: number): Promise<ReadyProbe> {
  const t0 = Date.now();
  if (capMs <= 0) return { ready: false, ms: 0, status: 0, cfClearance: false, names: [] };
  for (;;) {
    const p = await probeOnce(page);
    if (p.status === 200 && p.cf) {
      return { ready: true, ms: Date.now() - t0, status: p.status, cfClearance: true, names: p.names };
    }
    const elapsed = Date.now() - t0;
    if (elapsed >= capMs) {
      return { ready: false, ms: elapsed, status: p.status, cfClearance: p.cf, names: p.names };
    }
    await sleep(Math.min(pollMs, capMs - elapsed));
  }
}

/** Structural log line — cookie NAMES + jar size only, never a single cookie value. */
function logReady(what: string, p: ReadyProbe): void {
  const verdict = p.ready
    ? 'ready'
    : p.status === 200
      ? 'cap reached (api 200, no cf_clearance) — proceeding'
      : `cap reached (api status=${p.status}) — proceeding`;
  console.log(`[voice-chrome] ${what}: ${verdict} in ${p.ms}ms (cf=[${cfPresent(p.names)}] jar=${p.names.length})`);
}

/** Frame/status envelope the asset hands to Core over the `__lmToCore` binding. */
export interface VoiceChannelHandlers {
  /** A frame arriving FROM claude.ai (binary=PCM audio, text=message_sse JSON). */
  onFrame: (data: Buffer, binary: boolean) => void;
  /** The page asset's own voice-WS lifecycle signal. `up_retry` = claude.ai closed before its
   *  handshake and the asset is reconnecting once (transient upstream/CF reject); diagnostic only. */
  onStatus: (
    state: 'up_open' | 'up_close' | 'up_error' | 'up_retry',
    info?: { code?: number; timeout?: boolean; reason?: string; clean?: boolean },
  ) => void;
}

/** A live voice page reduced to the two operations the relay needs. */
export interface VoiceChannel {
  /** Core -> page -> claude.ai: an uplink opus frame (binary) or a control JSON (text). */
  send(data: Buffer, binary: boolean): void;
  /** Close the page (reclaims the headless-Chrome tab). */
  close(): Promise<void>;
}

export interface ChromeMgr {
  ensureLoaded(cookieHeader: string): Promise<void>;
  openVoicePage(voiceUrl: string, handlers: VoiceChannelHandlers): Promise<VoiceChannel>;
  teardownIfIdle(): Promise<void>;
}

export type ChromeMgrErrorCode = 'launch_failed' | 'asset_missing' | 'page_failed';

/** Typed so the relay (Task 5) can tell "no Chrome" / "asset missing" / a page-op failure
 *  apart and surface something meaningful to the browser client instead of a raw throw. */
export class ChromeMgrError extends Error {
  constructor(public code: ChromeMgrErrorCode, message: string, public cause?: unknown) {
    super(message);
  }
}

/** "name1=value1; name2=value2" -> pairs — the inverse of the `cookieHeader` format
 *  claudeai-browser-launch.ts's analyzeClaudeCookies() writes. */
function parseCookieHeader(header: string): Array<{ name: string; value: string }> {
  return header
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq === -1 ? { name: pair, value: '' } : { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
    });
}

/** Rotation detector for the primed page. Hashed so no cookie value is ever held in a
 *  comparable/loggable form; this key is internal and is never logged. */
function cookieKeyOf(header: string): string {
  return createHash('sha256').update(header).digest('hex').slice(0, 16);
}

let cachedAssetSource: string | null = null;

/**
 * Locate + read the Task 3 relay asset. Tried dist-adjacent first (prod — `npm run build`
 * runs scripts/copy-voice-assets.js after tsc, mirroring src/voice/assets -> dist/voice/assets),
 * then falls back to the src tree (works for both dev's dist-test and a src-only build).
 */
function loadRelayAssetSource(): string {
  if (cachedAssetSource !== null) return cachedAssetSource;
  const candidates = [
    path.join(__dirname, 'assets', 'claude-ws-relay.js'),
    path.resolve(__dirname, '..', '..', 'src', 'voice', 'assets', 'claude-ws-relay.js'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        cachedAssetSource = fs.readFileSync(p, 'utf-8');
        return cachedAssetSource;
      }
    } catch {
      // try the next candidate
    }
  }
  throw new ChromeMgrError('asset_missing', `claude-ws-relay.js not found — tried: ${candidates.join(', ')}`);
}

export function createChromeMgr(deps: { launch?: () => Promise<any>; chromePath?: string | null } = {}): ChromeMgr {
  const chromePath = deps.chromePath !== undefined ? deps.chromePath : resolveChromePath();
  const doLaunch: () => Promise<any> = deps.launch ?? (async () => {
    if (!chromePath) throw new ChromeMgrError('launch_failed', 'no system Chrome resolved (resolveChromePath() returned null)');
    // No cert-error flags: the bridge is a CDP binding, not a loopback wss, so there is no
    // self-signed terminator to trust — claude.ai's real cert gets ordinary full validation.
    return puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        // Present a real Chrome UA (not HeadlessChrome) + drop the automation flag so
        // Cloudflare treats the voice-WS upgrade as a real browser (lm-mobile §4). Without
        // these the WS draws a CF bot challenge and up_errors intermittently.
        `--user-agent=${CHROME_UA}`,
        '--disable-blink-features=AutomationControlled',
      ],
    });
  });

  let browser: any = null;
  // Set by the browser's own 'disconnected' event (real puppeteer-core: Browser emits it
  // whenever the underlying CDP transport closes — crash, SIGKILL/OOM signal kill, or a
  // clean close all cascade through the same transport 'close' -> Connection -> Browser
  // path). Deliberately NOT a process().exitCode check: a signal-killed process also has
  // exitCode === null (it sets signalCode instead), so that check alone false-reports
  // "alive" for exactly the crash case this exists to catch.
  let browserDead = false;
  let lastOpenAt = 0;

  // ── persistent primed page ────────────────────────────────────────────────
  // ONE long-lived, already-navigated claude.ai page. It is NOT the voice page: cookies are
  // browser-context-scoped, so this page's only job is to hold a warm, continuously-refreshed
  // cf_clearance + __cf_bm in the shared jar. openVoicePage still opens its own page (it needs
  // the __lmToCore binding, the __VOICE_URL__ global, and its own navigation for a same-origin
  // WS) — but that navigation now lands on a warm origin, so its readiness poll returns on the
  // first sample instead of paying the challenge again. Concurrent sessions keep working.
  let primedPage: any = null;
  let primedAt = 0;
  let primedCookieKey: string | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let primingPromise: Promise<void> | null = null;
  // Live voice channels. Load-bearing for teardownIfIdle: lastOpenAt goes stale during a long
  // call, so an idle sweep that trusted it alone would close Chrome mid-conversation.
  let liveChannels = 0;
  let idleSweeper: ReturnType<typeof setInterval> | null = null;

  const settleCapMs = () => envInt('VOICE_CHROME_SETTLE_MS', DEFAULT_SETTLE_MS);
  const readyPollMs = () => envInt('VOICE_CHROME_READY_POLL_MS', DEFAULT_READY_POLL_MS);
  const primedPageEnabled = () => envInt('VOICE_PRIMED_PAGE', 1) !== 0;

  function stopKeepalive(): void {
    if (!keepaliveTimer) return;
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }

  /** Keep Cloudflare's SHORT-LIVED __cf_bm fresh on the primed page with a REAL same-origin GET
   *  (a no-op setInterval JS ping does not refresh cookies). On failure we only log — the next
   *  ensureLoaded health-check re-primes, which keeps the recovery path single. */
  function startKeepalive(): void {
    stopKeepalive();
    const ms = envInt('VOICE_CF_KEEPALIVE_MS', DEFAULT_CF_KEEPALIVE_MS);
    if (ms <= 0) return;
    keepaliveTimer = setInterval(() => {
      const p = primedPage;
      if (!p) return;
      void (async () => {
        const status = await probeAccount(p);
        const names = await cookieNames(p);
        console.log(`[voice-chrome] cf keepalive: api=${status} cf=[${cfPresent(names)}] jar=${names.length}`);
      })();
    }, ms);
    try { (keepaliveTimer as any).unref?.(); } catch { /* non-Node timer — nothing to unref */ }
  }

  async function dropPrimedPage(): Promise<void> {
    stopKeepalive();
    const p = primedPage;
    primedPage = null;
    primedAt = 0;
    primedCookieKey = null;
    if (p) { try { await p.close(); } catch { /* best-effort */ } }
  }

  /** Cheap structural checks before we even probe: right cookie, not recycled, not closed. */
  function primedUsable(cookieKey: string): boolean {
    if (!primedPage) return false;
    if (primedCookieKey !== cookieKey) return false; // cookie rotated -> re-prime
    if (Date.now() - primedAt >= envInt('VOICE_PRIMED_MAX_AGE_MS', DEFAULT_PRIMED_MAX_AGE_MS)) return false;
    try { if (primedPage.isClosed?.()) return false; } catch { return false; }
    return true;
  }

  async function getBrowser(): Promise<any> {
    if (browser && !browserDead) return browser;
    if (browser && browserDead) {
      console.log('[voice-chrome] reused browser disconnected — relaunching');
      browser = null;
      // The primed page belonged to the dead browser — drop it without trying to close it.
      stopKeepalive();
      primedPage = null;
      primedAt = 0;
      primedCookieKey = null;
    }
    try {
      browser = await doLaunch();
    } catch (err) {
      throw err instanceof ChromeMgrError ? err : new ChromeMgrError('launch_failed', `Chrome launch failed: ${(err as Error).message}`, err);
    }
    browserDead = false;
    try { browser.on?.('disconnected', () => { browserDead = true; }); } catch { /* best-effort — a fake without .on just skips crash-detection */ }
    lastOpenAt = Date.now();
    console.log('[voice-chrome] browser launched');
    return browser;
  }

  async function newPageOr(err0: string): Promise<any> {
    const b = await getBrowser();
    try {
      return await b.newPage();
    } catch (err) {
      throw new ChromeMgrError('page_failed', `${err0}: newPage failed: ${(err as Error).message}`, err);
    }
  }

  async function applyCookies(page: any, cookieHeader: string): Promise<void> {
    const cookies = parseCookieHeader(cookieHeader).map((c) => ({ ...c, url: CLAUDE_AI_COOKIE_URL }));
    if (cookies.length) await page.setCookie(...cookies);
  }

  /** Build (or rebuild) the long-lived primed page. */
  async function reprime(cookieHeader: string, cookieKey: string): Promise<void> {
    const t0 = Date.now();
    await dropPrimedPage();
    const page = await newPageOr('ensureLoaded');
    try {
      await applyCookies(page, cookieHeader);
      await page.goto(CLAUDE_AI_URL, { waitUntil: 'domcontentloaded' });
      logReady('prime', await waitForClaudeReady(page, settleCapMs(), readyPollMs()));
    } catch (err) {
      try { await page.close(); } catch { /* noop */ }
      throw new ChromeMgrError('page_failed', `ensureLoaded failed: ${(err as Error).message}`, err);
    }
    primedPage = page;
    primedAt = Date.now();
    primedCookieKey = cookieKey;
    startKeepalive();
    console.log(`[voice-chrome] primed page created in ${Date.now() - t0}ms`);
  }

  /** VOICE_PRIMED_PAGE=0 path — the original navigate-then-throw-away priming, minus the blind
   *  sleep. Kept so the persistent page can be disabled on a memory-tight host. */
  async function primeThrowaway(cookieHeader: string): Promise<void> {
    const page = await newPageOr('ensureLoaded');
    try {
      await applyCookies(page, cookieHeader);
      await page.goto(CLAUDE_AI_URL, { waitUntil: 'domcontentloaded' });
      logReady('prime (throwaway)', await waitForClaudeReady(page, settleCapMs(), readyPollMs()));
    } catch (err) {
      throw new ChromeMgrError('page_failed', `ensureLoaded failed: ${(err as Error).message}`, err);
    } finally {
      try { await page.close(); } catch { /* best-effort — this is a throwaway priming page */ }
    }
  }

  const mgr: ChromeMgr = {
    async ensureLoaded(cookieHeader: string): Promise<void> {
      const t0 = Date.now();
      await getBrowser();
      if (!primedPageEnabled()) { await primeThrowaway(cookieHeader); return; }

      const key = cookieKeyOf(cookieHeader);
      if (primedUsable(key)) {
        // Cheap validation before reuse. The probe's GET /api/account doubles as a __cf_bm
        // refresh, so a healthy hit both proves and improves readiness.
        const p = await probeOnce(primedPage);
        if (p.status === 200) {
          console.log(`[voice-chrome] primed page reused in ${Date.now() - t0}ms (cf=[${cfPresent(p.names)}] jar=${p.names.length})`);
          return;
        }
        console.log(`[voice-chrome] primed page unhealthy (api=${p.status}) — re-priming`);
        await dropPrimedPage();
      }

      // Single-flight: two sessions starting together must not prime twice.
      if (primingPromise) { await primingPromise; return; }
      primingPromise = reprime(cookieHeader, key).finally(() => { primingPromise = null; });
      await primingPromise;
    },

    async openVoicePage(voiceUrl: string, handlers: VoiceChannelHandlers): Promise<VoiceChannel> {
      const t0 = Date.now();
      const page = await newPageOr('openVoicePage');
      try {
        // The page->Core CDP binding. Registered BEFORE navigation so it exists the instant the
        // relay asset calls globalThis.__lmToCore. exposeFunction args are JSON, so binary rides
        // as base64 ({t:'bin', d:<base64>}); text as {t:'text', d:<utf8>}; the asset's voice-WS
        // lifecycle as {t:'status', state, ...}. CSP does NOT govern this — it is a native
        // binding, not a network request (that is the whole point of this rework).
        await page.exposeFunction('__lmToCore', (env: any) => {
          try {
            if (!env || typeof env !== 'object') return;
            if (env.t === 'status') handlers.onStatus(env.state, { code: env.code, timeout: env.timeout, reason: env.reason, clean: env.clean });
            else if (env.t === 'text') handlers.onFrame(Buffer.from(env.d, 'utf8'), false);
            else if (env.t === 'bin') handlers.onFrame(Buffer.from(env.d, 'base64'), true);
          } catch { /* best-effort — never let a handler throw back across the binding */ }
        });
        // Registered BEFORE navigation so it fires before ANY of the page's own scripts on the
        // upcoming document. The relay asset reads globalThis.__VOICE_URL__ synchronously the
        // instant it's injected (see assets/claude-ws-relay.js) — if it were set after injection
        // instead, the asset would throw new WebSocket(undefined).
        await page.evaluateOnNewDocument((v: string) => {
          // Runs inside the page (browser globalThis === window there); this file's tsconfig
          // has no DOM lib, so globalThis (not window) is what type-checks here in Node.
          (globalThis as any).__VOICE_URL__ = v;
        }, voiceUrl);
        // Navigate to THIS conversation, not the bare origin — see conversationPageUrl().
        // The SPA restoring a different (last-used) conversation is what made voice
        // transcripts surface in unrelated chats.
        await page.goto(conversationPageUrl(voiceUrl) || CLAUDE_AI_URL, { waitUntil: 'domcontentloaded' });
        // Wait for the REAL signals before injecting the asset — the old code slept a blind 10s
        // here, which was both far too long on a warm browser and no guarantee at all on a cold
        // one. With a primed page in the same browser this normally returns on the first sample.
        logReady('voice page', await waitForClaudeReady(page, settleCapMs(), readyPollMs()));
        // One final same-origin GET immediately before the voice-WS upgrade, so the CF fix's
        // ordering invariant holds even when the poll above was skipped (capMs<=0) or ended on a
        // cap. Cheap, and it is the one thing that must not regress (0f33806 / lm-mobile §4).
        await probeAccount(page);
        await page.evaluate(loadRelayAssetSource());
      } catch (err) {
        try { await page.close(); } catch { /* noop */ }
        throw err instanceof ChromeMgrError ? err : new ChromeMgrError('page_failed', `openVoicePage failed: ${(err as Error).message}`, err);
      }
      lastOpenAt = Date.now();
      liveChannels++;
      ensureSweeper();
      console.log(`[voice-chrome] voice page opened in ${Date.now() - t0}ms (live channels: ${liveChannels})`);
      let channelClosed = false;
      // Perf: Core->page is a page.evaluate per uplink frame (~50 fps) + base64; page->Core is
      // the exposeFunction binding (~100 fps downlink). Acceptable for v1 — a CDP
      // Runtime.evaluate fast-path is a future optimization.
      return {
        send: (data: Buffer, binary: boolean): void => {
          void page.evaluate(
            (e: { t: string; d: string }) => (globalThis as any).__lmFromCore(e),
            { t: binary ? 'bin' : 'text', d: binary ? data.toString('base64') : data.toString('utf8') },
          ).catch(() => { /* page gone / navigating — drop this frame */ });
        },
        close: async (): Promise<void> => {
          // Guarded: the relay can call close() from several paths (user close, local close,
          // teardown guard) and liveChannels must not go negative and strand the idle sweeper.
          if (!channelClosed) {
            channelClosed = true;
            liveChannels = Math.max(0, liveChannels - 1);
          }
          await page.close();
        },
      };
    },

    async teardownIfIdle(): Promise<void> {
      if (!browser) return;
      // NEVER close Chrome during a live call. lastOpenAt is set when a channel OPENS, so a long
      // conversation looks "idle" by timestamp alone — this count is what makes the sweep safe.
      if (liveChannels > 0) return;
      const idleMs = envInt('VOICE_CHROME_IDLE_MS', DEFAULT_IDLE_MS);
      if (Date.now() - lastOpenAt < idleMs) return;
      const b = browser;
      browser = null;
      // Bounded footprint: the primed page and its keepalive go away with the browser.
      await dropPrimedPage();
      if (idleSweeper) { clearInterval(idleSweeper); idleSweeper = null; }
      console.log('[voice-chrome] idle teardown — closing browser');
      try { await b.close(); } catch { /* best-effort */ }
    },
  };

  /** teardownIfIdle had NO caller before this pass — the browser lived until Core restarted.
   *  Now that we also hold a page and a keepalive timer, the sweep has to be real. */
  function ensureSweeper(): void {
    if (idleSweeper) return;
    const ms = envInt('VOICE_CHROME_IDLE_SWEEP_MS', DEFAULT_IDLE_SWEEP_MS);
    if (ms <= 0) return;
    idleSweeper = setInterval(() => { void mgr.teardownIfIdle(); }, ms);
    try { (idleSweeper as any).unref?.(); } catch { /* non-Node timer — nothing to unref */ }
  }

  return mgr;
}
