/**
 * YouTube CDP provider — THE single import surface for the YouTube connector.
 *
 * Drives a youtube.com session over the Chrome DevTools Protocol. The companion
 * login.ts launches a dedicated persistent-profile Chrome at youtube.com on port
 * 9225 (config.resolveCdpBase()). Unlike Gmail/LinkedIn, the reads here are
 * PUBLIC — listing a channel's videos and fetching a video transcript do NOT need
 * a signed-in account — but the driver browser must be RUNNING on this node.
 *
 * ── Modelled on the Gmail connector's browser bridge (deliberately) ──────────
 * This file reuses the disciplines that made the Gmail connector reliable, every
 * one of them measured into existence there:
 *   1. BOUNDED bridge. Every CDP request is time-boxed (a wedged renderer accepts
 *      the socket and answers nothing; unbounded, one wedged tab hangs the whole
 *      connector forever, surviving a Core restart). connect() bounds each call.
 *   2. SELF-HEALING openSession. A 3-rung ladder — prove the page answers →
 *      recycle the tab → relaunch the browser — so a dead renderer recovers
 *      itself instead of erroring on every call.
 *   3. ONE WRITER per tab. There is a single browser tab; on-demand reads and the
 *      keep-alive all steer it. withDriverLock serialises them so one never
 *      navigates out from under another (the shared-tab-two-writers bug).
 *   4. NO SPA RENDER — parse the JSON YouTube embeds in every page
 *      (`ytInitialData`, `ytInitialPlayerResponse`) instead of scraping a rendered
 *      DOM. A `fetch(url)` returns EXACTLY that url's bytes, so the SPA soft-nav
 *      "did the RIGHT page render" trap Gmail hit cannot occur here — there is
 *      nothing to verify. When the browser IS used, its tab stays parked on a
 *      LIGHT page (robots.txt): rendering the SPA headless wedges the renderer.
 *   5. DUAL-PATH fetch, node first (see fetchPageText). The public pages need no
 *      cookies, and on at least one real host every Chrome — headed or headless —
 *      is blocked from youtube.com by the network path while a plain node fetch
 *      succeeds. The browser's in-page fetch (cookies attached — the Gmail
 *      `view=om` lesson) remains the authenticated fallback for age-gated
 *      content and consent-walled regions.
 *
 * Because it reads embedded JSON rather than scraping the DOM, there are no page
 * selectors to maintain — the parsers below work off `ytInitialData` /
 * `ytInitialPlayerResponse`, the same data the page itself renders from.
 */

import WebSocket from 'ws';
import { resolveCdpBase, VIEWPORT } from './config';
import { youtubeProfileExists } from './login';

const log = (...a: unknown[]) => console.error('[yt-cdp]', ...a);

export class YtError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'YtError';
    this.code = code;
  }
}

/** Normalise anything thrown into a YtError so routes' `fail()` reads `e.code`. */
export function toYtError(e: unknown): YtError {
  if (e instanceof YtError) return e;
  const anyE = e as { code?: unknown; message?: unknown } | null;
  const message = e instanceof Error ? e.message : String(e);
  if (anyE && typeof anyE.code === 'string' && anyE.code) return new YtError(anyE.code, message);
  return new YtError('YOUTUBE_ERROR', message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── surface URLs ────────────────────────────────────────────────────────────

const ORIGIN = 'https://www.youtube.com';
/**
 * A DELIBERATELY LIGHT same-origin anchor page.
 *
 * 🔴 MEASURED 2026-08-05 on a headless=new VM: navigating the driver tab into the
 * heavy YouTube SPA (the home feed, a channel /videos grid, or a /watch page)
 * WEDGES the renderer — it accepts the debugger socket and then answers NOTHING,
 * so every CDP command times out (Runtime.enable included). That is the same
 * "wedged renderer" failure the Gmail connector documents, and headless is the
 * only mode most prod nodes have.
 *
 * So this connector does NOT render the SPA. It parks the tab on robots.txt — a
 * tiny text/plain document that renders instantly and never wedges — and reads all
 * data with an in-page `fetch()` of the target URL, parsing the JSON YouTube
 * already embeds in every page (`ytInitialData`, `ytInitialPlayerResponse`). A
 * fetch is a network op, not a render op: it cannot wedge the compositor, it works
 * headless, and — unlike a soft-nav — `fetch(url)` returns EXACTLY that url's
 * bytes, so the "did the RIGHT page render" verification problem disappears. This
 * is the Gmail `view=om` lesson (read the raw data in-page) applied wholesale.
 */
const ANCHOR_URL = `${ORIGIN}/robots.txt`;

/**
 * Extract the first balanced `{…}` object that follows `marker` in `html`.
 * Brace-balanced (string- and escape-aware) because YouTube's embedded JSON is
 * deeply nested and a regex cannot match balanced braces. Returns the parsed
 * object, or null if the marker/object is absent or unparseable.
 */
function extractEmbeddedJson(html: string, markers: string[]): unknown | null {
  for (const marker of markers) {
    const at = html.indexOf(marker);
    if (at < 0) continue;
    const start = html.indexOf('{', at);
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let quote = '';
    for (let j = start; j < html.length; j++) {
      const c = html[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") {
        inStr = true;
        quote = c;
      } else if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, j + 1));
          } catch {
            break; // try the next marker
          }
        }
      }
    }
  }
  return null;
}

/** Pull the text out of a YouTube "text" object ({simpleText} or {runs:[{text}]}). */
function ytText(o: unknown): string {
  const t = o as { simpleText?: unknown; runs?: Array<{ text?: unknown }> } | null | undefined;
  if (!t) return '';
  if (typeof t.simpleText === 'string') return t.simpleText;
  if (Array.isArray(t.runs)) return t.runs.map((r) => (typeof r?.text === 'string' ? r.text : '')).join('');
  return '';
}

// This connector reads DATA, not the DOM: it fetches each target URL in-page and
// parses the JSON YouTube embeds (`ytInitialData`, `ytInitialPlayerResponse`), so
// there are no page selectors to keep in sync — see ANCHOR_URL above.

// ─── CDP session plumbing (bounded — the Gmail bridge discipline) ─────────────

