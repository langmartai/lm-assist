import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { resolveChromePath } from './voice-v2-capability';

// Puppeteer lifecycle for the voice-v2 relay: launch/reuse ONE headless system Chrome,
// prime it with the node's claude.ai cookie (ensureLoaded — this also lets THIS Chrome mint
// its own cf_clearance; Cloudflare binds that cookie to the client's TLS/JA fingerprint, so a
// value copied from a different client fails the challenge — see the design doc's spike
// finding), then hand out one fresh Page per voice session (openVoicePage) with the Task 3
// relay asset injected. `launch`/`chromePath` are injectable so unit tests never touch a real
// browser — see core/src/__tests__/claude-chrome.test.ts.

const DEFAULT_IDLE_MS = 300_000;
const DEFAULT_SETTLE_MS = 9_000;
const CLAUDE_AI_URL = 'https://claude.ai/';
const CLAUDE_AI_COOKIE_URL = 'https://claude.ai';

export interface VoicePage {
  evaluate(fn: string, ...args: unknown[]): Promise<unknown>;
  close(): Promise<void>;
  on(ev: string, cb: (...a: unknown[]) => void): void;
}

export interface ChromeMgr {
  ensureLoaded(cookieHeader: string): Promise<void>;
  openVoicePage(voiceUrl: string, bridgeUrl: string): Promise<VoicePage>;
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

let cachedAssetSource: string | null = null;

/**
 * Locate + read the Task 3 relay asset. Tried dist-adjacent first (prod, once a pack step
 * copies src/voice/assets -> dist/voice/assets — not wired yet, see task-4-report.md), then
 * falls back to the src tree (works today for both dev's dist-test and a src-only prod build).
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
    return puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
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

  async function getBrowser(): Promise<any> {
    if (browser && !browserDead) return browser;
    if (browser && browserDead) {
      console.log('[voice-chrome] reused browser disconnected — relaunching');
      browser = null;
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

  return {
    async ensureLoaded(cookieHeader: string): Promise<void> {
      const b = await getBrowser();
      let page: any;
      try {
        page = await b.newPage();
      } catch (err) {
        throw new ChromeMgrError('page_failed', `ensureLoaded: newPage failed: ${(err as Error).message}`, err);
      }
      try {
        const cookies = parseCookieHeader(cookieHeader).map((c) => ({ ...c, url: CLAUDE_AI_COOKIE_URL }));
        if (cookies.length) await page.setCookie(...cookies);
        await page.goto(CLAUDE_AI_URL, { waitUntil: 'domcontentloaded' });
        const settleMs = Number(process.env.VOICE_CHROME_SETTLE_MS ?? DEFAULT_SETTLE_MS);
        if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
      } catch (err) {
        throw new ChromeMgrError('page_failed', `ensureLoaded failed: ${(err as Error).message}`, err);
      } finally {
        try { await page.close(); } catch { /* best-effort — this is a throwaway priming page */ }
      }
    },

    async openVoicePage(voiceUrl: string, bridgeUrl: string): Promise<VoicePage> {
      const b = await getBrowser();
      let page: any;
      try {
        page = await b.newPage();
      } catch (err) {
        throw new ChromeMgrError('page_failed', `openVoicePage: newPage failed: ${(err as Error).message}`, err);
      }
      try {
        // Registered BEFORE navigation so it fires before ANY of the page's own scripts on the
        // upcoming document. The relay asset reads window.__VOICE_URL__/__BRIDGE_URL__
        // synchronously the instant it's injected (see assets/claude-ws-relay.js) — if these
        // globals were set after injection instead, the asset would throw new WebSocket(undefined).
        await page.evaluateOnNewDocument((v: string, br: string) => {
          // Runs inside the page (browser globalThis === window there); this file's tsconfig
          // has no DOM lib, so globalThis (not window) is what type-checks here in Node.
          (globalThis as any).__VOICE_URL__ = v;
          (globalThis as any).__BRIDGE_URL__ = br;
        }, voiceUrl, bridgeUrl);
        await page.goto(CLAUDE_AI_URL, { waitUntil: 'domcontentloaded' });
        await page.evaluate(loadRelayAssetSource());
      } catch (err) {
        try { await page.close(); } catch { /* noop */ }
        throw err instanceof ChromeMgrError ? err : new ChromeMgrError('page_failed', `openVoicePage failed: ${(err as Error).message}`, err);
      }
      lastOpenAt = Date.now();
      return page as VoicePage;
    },

    async teardownIfIdle(): Promise<void> {
      if (!browser) return;
      const idleMs = Number(process.env.VOICE_CHROME_IDLE_MS ?? DEFAULT_IDLE_MS);
      if (Date.now() - lastOpenAt < idleMs) return;
      const b = browser;
      browser = null;
      console.log('[voice-chrome] idle teardown — closing browser');
      try { await b.close(); } catch { /* best-effort */ }
    },
  };
}