/** Find the youtube.com page target; return a ws URL host-matched to base. */
async function findPageWs(base: string): Promise<string> {
  let list: unknown;
  try {
    const res = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(8000) });
    list = await res.json();
  } catch (e) {
    throw new YtError(
      'BROWSER_NOT_RUNNING',
      `no Chrome is listening on ${base} — the YouTube driver browser is not running on THIS node. ` +
        'YouTube readiness is per-NODE: the driver browser lives on one machine and does not travel with the code, ' +
        'so a node can advertise every youtube_* tool and still be unable to read. ' +
        'Start it here with youtube_login (POST /youtube/login) — reads do NOT need a sign-in, only a running browser — ' +
        'or another node may have one already: check youtube_status on each node from list_nodes. ' +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const pages = (Array.isArray(list) ? list : []).filter(
    (t: { type?: string; url?: string }) => t.type === 'page',
  ) as Array<{ url?: string; webSocketDebuggerUrl?: string }>;
  // 🔴 PREFER the light robots.txt tab. A heavy youtube SPA tab (a session-restored
  // home page) wedges headless and would be picked over the light one by a naive
  // "first youtube tab" rule — then every op hangs. Order: the light anchor, then
  // any non-SPA youtube tab, then any page.
  const page =
    pages.find((t) => /\/robots\.txt/.test(t.url || '')) ||
    pages.find((t) => /youtube\.com/.test(t.url || '') && !/youtube\.com\/(watch|@|channel|results|feed|shorts|$)/.test((t.url || '').replace(/\?.*$/, ''))) ||
    pages.find((t) => /youtube\.com/.test(t.url || '')) ||
    pages[0];
  if (!page || !page.webSocketDebuggerUrl) {
    throw new YtError('PAGE_NOT_FOUND', 'no driveable page found on this CDP endpoint (is the YouTube driver browser running?)');
  }
  const baseHost = new URL(base).host;
  return String(page.webSocketDebuggerUrl).replace(/^ws:\/\/[^/]+/, `ws://${baseHost}`);
}

interface Cdp {
  evaluate<T = unknown>(expr: string): Promise<T>;
  navigate(url: string): Promise<void>;
  /** Trusted mouse click at viewport coords (consent buttons ignore synthetic clicks). */
  click(x: number, y: number): Promise<void>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

function connect(wsUrl: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    const to = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      reject(new YtError('CDP_UNREACHABLE', 'CDP websocket connect timeout'));
    }, 8000);
    let id = 0;
    const pending = new Map<number, { res: (v: unknown) => void; rej: (e: unknown) => void }>();
    ws.on('message', (buf: WebSocket.RawData) => {
      let m: { id?: number; error?: unknown; result?: unknown };
      try {
        m = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id)!;
        pending.delete(m.id);
        if (m.error) rej(new YtError('CDP_ERROR', JSON.stringify(m.error)));
        else res(m.result);
      }
    });
    ws.on('error', (e: Error) => {
      clearTimeout(to);
      reject(new YtError('CDP_UNREACHABLE', String(e.message || e)));
    });
    ws.on('open', () => {
      clearTimeout(to);
      // Bounded per-request: a wedged renderer accepts the socket and never
      // answers. Unbounded, a single wedged tab hangs the whole connector. 45s is
      // generous — a transcript fetch legitimately awaits a network round trip
      // inside one evaluate.
      const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
        new Promise((res, rej) => {
          const mid = ++id;
          const timer = setTimeout(() => {
            if (!pending.has(mid)) return;
            pending.delete(mid);
            rej(new YtError('CDP_TIMEOUT', `${method} did not answer within 45s — the page is not responding`));
          }, 45000);
          pending.set(mid, {
            res: (v: unknown) => {
              clearTimeout(timer);
              res(v);
            },
            rej: (e: unknown) => {
              clearTimeout(timer);
              rej(e);
            },
          });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      const cdp: Cdp = {
        async evaluate<T = unknown>(expr: string): Promise<T> {
          // A navigation can destroy the execution context mid-evaluate; that is
          // transient — retry once after letting the new context settle.
          let lastErr: unknown;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const r = (await send('Runtime.evaluate', {
                expression: `(async()=>{${expr}})()`,
                awaitPromise: true,
                returnByValue: true,
              })) as { exceptionDetails?: { exception?: { description?: string } }; result?: { value?: T } };
              if (r.exceptionDetails) {
                throw new YtError('PAGE_EVAL_ERROR', r.exceptionDetails.exception?.description || 'page eval error');
              }
              return r.result?.value as T;
            } catch (e) {
              lastErr = e;
              const msg = e instanceof Error ? e.message : String(e);
              if (attempt === 0 && /collected|context was destroyed|Cannot find context|Execution context/i.test(msg)) {
                await sleep(600);
                continue;
              }
              throw e;
            }
          }
          throw lastErr;
        },
        async navigate(url: string) {
          await send('Page.navigate', { url });
        },
        async click(x: number, y: number) {
          const b = { x, y, button: 'left', clickCount: 1 };
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...b });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...b });
        },
        send(method: string, params: Record<string, unknown> = {}) {
          return send(method, params);
        },
        close() {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      };
      Promise.all([
        // First request on a new socket: a slow answer here means a wedged
        // renderer, not a busy one, so bound it tighter than the 45s work ceiling.
        Promise.race([
          send('Runtime.enable'),
          sleep(9000).then(() => {
            throw new YtError('CDP_TIMEOUT', 'Runtime.enable did not answer within 9s — the page is not responding');
          }),
        ]),
        send('Page.enable').catch(() => undefined),
        // A desktop viewport so YouTube renders the grid channel layout, not a
        // narrow/mobile fallback with different selectors.
        send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT }).catch(() => undefined),
      ])
        .then(() => resolve(cdp))
        .catch(reject);
    });
  });
}

// ─── self-healing session (the Gmail 3-rung recovery ladder) ─────────────────

/** Is the page's JS thread actually alive (a wedged renderer never answers)? */
async function pageResponds(cdp: Cdp, timeoutMs = 8000): Promise<boolean> {
  return await Promise.race([
    cdp.evaluate<number>('return 1;').then((v) => v === 1).catch(() => false),
    sleep(timeoutMs).then(() => false),
  ]);
}

/** Connect and prove the page answers; null if the renderer is wedged/dead. */
async function openLiveSession(base: string): Promise<Cdp | null> {
  let cdp: Cdp;
  try {
    cdp = await connect(await findPageWs(base));
  } catch {
    return null;
  }
  if (await pageResponds(cdp)) return cdp;
  try {
    cdp.close();
  } catch {
    /* the socket to a dead renderer may already be unusable */
  }
  return null;
}

/** Close the wedged youtube tab and open a fresh one (the profile survives). */
async function recycleYoutubeTab(base: string): Promise<void> {
  let list: Array<{ id: string; type: string; url?: string }>;
  try {
    list = (await fetch(base + '/json/list', { signal: AbortSignal.timeout(8000) }).then((r) => r.json())) as Array<{
      id: string;
      type: string;
      url?: string;
    }>;
  } catch {
    // Nothing is listening — a missing browser is an ordinary, expected state.
    throw new YtError(
      'BROWSER_NOT_RUNNING',
      `no Chrome is listening on ${base} — the YouTube driver browser is not running on THIS node. ` +
        'Start it here with youtube_login (reads do not need a sign-in, only a running browser), ' +
        'or check youtube_status on each node from list_nodes.',
    );
  }
  // 🔴 Open the fresh LIGHT tab FIRST, then close the old ones. Closing the last
  // tab makes headless Chrome EXIT (measured — the next call then hit
  // BROWSER_NOT_RUNNING); opening first keeps the browser at ≥1 tab throughout.
  // Never reopen the heavy SPA home — it would just re-wedge the fresh tab.
  const oldPageIds = list.filter((t) => t.type === 'page').map((t) => t.id);
  const target = base + '/json/new?' + encodeURIComponent(ANCHOR_URL);
  await fetch(target, { method: 'PUT' })
    .catch(() => fetch(target))
    .catch(() => undefined);
  await sleep(3000);
  for (const id of oldPageIds) {
    await fetch(base + '/json/close/' + id).catch(() => undefined);
  }
  await sleep(500);
}

/**
 * Last rung: restart the browser itself. RATE LIMITED (one relaunch per cooldown,
 * process-wide) so a browser that cannot start does not spawn Chrome as fast as
 * calls arrive. Only when a driver profile already exists on disk — relaunching a
 * profile nobody created would park an unwanted Chrome on youtube.com.
 */
const RELAUNCH_COOLDOWN_MS = 60_000;
let lastRelaunchAt = 0;

async function relaunchBrowser(): Promise<boolean> {
  const since = Date.now() - lastRelaunchAt;
  if (since < RELAUNCH_COOLDOWN_MS) return false;
  if (!youtubeProfileExists()) return false;
  lastRelaunchAt = Date.now();
  try {
    // Lazy import: login.ts pulls in the browser launcher, and a static import
    // here would make cdp-client -> login -> cdp-client circular.
    const { youtubeLogin } = await import('./login');
    // Auto-relaunch HEADLESS — the connector's operating mode, and the only mode
    // that works on a prod node with no display (a headed default would fail there
    // with no DISPLAY, exactly as it did on 117 for Gmail).
    const r = (await youtubeLogin({ headless: true })) as { ok?: boolean };
    if (r?.ok !== true) return false;
    log('browser was unreachable — relaunched it automatically');
    return true;
  } catch {
    return false;
  }
}

async function openSession(): Promise<{ cdp: Cdp; close(): void }> {
  const base = resolveCdpBase();

  const first = await openLiveSession(base);
  if (first) return { cdp: first, close: () => first.close() };

  // Rung 2: recycle the tab (throws BROWSER_NOT_RUNNING when nothing listens —
  // a relaunchable condition, so it must not escape before rung 3 has a turn).
  let recycleErr: unknown = null;
  try {
    await recycleYoutubeTab(base);
  } catch (e) {
    recycleErr = e;
  }
  let cdp = recycleErr ? null : await openLiveSession(base);

  // Rung 3: restart the browser.
  if (!cdp && (await relaunchBrowser())) {
    await sleep(2500);
    cdp = await openLiveSession(base);
  }
  if (!cdp && recycleErr) throw recycleErr;
  if (!cdp) {
    throw new YtError(
      'BROWSER_UNRESPONSIVE',
      'the YouTube page is not responding to CDP even after the tab was recycled — the browser itself needs restarting (youtube_login relaunches it).',
    );
  }
  const live = cdp;
  return { cdp: live, close: () => live.close() };
}

// ─── ONE driver at a time (the shared-tab single-writer rule) ─────────────────
//
// There is a single browser tab and several things that steer it: on-demand tool
// calls and the keep-alive. Uncoordinated, they navigate out from under each
// other and one caller's page is returned to another. Every session is serialised
// here. BOUNDED, always — an unbounded queue behind a wedged holder is how a
// connector hangs forever instead of failing; a waiter that times out throws with
// the age of the current holder, which names the culprit.
let driverChain: Promise<unknown> = Promise.resolve();
let driverHeldSince: number | null = null;
const DRIVER_WAIT_MS = 120_000;

async function withDriverLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    // Stamp the holder around the ACTUAL work, never around the wait, so a
    // refusal names WHEN the holder acquired — not when a waiter arrived.
    driverHeldSince = Date.now();
    try {
      return await fn();
    } finally {
      driverHeldSince = null;
    }
  };
  const mine = driverChain.then(run, run);
  // Keep the chain alive regardless of this call's outcome, or one rejection
  // would poison every future acquisition.
  driverChain = mine.then(
    () => undefined,
    () => undefined,
  );
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => {
      const since = driverHeldSince;
      const age = since ? Math.round((Date.now() - since) / 1000) : null;
      rej(
        new YtError(
          'BROWSER_BUSY',
          (age === null
            ? 'another YouTube operation is holding the browser'
            : `another YouTube operation has held the browser for ${age}s`) +
            ' — refusing to queue indefinitely. Retry shortly.',
        ),
      );
    }, DRIVER_WAIT_MS).unref?.(),
  );
  return (await Promise.race([mine, timeout])) as T;
}

async function withCdp<T>(fn: (cdp: Cdp) => Promise<T>): Promise<T> {
  return withDriverLock(async () => {
    const s = await openSession();
    try {
      return await fn(s.cdp);
    } finally {
      s.close();
    }
  });
}

// ─── navigation + verification helpers ───────────────────────────────────────

/** Poll a boolean page expression until true or the deadline. */
async function waitFor(cdp: Cdp, boolExpr: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let ok = false;
    try {
      ok = !!(await cdp.evaluate<boolean>(`return ${boolExpr};`));
    } catch {
      /* transient during navigation */
    }
    if (ok) return true;
    await sleep(400);
  }
  return false;
}

/**
 * YouTube shows a consent interstitial (consent.youtube.com / a "Before you
 * continue" dialog) to a fresh, signed-out EU profile. Best-effort dismiss:
 * click an "Accept all" / "Reject all" button so navigation can proceed. The
 * consent buttons are real form buttons and DO respond to an in-page click here
 * (unlike Gmail's toolbars), but we also fall back to a trusted CDP click.
 */
async function dismissConsentIfPresent(cdp: Cdp): Promise<boolean> {
  const onConsent = await cdp
    .evaluate<boolean>(`return /consent\\.youtube\\.com|consent\\.google\\.com/.test(location.hostname) || !!document.querySelector('form[action*="consent"]');`)
    .catch(() => false);
  if (!onConsent) return false;
  const clicked = await cdp
    .evaluate<{ ok: boolean; x?: number; y?: number }>(`
      const btns = [...document.querySelectorAll('button, [role="button"], form[action*="consent"] button')];
      const want = /^(accept all|reject all|i agree|accept|agree)$/i;
      const b = btns.find((x) => want.test((x.textContent || '').replace(/\\s+/g, ' ').trim()));
      if (!b) return { ok: false };
      const r = b.getBoundingClientRect();
      b.click();
      return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `)
    .catch(() => ({ ok: false }) as { ok: boolean; x?: number; y?: number });
  if (clicked && clicked.ok && typeof clicked.x === 'number' && typeof clicked.y === 'number') {
    // Reinforce with a trusted click in case the synthetic one was ignored.
    await cdp.click(clicked.x, clicked.y).catch(() => undefined);
    await sleep(2000);
    return true;
  }
  return false;
}

/**
 * Park the tab on the LIGHT same-origin anchor (robots.txt) so an in-page fetch
 * runs with the profile's cookies but the heavy SPA never renders (and so never
 * wedges the headless renderer). Only navigates when not already parked there —
 * we never yank the operator off a video they are watching without cause. Also
 * sets a best-effort consent cookie so a fresh EU/unknown-region profile is not
 * bounced to consent.youtube.com when it fetches.
 */
async function ensureAnchor(cdp: Cdp): Promise<void> {
  const parked = await cdp
    .evaluate<boolean>(`return /(^|\\.)youtube\\.com$/.test(location.hostname) && !location.hostname.startsWith('consent.') && /robots\\.txt$/.test(location.pathname);`)
    .catch(() => false);
  if (!parked) {
    await cdp.navigate(ANCHOR_URL);
    await sleep(600);
    await waitFor(cdp, `document.readyState === 'interactive' || document.readyState === 'complete'`, 15000);
    if (await dismissConsentIfPresent(cdp)) {
      await cdp.navigate(ANCHOR_URL);
      await sleep(600);
    }
  }
  // Best-effort consent cookie (harmless when already consented / not needed).
  await cdp
    .evaluate(`try { if (!/CONSENT=/.test(document.cookie)) document.cookie = 'CONSENT=YES+; domain=.youtube.com; path=/; max-age=63072000'; } catch (e) {} return true;`)
    .catch(() => undefined);
}

/**
 * Fetch a same-origin YouTube URL's body IN THE PAGE (cookies attached), returning
 * the text. A node-side fetch of the same URL can come back empty or consent-
 * gated; the in-page fetch carries the session. Throws FETCH_FAILED on a non-2xx.
 */
async function fetchText(cdp: Cdp, url: string): Promise<string> {
  const r = await cdp.evaluate<{ status: number; body: string; finalUrl: string }>(`
    try {
      const res = await fetch(${JSON.stringify(url)}, { credentials: 'include', headers: { 'accept': 'text/html,application/json' } });
      const body = await res.text();
      return { status: res.status, body, finalUrl: res.url };
    } catch (e) { return { status: 0, body: '', finalUrl: '' }; }
  `);
  if (!r || r.status === 0) throw new YtError('FETCH_FAILED', `in-page fetch of ${url} failed (network error / browser not ready)`);
  if (r.status >= 400) throw new YtError('FETCH_FAILED', `in-page fetch of ${url} returned HTTP ${r.status}`);
  if (/consent\.youtube\.com|consent\.google\.com/.test(r.finalUrl || '')) {
    throw new YtError('CONSENT_REQUIRED', `YouTube redirected the fetch to a consent page — sign in once with youtube_login to persist a consent choice on this profile.`);
  }
  return r.body || '';
}

/**
 * The entry sequence every browser-touching read shares: single-writer lock →
 * self-healing session → park on the light anchor → work. No login assert — reads
 * are public; loggedIn is reported by status only.
 */
async function op<T>(fn: (cdp: Cdp) => Promise<T>): Promise<T> {
  try {
    return await withCdp(async (cdp) => {
      await ensureAnchor(cdp);
      return fn(cdp);
    });
  } catch (e) {
    throw toYtError(e);
  }
}

// ─── the dual-path page fetcher (node first, browser fallback) ────────────────

/** A desktop-Chrome UA for the node-side fetch, built from the host platform. */
function nodeUa(): string {
  const platform =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36`;
}

/**
 * Fetch a YouTube URL's body — node-side first, browser in-page as fallback.
 *
 * 🔴 WHY node-side is PRIMARY (measured 2026-08-05 on 123, exhaustively):
 * something on that LAN's path RESETS/blackholes browser-fingerprint TLS to
 * youtube.com — every Chrome (headed, headless, fresh profile, QUIC off, PQ/ECH
 * off, v4-forced) failed to load ANY youtube.com URL, with the navigation never
 * committing and CDP calls to those targets queueing forever, while claude.ai and
 * mail.google.com tabs in the SAME Chromes answered in milliseconds — and a plain
 * node/curl fetch of the SAME youtube URLs returned 200 in ~60ms. The public
 * pages (channel /videos, /watch, timedtext) need no cookies, so the node path is
 * both sufficient and the only one that works there.
 *
 * The BROWSER path remains the authenticated fallback: on a host where Chrome can
 * reach youtube, an in-page fetch carries the signed-in profile's cookies (age-
 * gated videos, a persisted consent choice). It is tried when the node path is
 * consent-walled or fails — and its errors are the ones reported then.
 */
async function fetchPageText(url: string): Promise<{ body: string; via: 'node' | 'browser' }> {
  let nodeErr: unknown = null;
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': nodeUa(), 'accept-language': 'en-US,en;q=0.9', accept: 'text/html,application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
    if (r.ok && !/consent\.(youtube|google)\.com/.test(r.url || '')) {
      return { body: await r.text(), via: 'node' };
    }
    nodeErr = new YtError('FETCH_FAILED', `node-side fetch of ${url} ${r.ok ? 'was consent-redirected' : `returned HTTP ${r.status}`}`);
  } catch (e) {
    nodeErr = e;
  }
  // Fallback: in-page fetch through the driver browser (cookies attached).
  try {
    const body = await op((cdp) => fetchText(cdp, url));
    return { body, via: 'browser' };
  } catch (browserErr) {
    // Both paths failed — report the browser error (it names the actionable fix:
    // BROWSER_NOT_RUNNING → youtube_login) with the node failure appended.
    const be = toYtError(browserErr);
    const nmsg = nodeErr instanceof Error ? nodeErr.message : String(nodeErr);
    throw new YtError(be.code, `${be.message} (direct fetch also failed: ${nmsg.slice(0, 140)})`);
  }
}

// ─── node-side parsers (pure — unit-tested directly against fixtures) ─────────

/** Pull the duration label out of a renderer's thumbnailOverlays[]. */
function durationFromOverlays(overlays: unknown): string {
  if (!Array.isArray(overlays)) return '';
  for (const ov of overlays) {
    const t = (ov as { thumbnailOverlayTimeStatusRenderer?: { text?: unknown } })?.thumbnailOverlayTimeStatusRenderer;
    if (t) {
      const s = ytText(t.text);
      if (s) return s.replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

/**
 * Parse one 2026-layout `lockupViewModel` into a ChannelVideo, or null when it is
 * not a video lockup. MEASURED 2026-08-05 against a live channel /videos page —
 * the shape (verified field by field):
 *   - videoId    → `contentId` (with contentType LOCKUP_CONTENT_TYPE_VIDEO)
 *   - title      → `metadata.lockupMetadataViewModel.title.content` (plain string)
 *   - views/date → …`.metadata.contentMetadataViewModel.metadataRows[].metadataParts[].text.content`
 *                  ("188K views" · "3 weeks ago")
 *   - duration   → `contentImage.thumbnailViewModel.overlays[]
 *                    .thumbnailBottomOverlayViewModel.badges[].thumbnailBadgeViewModel.text` ("3:33")
 */
function lockupToVideo(lv: Record<string, unknown>): ChannelVideo | null {
  const id = lv.contentId;
  if (typeof id !== 'string' || !/^[\w-]{11}$/.test(id)) return null;
  if (lv.contentType !== undefined && lv.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null;
  const md = (lv.metadata as { lockupMetadataViewModel?: Record<string, unknown> } | undefined)?.lockupMetadataViewModel;
  const title = String((md?.title as { content?: unknown } | undefined)?.content ?? '').replace(/\s+/g, ' ').trim();
  if (!title) return null;

  // views + published from the metadata rows' text parts.
  let views = '';
  let published = '';
  const rows = ((md?.metadata as { contentMetadataViewModel?: { metadataRows?: unknown } } | undefined)
    ?.contentMetadataViewModel?.metadataRows ?? []) as Array<{ metadataParts?: Array<{ text?: { content?: unknown } }> }>;
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const part of row.metadataParts ?? []) {
      const t = String(part?.text?.content ?? '').trim();
      if (!t) continue;
      if (!views && /view/i.test(t)) views = t;
      else if (!published && /ago|Streamed|Premier|Scheduled|\d{4}/i.test(t)) published = t;
    }
  }

  // duration from the bottom-overlay badge text (e.g. "3:33", "1:02:11").
  let duration = '';
  const overlays = ((lv.contentImage as { thumbnailViewModel?: { overlays?: unknown } } | undefined)
    ?.thumbnailViewModel?.overlays ?? []) as Array<{ thumbnailBottomOverlayViewModel?: { badges?: Array<{ thumbnailBadgeViewModel?: { text?: unknown } }> } }>;
  for (const ov of Array.isArray(overlays) ? overlays : []) {
    for (const b of ov?.thumbnailBottomOverlayViewModel?.badges ?? []) {
      const t = String(b?.thumbnailBadgeViewModel?.text ?? '').trim();
      if (/^\d+(:\d{2})+$/.test(t)) {
        duration = t;
        break;
      }
    }
    if (duration) break;
  }

  return { videoId: id, title, url: `${ORIGIN}/watch?v=${id}`, views, published, duration };
}

/**
 * Deep-scan a parsed `ytInitialData` for video entries and return them in
 * document order (newest first on a channel /videos page). Two shapes are
 * recognised, without hard-coding YouTube's exact nesting (which shifts between
 * layouts):
 *   - the CLASSIC renderers — any object carrying `videoId` + a `title` text
 *     object (videoRenderer / gridVideoRenderer / richItem→videoRenderer);
 *   - the 2026 `lockupViewModel` (see lockupToVideo) — the current channel
 *     /videos layout, whose videoId lives in `contentId`.
 * Deduped by videoId, capped at `limit`.
 */
export function collectChannelVideos(ytInitialData: unknown, limit: number): ChannelVideo[] {
  const out: ChannelVideo[] = [];
  const seen = new Set<string>();
  const push = (v: ChannelVideo | null): void => {
    if (v && !seen.has(v.videoId)) {
      seen.add(v.videoId);
      out.push(v);
    }
  };
  const visit = (node: unknown): void => {
    if (out.length >= limit) return;
    if (Array.isArray(node)) {
      for (const x of node) {
        visit(x);
        if (out.length >= limit) return;
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;

    // 2026 layout: a lockup view model (videoId in contentId).
    if (o.lockupViewModel && typeof o.lockupViewModel === 'object') {
      const v = lockupToVideo(o.lockupViewModel as Record<string, unknown>);
      if (v) {
        push(v);
        return; // parsed — do not descend into the lockup's own children
      }
    }

    // Classic renderers: videoId + title text object on the same node.
    const id = o.videoId;
    const title = o.title as { runs?: unknown; simpleText?: unknown } | undefined;
    if (typeof id === 'string' && /^[\w-]{11}$/.test(id) && title && (title.runs || title.simpleText)) {
      push({
        videoId: id,
        title: ytText(o.title).replace(/\s+/g, ' ').trim(),
        url: `${ORIGIN}/watch?v=${id}`,
        views: (ytText(o.viewCountText) || ytText(o.shortViewCountText)).replace(/\s+/g, ' ').trim(),
        published: ytText(o.publishedTimeText).replace(/\s+/g, ' ').trim(),
        duration: (ytText(o.lengthText) || durationFromOverlays(o.thumbnailOverlays)).replace(/\s+/g, ' ').trim(),
      });
      return; // matched — do not descend into a video node's own children
    }
    for (const k of Object.keys(o)) {
      visit(o[k]);
      if (out.length >= limit) return;
    }
  };
  visit(ytInitialData);
  return out;
}

/** The channel's display name from a parsed `ytInitialData`. */
export function channelNameFromData(ytInitialData: unknown): string | null {
  let found: string | null = null;
  const visit = (node: unknown): void => {
    if (found || !node) return;
    if (Array.isArray(node)) {
      for (const x of node) {
        visit(x);
        if (found) return;
      }
      return;
    }
    if (typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    const meta = o.channelMetadataRenderer as { title?: unknown } | undefined;
    if (meta && typeof meta.title === 'string' && meta.title.trim()) {
      found = meta.title.trim();
      return;
    }
    for (const k of Object.keys(o)) {
      visit(o[k]);
      if (found) return;
    }
  };
  visit(ytInitialData);
  return found;
}

/** The first channel's canonical path ("/@handle" or "/channel/UC…") in a parsed
 *  search-results `ytInitialData`, for resolving a name → channel. */
export function firstChannelPathFromSearch(ytInitialData: unknown): string | null {
  let path: string | null = null;
  const visit = (node: unknown): void => {
    if (path || !node) return;
    if (Array.isArray(node)) {
      for (const x of node) {
        visit(x);
        if (path) return;
      }
      return;
    }
    if (typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    const cr = o.channelRenderer as { navigationEndpoint?: unknown } | undefined;
    if (cr) {
      const nav = cr.navigationEndpoint as
        | { browseEndpoint?: { canonicalBaseUrl?: unknown }; commandMetadata?: { webCommandMetadata?: { url?: unknown } } }
        | undefined;
      const url = nav?.browseEndpoint?.canonicalBaseUrl ?? nav?.commandMetadata?.webCommandMetadata?.url;
      if (typeof url === 'string' && url) {
        path = url;
        return;
      }
    }
    for (const k of Object.keys(o)) {
      visit(o[k]);
      if (path) return;
    }
  };
  visit(ytInitialData);
  return path;
}

// ─── status ──────────────────────────────────────────────────────────────────

export interface CdpStatus {
  loggedIn: boolean;
  self: string | null;
}

/** True if the fetched YouTube home HTML carries the signed-in flag. */
function loggedInFromHtml(html: string): boolean {
  return /"LOGGED_IN"\s*:\s*true/.test(html) || /\\"LOGGED_IN\\":true/.test(html);
}

/** CDP reachability + (best-effort) signed-in state, via an in-page fetch of the
 *  home HTML (no heavy SPA render). Never navigates the operator off a video. */
export async function cdpStatus(): Promise<CdpStatus> {
  return withCdp(async (cdp) => {
    await ensureAnchor(cdp).catch(() => undefined);
    let loggedIn = false;
    try {
      const html = await fetchText(cdp, `${ORIGIN}/`);
      loggedIn = loggedInFromHtml(html);
    } catch {
      /* reachable enough to have parked on the anchor; report signed-out */
    }
    return { loggedIn, self: null };
  });
}

// ─── channel resolution ──────────────────────────────────────────────────────

/**
 * Turn a caller's channel reference into a canonical `.../videos` URL:
 *   - a channel id `UC…`              → /channel/UC…/videos
 *   - a full channel/@handle/user URL → append /videos
 *   - a bare `@handle` or handle      → /@handle/videos
 * Anything else is a SEARCH, resolved by fetching the search HTML and taking the
 * first channel result.
 */
async function resolveChannelVideosUrl(input: string): Promise<string> {
  const raw = String(input || '').trim();
  if (!raw) throw new YtError('BAD_REQUEST', 'a channel handle, URL, id, or name is required');

  const videosPath = (p: string): string => (/\/videos\/?$/.test(p) ? p : p.replace(/\/+$/, '') + '/videos');

  const urlMatch = raw.match(/^https?:\/\/(?:www\.)?youtube\.com(\/(?:channel\/[^/?#]+|@[^/?#]+|c\/[^/?#]+|user\/[^/?#]+))/i);
  if (urlMatch) return `${ORIGIN}${videosPath(urlMatch[1])}`;
  if (/^UC[0-9A-Za-z_-]{20,}$/.test(raw)) return `${ORIGIN}/channel/${raw}/videos`;
  if (/^@[\w.-]+$/.test(raw)) return `${ORIGIN}/${raw}/videos`;
  if (/^[\w.-]+$/.test(raw) && !raw.includes(' ')) return `${ORIGIN}/@${raw}/videos`;

  // A free-text name → search (channel filter sp=EgIQAg%3D%3D) → first channel.
  const { body: html } = await fetchPageText(`${ORIGIN}/results?search_query=${encodeURIComponent(raw)}&sp=EgIQAg%253D%253D`);
  const data = extractEmbeddedJson(html, ['var ytInitialData = ', 'ytInitialData = ', 'window["ytInitialData"] = ']);
  const path = firstChannelPathFromSearch(data);
  if (!path) throw new YtError('CHANNEL_NOT_FOUND', `no channel found for "${raw}"`);
  return `${ORIGIN}${videosPath(path)}`;
}

// ─── channel video list ──────────────────────────────────────────────────────

export interface ChannelVideo {
  videoId: string;
  title: string;
  url: string;
  views: string;
  published: string;
  duration: string;
}

export interface ChannelVideosResult {
  channel: string | null;
  channelUrl: string;
  count: number;
  /** True when the parse hit `limit` and older videos exist beyond it. */
  hitLimit: boolean;
  videos: ChannelVideo[];
}

/**
 * List a channel's most-recent videos (newest first). Resolves `channel`, fetches
 * the /videos page HTML (node-side first, browser fallback — see fetchPageText),
 * and parses the embedded `ytInitialData` — no SPA render ever. `fetch(url)`
 * returns exactly that url's bytes, so there is no soft-nav "wrong page"
 * ambiguity to guard against.
 */
export async function listChannelVideos(channel: string, limit = 30): Promise<ChannelVideosResult> {
  const want = Math.max(1, Math.min(200, limit));
  const url = await resolveChannelVideosUrl(channel);
  const { body: html } = await fetchPageText(url);
  const data = extractEmbeddedJson(html, ['var ytInitialData = ', 'ytInitialData = ', 'window["ytInitialData"] = ']);
  if (!data) {
    throw new YtError('CHANNEL_PARSE_FAILED', `could not read the video list for "${channel}" — the page had no ytInitialData (a bad handle, a redirect, or a YouTube change).`);
  }
  const videos = collectChannelVideos(data, want);
  return {
    channel: channelNameFromData(data),
    channelUrl: url,
    count: videos.length,
    hitLimit: videos.length >= want,
    videos,
  };
}

// ─── player response (shared by video-info + transcript) ─────────────────────

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    channelId?: string;
    lengthSeconds?: string;
    viewCount?: string;
    shortDescription?: string;
    keywords?: string[];
    isLiveContent?: boolean;
  };
  microformat?: {
    playerMicroformatRenderer?: {
      title?: unknown;
      description?: unknown;
      ownerChannelName?: unknown;
      externalChannelId?: string;
      ownerProfileUrl?: string;
      publishDate?: string;
      uploadDate?: string;
    };
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
    };
  };
}

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
}

/** Parse `ytInitialPlayerResponse` out of a fetched watch-page HTML. */
function extractPlayerResponse(html: string): PlayerResponse | null {
  return extractEmbeddedJson(html, [
    'var ytInitialPlayerResponse = ',
    'ytInitialPlayerResponse = ',
    'window["ytInitialPlayerResponse"] = ',
  ]) as PlayerResponse | null;
}

/**
 * Choose a caption track: an exact/prefix language match if `wantLang` is given,
 * else a human (non-asr) track, else the first. Exported for unit tests.
 */
export function pickCaptionTrack(tracks: CaptionTrack[], wantLang = ''): CaptionTrack | null {
  if (!tracks.length) return null;
  const want = wantLang.toLowerCase();
  const human = (list: CaptionTrack[]): CaptionTrack | undefined => list.find((t) => t.kind !== 'asr');
  if (want) {
    // Within the requested language, prefer a HUMAN track over an auto-generated one.
    const exact = tracks.filter((t) => (t.languageCode || '').toLowerCase() === want);
    if (exact.length) return human(exact) || exact[0];
    const prefix = tracks.filter((t) => (t.languageCode || '').toLowerCase().indexOf(want) === 0);
    if (prefix.length) return human(prefix) || prefix[0];
  }
  return human(tracks) || tracks[0];
}

function trackName(t: CaptionTrack): string {
  return (t.name && (t.name.simpleText || (t.name.runs || []).map((r) => r.text || '').join(''))) || t.languageCode || '';
}

// ─── single video info ───────────────────────────────────────────────────────

export interface VideoInfo {
  videoId: string;
  url: string;
  title: string | null;
  channel: string | null;
  channelId: string | null;
  channelUrl: string | null;
  published: string | null;
  lengthSeconds: number | null;
  views: number | null;
  description: string;
  keywords: string[];
  isLive: boolean;
  hasCaptions: boolean;
}

/** Normalise a player response into VideoInfo. Exported for unit tests. */
export function playerResponseToInfo(pr: PlayerResponse, videoId: string): VideoInfo {
  const vd = pr.videoDetails || {};
  const mf = pr.microformat?.playerMicroformatRenderer || {};
  const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const cid = vd.channelId || mf.externalChannelId || null;
  const id = vd.videoId || videoId;
  return {
    videoId: id,
    url: `${ORIGIN}/watch?v=${id}`,
    title: vd.title || ytText(mf.title) || null,
    channel: vd.author || ytText(mf.ownerChannelName) || null,
    channelId: cid,
    channelUrl: cid ? `${ORIGIN}/channel/${cid}` : mf.ownerProfileUrl || null,
    published: mf.publishDate || mf.uploadDate || null,
    lengthSeconds: vd.lengthSeconds ? Number(vd.lengthSeconds) : null,
    views: vd.viewCount ? Number(vd.viewCount) : null,
    description: (vd.shortDescription || ytText(mf.description) || '').slice(0, 20000),
    keywords: Array.isArray(vd.keywords) ? vd.keywords.slice(0, 40) : [],
    isLive: !!vd.isLiveContent,
    hasCaptions: tracks.length > 0,
  };
}

/**
 * Fetch one video's metadata + description by fetching the watch-page HTML
 * (node-side first, browser fallback) and parsing its ytInitialPlayerResponse.
 * `fetch(url)` returns exactly that video's bytes, so there is no wrong-video
 * ambiguity.
 */
export async function getVideoInfo(video: string): Promise<VideoInfo> {
  const videoId = parseVideoId(video);
  const { body: html } = await fetchPageText(`${ORIGIN}/watch?v=${videoId}`);
  const pr = extractPlayerResponse(html);
  if (!pr) throw new YtError('NO_PLAYER_RESPONSE', `the watch page for ${videoId} exposed no player response — a bad id, a redirect, or a YouTube change.`);
  const status = pr.playabilityStatus?.status;
  if (status && status !== 'OK') {
    throw new YtError('NOT_PLAYABLE', `video ${videoId} is not playable (${status}${pr.playabilityStatus?.reason ? `: ${pr.playabilityStatus.reason}` : ''}) — private, age-gated (sign in with youtube_login), region-blocked, or removed.`);
  }
  return playerResponseToInfo(pr, videoId);
}

// ─── transcript ──────────────────────────────────────────────────────────────

export interface TranscriptSegment {
  /** Start offset in seconds from the video start. */
  start: number;
  /** The caption text for this segment. */
  text: string;
}

export interface TranscriptResult {
  videoId: string;
  title: string | null;
  lengthSeconds: number | null;
  /** BCP-47 language code of the chosen track. */
  lang: string;
  /** Human track name ("English", "English (auto-generated)"). */
  trackName: string;
  /** True when the chosen track is auto-generated (ASR). */
  isAuto: boolean;
  /** Every language code offered, so a caller can re-request a specific one. */
  availableLangs: string[];
  segments: TranscriptSegment[];
}

/** Extract a `watch?v=` id from a URL or accept a bare 11-char id. */
export function parseVideoId(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) throw new YtError('BAD_REQUEST', 'a video URL or id is required');
  if (/^[\w-]{11}$/.test(raw)) return raw;
  const m =
    raw.match(/[?&]v=([\w-]{11})/) ||
    raw.match(/youtu\.be\/([\w-]{11})/) ||
    raw.match(/\/(?:shorts|live|embed)\/([\w-]{11})/);
  if (m) return m[1];
  throw new YtError('BAD_REQUEST', `could not extract a YouTube video id from "${input}"`);
}

/** Decode the numeric + named entities YouTube's srv3 XML uses. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Parse an srv3 timedtext XML (`<timedtext format="3"><p t="ms" d="ms">…</p>`)
 * into transcript segments. ASR tracks nest `<s>` word spans inside each `<p>`;
 * inner tags are stripped and entities decoded. Exported for tests.
 */
export function parseSrv3(xml: string): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const tAttr = /\bt="(\d+)"/.exec(m[1]);
    const text = decodeXmlEntities(m[2].replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    out.push({ start: Math.round(Number(tAttr ? tAttr[1] : 0) / 1000), text });
  }
  return out;
}

/** Parse a json3 timedtext payload into transcript segments. Exported for tests. */
export function parseJson3(payload: unknown): TranscriptSegment[] {
  const events = (payload as { events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }> })?.events || [];
  const out: TranscriptSegment[] = [];
  for (const ev of events) {
    if (!ev.segs) continue;
    const text = ev.segs
      .map((s) => s.utf8 || '')
      .join('')
      .replace(/\n/g, ' ')
      .trim();
    if (!text) continue;
    out.push({ start: Math.round((ev.tStartMs || 0) / 1000), text });
  }
  return out;
}

/**
 * Fetch a video's transcript. Fetches the watch HTML (node-side first, browser
 * fallback), parses its player response for caption tracks, then fetches the
 * chosen track's timedtext (json3) the same dual-path way. The timedtext baseUrl
 * is IP-bound by YouTube — Core and the driver browser share the node's IP, so
 * both paths satisfy it. Parses the segments node-side.
 */
export async function getTranscript(video: string, lang = ''): Promise<TranscriptResult> {
  const videoId = parseVideoId(video);
  const { body: html } = await fetchPageText(`${ORIGIN}/watch?v=${videoId}`);
  const pr = extractPlayerResponse(html);
  if (!pr) throw new YtError('NO_PLAYER_RESPONSE', `the watch page for ${videoId} exposed no player response — a bad id, a redirect, or a YouTube change.`);
  const status = pr.playabilityStatus?.status;
  if (status && status !== 'OK') {
    throw new YtError('NOT_PLAYABLE', `video ${videoId} is not playable (${status}${pr.playabilityStatus?.reason ? `: ${pr.playabilityStatus.reason}` : ''}) — private, age-gated (sign in with youtube_login), region-blocked, or removed.`);
  }
  const vd = pr.videoDetails || {};
  let tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) throw new YtError('NO_CAPTIONS', `video ${videoId} has no captions/transcript available.`);
  let track = pickCaptionTrack(tracks, lang);
  if (!track || !track.baseUrl) throw new YtError('NO_CAPTIONS', `video ${videoId} has no usable caption track.`);

  // 1. The WEB track url (json3). 🔴 MEASURED 2026-08-05: without a browser
  //    proof-of-origin token this endpoint answers HTTP 200 with an EMPTY body —
  //    success-shaped nothing — so an empty result here is expected, not final.
  let segments: TranscriptSegment[] = [];
  try {
    const base = track.baseUrl;
    const url = base.indexOf('fmt=') >= 0 ? base : `${base}&fmt=json3`;
    const { body: raw } = await fetchPageText(url);
    segments = raw.trim().startsWith('<') ? parseSrv3(raw) : parseJson3(JSON.parse(raw));
  } catch {
    /* fall through to the innertube path */
  }

  // 2. Fallback: the innertube ANDROID client's player response. Its caption
  //    urls carry no pot requirement (MEASURED: the same track that returned an
  //    empty body via the web url returned the full srv3 XML via this one).
  if (!segments.length) {
    try {
      const key = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
      if (key) {
        const r = await fetch(`${ORIGIN}/youtubei/v1/player?key=${encodeURIComponent(key)}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
          },
          body: JSON.stringify({
            context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en' } },
            videoId,
          }),
          signal: AbortSignal.timeout(20000),
        });
        const j = (await r.json()) as PlayerResponse;
        const aTracks = j.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        const aTrack = pickCaptionTrack(aTracks, lang || track.languageCode || '');
        if (aTrack?.baseUrl) {
          const raw = await fetch(aTrack.baseUrl, {
            headers: { 'user-agent': nodeUa() },
            signal: AbortSignal.timeout(20000),
          }).then((x) => x.text());
          segments = raw.trim().startsWith('<') ? parseSrv3(raw) : parseJson3(JSON.parse(raw));
          if (segments.length) {
            tracks = aTracks;
            track = aTrack;
          }
        }
      }
    } catch {
      /* fall through to the error below */
    }
  }

  if (!segments.length) throw new YtError('TRANSCRIPT_EMPTY', `video ${videoId} advertises captions but the transcript track came back empty on both the web and android caption endpoints.`);

  return {
    videoId: vd.videoId || videoId,
    title: vd.title || null,
    lengthSeconds: vd.lengthSeconds ? Number(vd.lengthSeconds) : null,
    lang: track.languageCode || '',
    trackName: trackName(track),
    isAuto: track.kind === 'asr',
    availableLangs: tracks.map((t) => t.languageCode || '').filter(Boolean),
    segments,
  };
}

// ─── session keep-alive ───────────────────────────────────────────────────────

/**
 * Keep the driver session warm with ONE in-page authenticated request (cookies
 * attached), non-disruptive (no navigation, no DOM mutation), then report whether
 * the page is still signed in. Safe on a timer. Throws (BROWSER_NOT_RUNNING /
 * PAGE_NOT_FOUND) if the driver browser is not up.
 */
export async function keepSessionWarm(): Promise<{ loggedIn: boolean; warmed: boolean; httpStatus: number }> {
  return withCdp(async (cdp) => {
    const res = await cdp
      .evaluate<{ status: number; body: string }>(`
        try {
          const r = await fetch('https://www.youtube.com/', { credentials: 'include', headers: { 'accept': 'text/html' } });
          const body = await r.text();
          return { status: r.status, body };
        } catch (e) { return { status: 0, body: '' }; }
      `)
      .catch(() => ({ status: 0, body: '' }));
    const httpStatus = res?.status ?? 0;
    return { loggedIn: loggedInFromHtml(res?.body || ''), warmed: httpStatus > 0 && httpStatus < 400, httpStatus };
  });
}

/** Exposed for the selfcheck canary — connect EXACTLY the way the tools connect. */
export async function pageProbe<T>(fn: (cdp: Cdp) => Promise<T>): Promise<T> {
  return op(fn);
}
