/**
 * Gmail CDP provider — THE single import surface for the Gmail connector.
 *
 * Drives a logged-in mail.google.com session over the Chrome DevTools Protocol.
 * The companion login.ts launches a dedicated persistent-profile Chrome at
 * mail.google.com on port 9224 (config.resolveCdpBase()); the user logs in once
 * and the profile keeps the session.
 *
 * ── What this file IS ────────────────────────────────────────────────────────
 * A thin, owned layer over nine specialist modules. It opens/closes the CDP
 * session, enforces the preconditions every operation shares (logged in,
 * desktop UI, rate budget), and delegates the actual work:
 *
 *   ./extractors  page-side read snippets (rows, thread detail, labels, attach)
 *   ./mime        RFC822 parsing + the `view=om` <pre> extractor
 *   ./markdown    markdown -> DOM script (used through ./compose)
 *   ./compose     compose/send/reply/forward/draft, chips, attachments
 *   ./labels      label tree + apply/remove/create/move
 *   ./actions     archive/trash/read/star/spam/mute/important/snooze/bulk
 *   ./safety      idempotency, rate limits, recipient policy, Sent verification
 *   ./store       the local window cache
 *   ./sync        the paginating background walk that fills it
 *
 * Routes and MCP tools import from HERE and nowhere else in ./gmail — except
 * ./store (pure local cache, no browser) and ./login, which are legitimately
 * separate surfaces.
 *
 * ── Why the DOM and not an internal endpoint (MEASURED 2026-07-29) ───────────
 * `/mail/u/0/h/` (basic HTML Gmail) is RETIRED; `?ui=2&ik=<ik>&view=tl&rt=j` no
 * longer returns JSON (it serves the ~1.4 MB SPA shell as text/html); and
 * `/sync/u/0/i/fd` is undocumented binary protobuf. Seeing the SPA call an
 * endpoint is NOT evidence a third party can call it. So this connector reads
 * the rendered DOM, exactly like the LinkedIn one.
 *
 * The ONE exception is `view=om`, which really does serve raw RFC822 — see
 * readThreadFull().
 *
 * ── Non-negotiables, all measured ────────────────────────────────────────────
 *  1. VIEWPORT: 1920x1080 (config.VIEWPORT). At 1280 Gmail collapses its action
 *     toolbar to just "Move to"/"Labels", so half the verbs vanish from the DOM.
 *  2. VISIBLE-SCOPED READS: Gmail RETAINS previous view containers (measured: 3
 *     list tables x 50 rows, one visible). A global querySelectorAll answers
 *     with the PREVIOUS view and looks perfectly successful. Everything goes
 *     through `__vis` — declared exactly ONCE per page snippet (two `const __vis`
 *     in one snippet is a page-side SyntaxError, which is why JS_VISIBLE has a
 *     single home in ./extractors and is never re-declared here).
 *  3. NEVER BLIND-CLICK A TOGGLE. Read `aria-checked` / the star's `aria-label`
 *     first and click only if the state needs changing. Blind-clicking silently
 *     inverts the result. (./actions owns this discipline for the verbs.)
 *  4. TYPING APIS DO NOT WORK. `Input.insertText` and per-key
 *     `dispatchKeyEvent` both land NOTHING on Gmail's peoplekit widgets. Text
 *     goes in via the native value setter + an `input` event, chips are
 *     committed with Enter+blur and then VERIFIED. (./compose owns this.)
 *  5. TRUSTED TYPES. `DOMParser.parseFromString` and `innerHTML` THROW inside
 *     Gmail. Bodies are built with `replaceChildren()` + `createTextNode`, and
 *     the `view=om` page is scraped with a REGEX, in node, never in the page.
 *  6. PAGINATION: `#search/<q>/pN` works. The "1–50 of N" counter NEVER changes
 *     between pages — it can never be used for progress or termination.
 *
 * All selectors live in SELECTORS / SELECTORS_EXT (./extractors) — fix breakage
 * THERE, never inline.
 */

import WebSocket from 'ws';
import {
  VIEWPORT,
  maxBodyChars,
  maxThreadChars,
  readGmailConfig,
  resolveCdpBase,
  sendAsTtlMs,
  writeGmailConfig,
  type SendAsIdentity,
} from './config';
import {
  JS_ATTACHMENTS_IN_THREAD,
  JS_THREAD_FULL,
  JS_THREAD_ROWS,
  JS_VISIBLE,
  SELECTORS_EXT,
  type GmailAttachmentScan,
  type GmailThreadFull,
  type GmailThreadRowFull,
} from './extractors';
import * as Compose from './compose';
import * as Labels from './labels';
import * as Actions from './actions';
import { extractPreFromOriginalPage, parseRfc822 } from './mime';
import { startSync, syncProgress, type SyncProgress } from './sync';

// ─── ./safety is loaded LAZILY, on purpose ───────────────────────────────────
//
// ./safety imports `GmError` from THIS file (one error taxonomy, not two). A
// static `import ... from './safety'` here would therefore close a require
// CYCLE. That cycle happens to be benign today — `GmError` is only ever
// constructed inside a function, so the reference resolves after both modules
// have initialised — but "benign today" is a landmine: the day someone writes
// `class X extends GmError` at module scope in ./safety, Core stops booting.
//
// `import type` is erased at compile time, so the static graph stays acyclic
// (safety -> cdp-client only) and the value is pulled in on first use, by which
// point this module is fully initialised. Do not "tidy" this into a normal
// import.
import type * as SafetyNS from './safety';

let _safety: typeof SafetyNS | null = null;
function safety(): typeof SafetyNS {
  if (!_safety) _safety = require('./safety') as typeof SafetyNS;
  return _safety;
}

// ─── errors ──────────────────────────────────────────────────────────────────

/**
 * The connector's single error taxonomy. `code` survives all the way to the
 * caller: routes' `fail()` reads `e.code`, and the MCP layer surfaces it.
 */
export class GmError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GmError';
    this.code = code;
  }
}

/**
 * Normalise anything thrown by a delegated module into a `GmError`.
 *
 * 🔴 This is load-bearing, not defensive tidying. ./labels and ./actions each
 * declare their OWN `GmError` class (they are written to compile and test
 * standalone), and ./compose and ./sync throw `GmComposeError` / `GmSyncError`.
 * None of those is `instanceof` the class the routes check, so without this
 * every one of their carefully-chosen codes — REPLY_MODE_MISMATCH,
 * LABEL_NOT_FOUND, SEND_UNCONFIRMED — would arrive at the caller as a bare
 * message string with `code` dropped. Structural `.code` reading is deliberate:
 * it is the shape all four classes share.
 */
export function toGmError(e: unknown): GmError {
  if (e instanceof GmError) return e;
  const anyE = e as { code?: unknown; message?: unknown } | null;
  const message = e instanceof Error ? e.message : String(e);
  if (anyE && typeof anyE.code === 'string' && anyE.code) return new GmError(anyE.code, message);
  return new GmError('GMAIL_ERROR', message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── surface URLs ────────────────────────────────────────────────────────────

const ORIGIN = 'https://mail.google.com';
const MAIL_BASE = `${ORIGIN}/mail/u/0/`;

// ─── DOM selectors this file itself still uses ───────────────────────────────
//
// Read selectors live in ./extractors (SELECTORS_EXT), compose selectors in
// ./compose, label selectors in ./labels, action selectors in ./actions. What
// remains here is only what the SESSION layer needs: readiness probes and the
// UI landmark guard.

const SELECTORS = {
  /** Logged-in signal — any of the mail-app chrome. */
  appReady: 'input[name="q"], div[role="main"], tr.zA, [gh="tm"]',
  /** A thread-list row. Unread rows additionally carry `zE`. */
  threadRow: SELECTORS_EXT.threadRow,
  /** The list container being present means a list view rendered. */
  listReady: 'div[role="main"] table, tr.zA, .Cp',
  /** Open-thread signal: the subject header. */
  threadReady: SELECTORS_EXT.threadSubject,
  /** "Expand all" in a collapsed thread. */
  expandAll: SELECTORS_EXT.expandAll,
} as const;

/**
 * The MOBILE_UI guard's landmarks. At least ONE must be present or we are not
 * looking at the desktop mail app.
 *
 * 🔴 This is a LANDMARK check, never a viewport check. MEASURED: forcing a
 * 390x844 mobile viewport does NOT flip Gmail's UI (it clamps to 980px and the
 * desktop selectors keep working), so branching on viewport would be a guess
 * dressed as a measurement. The guard exists so an alternate surface — the
 * basic-HTML fallback, a sign-in interstitial, a consent wall, a different
 * product — surfaces as a distinct ERROR instead of as "0 threads", which is
 * indistinguishable from an empty inbox.
 */
const UI_LANDMARKS = ['[gh="mtb"]', 'tr.zA', 'div[role="button"].T-I.T-I-KE.L3'] as const;

// ─── CDP session plumbing ────────────────────────────────────────────────────

/** Find the gmail page target; return a ws URL host-matched to base. */
async function findPageWs(base: string): Promise<string> {
  let list: unknown;
  try {
    const res = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(8000) });
    list = await res.json();
  } catch (e) {
    throw new GmError('CDP_UNREACHABLE', `cannot reach CDP at ${base}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const pages = (Array.isArray(list) ? list : []).filter(
    (t: { type?: string; url?: string }) => t.type === 'page',
  ) as Array<{ url?: string; webSocketDebuggerUrl?: string }>;
  // Prefer a mail tab, but accept any google tab so a SIGNED-OUT browser (which
  // sits on accounts.google.com) is still reachable — otherwise status reporting
  // goes blind exactly when the user needs to be told to log in.
  const page =
    pages.find((t) => /mail\.google\.com/.test(t.url || '')) ||
    pages.find((t) => /\.google\.com/.test(t.url || '')) ||
    pages[0];
  if (!page || !page.webSocketDebuggerUrl) {
    throw new GmError('PAGE_NOT_FOUND', 'no driveable page found on this CDP endpoint (is the Gmail login browser running?)');
  }
  const baseHost = new URL(base).host;
  return String(page.webSocketDebuggerUrl).replace(/^ws:\/\/[^/]+/, `ws://${baseHost}`);
}

/**
 * The page surface every module here consumes. `send` is exposed because
 * ./compose needs `DOM.setFileInputFiles` for attachments, which cannot be
 * expressed as page JS.
 *
 * `evaluate(expr)` runs `expr` as the BODY of an async function, so a snippet is
 * statements ending in `return`, and `await` is legal. Every delegated module
 * is written to that contract.
 */
export interface Cdp {
  evaluate<T = unknown>(expr: string): Promise<T>;
  navigate(url: string): Promise<void>;
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
      reject(new GmError('CDP_UNREACHABLE', 'CDP websocket connect timeout'));
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
        if (m.error) rej(new GmError('CDP_ERROR', JSON.stringify(m.error)));
        else res(m.result);
      }
    });
    ws.on('error', (e: Error) => {
      clearTimeout(to);
      reject(new GmError('CDP_UNREACHABLE', String(e.message || e)));
    });
    ws.on('open', () => {
      clearTimeout(to);
      const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
        new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      const cdp: Cdp = {
        async evaluate<T = unknown>(expr: string): Promise<T> {
          // A navigation can destroy the execution context mid-evaluate. That is
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
                throw new GmError('PAGE_EVAL_ERROR', r.exceptionDetails.exception?.description || 'page eval error');
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
        send('Runtime.enable'),
        send('Page.enable').catch(() => undefined),
        // DOM.enable is REQUIRED, not decorative: DOM.setFileInputFiles (the
        // attachment path in ./compose) needs the DOM agent enabled on the target.
        send('DOM.enable').catch(() => undefined),
        // Headless pages can report as unfocused, and Gmail degrades its
        // typeahead/chip behaviour when document.hasFocus() is false.
        send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined),
        // 🔴 MEASURED: at 1280 wide Gmail COLLAPSES its action toolbar to just
        // "Move to"/"Labels" — every other verb disappears from the DOM. See
        // config.VIEWPORT for the full measurement and why not to go wider.
        send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT }).catch(() => undefined),
      ])
        .then(() => resolve(cdp))
        .catch(reject);
    });
  });
}

/** Open an owned session. The caller MUST close it. */
async function openSession(): Promise<{ cdp: Cdp; close(): void }> {
  const base = resolveCdpBase();
  const wsUrl = await findPageWs(base);
  const cdp = await connect(wsUrl);
  return { cdp, close: () => cdp.close() };
}

async function withCdp<T>(fn: (cdp: Cdp) => Promise<T>): Promise<T> {
  const s = await openSession();
  try {
    return await fn(s.cdp);
  } finally {
    s.close();
  }
}

// ─── navigation + interaction helpers ────────────────────────────────────────

/** Poll a boolean page expression until true or the deadline. */
async function waitFor(cdp: Cdp, boolExpr: string, timeoutMs = 12000): Promise<boolean> {
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
 * Route the SPA by hash and wait for `readySel`. Gmail ignores a hash write
 * that does not change the value, so we blank it first when re-entering the
 * same view — otherwise a repeated call silently returns the previous render.
 */
async function gotoHash(cdp: Cdp, hash: string, readySel: string, timeoutMs = 15000): Promise<void> {
  const h = JSON.stringify(hash);
  const sel = JSON.stringify(readySel);
  const onMail = await cdp.evaluate<boolean>(`return /mail\\.google\\.com$/.test(location.hostname);`);
  if (!onMail) {
    await cdp.navigate(MAIL_BASE + hash);
    await sleep(2500);
  } else {
    await cdp.evaluate(
      `if (location.hash === ${h}) { location.hash = '#__reroute'; await new Promise(r=>setTimeout(r,150)); }
       location.hash = ${h}; return true;`,
    );
    await sleep(1200);
  }
  const ready = await waitFor(cdp, `!!document.querySelector(${sel})`, timeoutMs);
  if (!ready) throw new GmError('PAGE_NOT_READY', `timed out waiting for ${hash} to render (${readySel})`);
  await sleep(600);
}

/** Scroll the thread list until at least `want` rows have rendered (or it stops growing). */
async function ensureRows(cdp: Cdp, want: number): Promise<void> {
  let last = -1;
  for (let i = 0; i < 6; i++) {
    const n = await cdp.evaluate<number>(
      `return [...document.querySelectorAll(${JSON.stringify(SELECTORS.threadRow)})]
         .filter(el => el.offsetParent !== null && el.getBoundingClientRect().height > 0).length;`,
    );
    if (n >= want || n === last) return;
    last = n;
    await cdp.evaluate(
      `const sc = document.querySelector('div[role="main"]') || document.scrollingElement;
       if (sc) sc.scrollBy(0, sc.clientHeight * 1.5); return true;`,
    );
    await sleep(900);
  }
}

/** Expand every collapsed message in the open thread. */
async function expandThread(cdp: Cdp): Promise<boolean> {
  return (
    (await cdp
      .evaluate<boolean>(
        `${JS_VISIBLE}
         const b = __vis(${JSON.stringify(SELECTORS.expandAll)})[0]
           || document.querySelector(${JSON.stringify(SELECTORS.expandAll)});
         if (!b) return false;
         b.click(); await new Promise(r=>setTimeout(r,900)); return true;`,
      )
      .catch(() => false)) === true
  );
}

// ─── page-side snippets owned by this file ───────────────────────────────────

const JS_STATUS = `
  const onMail = /(^|\\.)mail\\.google\\.com$/.test(location.hostname);
  const signin = /signin|ServiceLogin|AccountChooser/i.test(location.href);
  const app = !!document.querySelector(${JSON.stringify(SELECTORS.appReady)});
  let self = null;
  try { const g = window.GLOBALS && window.GLOBALS[10]; if (g && /@/.test(String(g))) self = String(g); } catch (e) {}
  return { loggedIn: onMail && !signin && app, self, url: location.href, hash: location.hash };`;

const JS_UI_LANDMARKS = `
  const want = ${JSON.stringify(UI_LANDMARKS)};
  const hit = want.filter(s => { try { return !!document.querySelector(s); } catch (e) { return false; } });
  return { hit, url: location.href };`;

/**
 * Read the compose's hidden send-as field.
 *
 * 🔴 `input[name="from"]` is HIDDEN, so it can NEVER be visibility-filtered
 * itself — filtering it is how this read returns null on a perfectly good
 * compose. The stale-compose guarantee is preserved by scoping to the VISIBLE
 * compose AROUND it: start from the last visible Send button and walk up to the
 * first ancestor that also holds the field. That works for the popup dialog AND
 * the inline reply editor (which is not a role=dialog at all).
 */
const JS_FROM_FIELD = `
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const visAll = (sel) => [...document.querySelectorAll(sel)].filter(vis);
  const last = (a) => (a.length ? a[a.length - 1] : null);
  let el = null;
  const btn = last(visAll('div[role="button"][data-tooltip^="Send"], div[role="button"][aria-label^="Send"]'));
  if (btn) {
    let n = btn;
    for (let i = 0; i < 14 && n; i++) {
      n = n.parentElement;
      if (!n) break;
      const hit = n.querySelector('input[name="from"]');
      if (hit) { el = hit; break; }
    }
  }
  if (!el) { const dlg = last(visAll('div[role="dialog"]')); if (dlg) el = dlg.querySelector('input[name="from"]'); }
  if (!el) { const all = [...document.querySelectorAll('input[name="from"]')]; el = all.length ? all[all.length - 1] : null; }
  if (!el) return null;
  const v = String(el.value || '').trim();
  if (!v) return null;
  const m = v.match(/<([^<>]+@[^<>]+)>/);
  return String(m ? m[1] : v).trim().toLowerCase();`;

/**
 * The "Send mail as" table on `#settings/accounts`.
 *
 * MEASURED 2026-07-29, one row verbatim:
 *   `LangMart Support <support@langmart.ai> Not an alias. default edit info delete`
 * The row whose control reads a bare `default` (rather than `make default`) is
 * the CURRENT default — that ordering matters, because "make default" CONTAINS
 * "default", so the negative test has to run first.
 *
 * 🔴 Only INNERMOST `tr`s are considered. Gmail's settings page nests tables, so
 * an outer row's textContent concatenates every inner row: it would carry the
 * first address, somebody else's "make default", and read as one identity that
 * does not exist.
 */
/**
 * Page-side helper: recover a clean attachment FILENAME.
 *
 * MEASURED: the chip's concatenated text reads
 *   "attachment X.docxPreview attachment X.docxX.docx256 KB"
 * — the name repeated three times plus the size, because textContent joins
 * adjacent elements with no separator. Pull the filename by extension and take
 * the shortest distinct match, then strip any leading "(Preview) attachment".
 */
const JS_ATT_NAME = `
  const __attName = (raw, fallbackHref) => {
    const t = String(raw || '').replace(/\\s+/g, ' ').trim();
    const ext = '(?:pdf|docx?|xlsx?|pptx?|csv|txt|zip|rar|7z|png|jpe?g|gif|webp|svg|heic|mp4|mov|mp3|wav|eml|ics|json|xml)';
    const hits = t.match(new RegExp('[^/\\\\\\\\<>|"]{1,180}?\\\\.' + ext + '\\\\b', 'gi')) || [];
    let best = null;
    for (const h of hits) {
      const c = h.replace(/^.*?(?:preview\\s+)?attachment\\s+/i, '').trim();
      if (!best || c.length < best.length) best = c;
    }
    if (!best && fallbackHref) {
      const m = String(fallbackHref).match(/[?&]realattid=([^&]+)/) || String(fallbackHref).match(/[?&]attid=([^&]+)/);
      if (m) best = decodeURIComponent(m[1]);
    }
    return best || null;
  };
`;

const JS_SENDAS = `
  ${JS_VISIBLE}
  try {
    // Scope to the table that actually holds the "Send mail as" header. The
    // settings page carries several tables (notably "Grant access to your
    // account"), and scanning all of them over-captured ~2 extra identities.
    const __all = __vis('tr').filter(tr => !tr.querySelector('tr'));
    const __hdr = __all.find(tr => /send mail as/i.test(tr.innerText || tr.textContent || ''));
    const __tbl = __hdr && __hdr.closest ? __hdr.closest('table') : null;
    const rows = __tbl
      ? [...__tbl.querySelectorAll('tr')].filter(tr => !tr.querySelector('tr'))
      : __all;
    const out = []; const seen = new Set();
    for (const tr of rows) {
      // innerText, NOT textContent: textContent concatenates adjacent elements
      // with no whitespace, yielding "…make defaultedit info", against which a
      // trailing \\b in /make default\\b/ fails and EVERY row is silently skipped.
      const txt = (tr.innerText || tr.textContent || '').replace(/\\s+/g, ' ').trim();
      const m = txt.match(/<([^<>\\s]+@[^<>\\s]+)>/);
      if (!m) continue;
      // No trailing \\b — the rendered text can run straight into the next control.
      const makeDefault = /make\\s*default/i.test(txt);
      const isDefault = !makeDefault && /default/i.test(txt);
      // A row with neither control is not a send-as row (signature blocks, the
      // "Grant access" table, …). Refusing it is what keeps this honest.
      if (!makeDefault && !isDefault) continue;
      const email = String(m[1]).toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);
      const name = txt.slice(0, m.index).replace(/[\\s,]+$/, '').trim();
      out.push({ email, name: name || null, isDefault, alias: !/not an alias/i.test(txt) });
    }
    return out;
  } catch (e) { return []; }`;

/**
 * The account's `ik` token — required by the `view=om` raw-source URL and by
 * attachment download URLs.
 *
 * Three guarded strategies, and the WINNER is reported: with no measured single
 * source, a null result and a wrong result look identical from the outside, and
 * a wrong `ik` yields an error page that then reads as "empty message".
 */
const JS_IK = `
  const looksIk = (v) => (typeof v === 'string' && /^[0-9a-f]{6,}$/i.test(v)) ? v : null;
  let ik = null, via = null;
  try { const G = window.GLOBALS; if (G) { ik = looksIk(String(G[9] || '')); if (ik) via = 'GLOBALS[9]'; } } catch (e) {}
  if (!ik) {
    for (const a of document.querySelectorAll('a[href*="ik="]')) {
      const m = String(a.getAttribute('href') || '').match(/[?&]ik=([0-9a-f]+)/i);
      if (m) { ik = m[1]; via = 'anchor-href'; break; }
    }
  }
  if (!ik) {
    try {
      const G = window.GLOBALS;
      if (G && typeof G.length === 'number') {
        for (let i = 0; i < G.length; i++) {
          const p = looksIk(typeof G[i] === 'string' ? G[i] : '');
          if (p && p.length >= 10) { ik = p; via = 'GLOBALS-scan'; break; }
        }
      }
    } catch (e) {}
  }
  return { ik, via };`;

/**
 * Fetch a same-origin Gmail URL from INSIDE the page so the session cookies
 * ride along, and hand the raw text back to node.
 *
 * The parsing happens in node deliberately: `view=om` enforces Trusted Types,
 * under which `DOMParser.parseFromString` and `innerHTML` THROW. ./mime's
 * `extractPreFromOriginalPage` is regex-only for exactly that reason.
 */
function jsFetchText(url: string, maxChars: number): string {
  return `
  try {
    const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
    let t = await r.text();
    const full = t.length;
    if (t.length > ${maxChars}) t = t.slice(0, ${maxChars});
    return { status: r.status, ok: r.ok, text: t, fullLength: full, truncated: full > ${maxChars} };
  } catch (e) {
    return { status: 0, ok: false, text: '', fullLength: 0, truncated: false, error: String((e && e.message) || e) };
  }`;
}

// ─── public types ────────────────────────────────────────────────────────────

export interface GmailStatus {
  loggedIn: boolean;
  self: string | null;
  url?: string;
  /**
   * The identity Gmail will actually send as unless a compose overrides it.
   * 🔴 MEASURED: this is NOT necessarily `self` — on the reference account the
   * compose opened as `support@langmart.ai` while `self` was
   * `yi.huang@databunny.sg`. Reporting only `self` would tell the operator the
   * wrong thing about every message they are about to send.
   */
  defaultSendAs: string | null;
  /** How many "Send mail as" identities the account carries (8 on the reference account). */
  sendAsCount: number;
  /** When the send-as table was last read live. null = never. */
  sendAsCheckedAt: number | null;
  /** 'desktop' when a UI landmark was found; 'unrecognised' otherwise. */
  ui: 'desktop' | 'unrecognised';
}

/** A thread-list row. Superset of the pre-integration shape (labels + attachment hint). */
export type GmailThread = GmailThreadRowFull;

export interface GmailAttachmentRow {
  name: string;
  /** Guessed from the filename extension. null when the extension is unknown. */
  mimeType: string | null;
  /** Parsed from Gmail's human size label ("128K", "1.2 MB"). null when absent. */
  sizeBytes: number | null;
  sizeLabel: string | null;
  messageId: string | null;
  downloadable: boolean;
  downloadUrl: string | null;
  /**
   * 'observed' — the URL came off a real anchor in the page.
   * 'constructed' — built from the measured URL shape. Plausible, NOT verified;
   * never present it as a link Gmail handed us.
   */
  downloadUrlSource: 'observed' | 'constructed' | null;
  /** Which ATTACH_STRATEGIES entry produced this row, so a wrong shape is diagnosable. */
  strategy: string | null;
}

export interface GmailMessage {
  messageId: string | null;
  fromName: string | null;
  fromEmail: string | null;
  to: string[];
  cc: string[];
  date: string | null;
  subject: string | null;
  body: string;
  /** Which read path produced `body`. Attribution, so a short body is never mistaken for a short message. */
  bodySource: 'raw-rfc822' | 'rendered-dom' | 'rendered-dom-fallback';
  /** True when `body` was cut to the configured ceiling (see config.maxBodyChars). */
  truncated: boolean;
  attachments: GmailAttachmentRow[];
  note?: string;
}

export interface GmailThreadDetail {
  threadId: string;
  subject: string | null;
  url: string;
  labels: string[];
  messages: GmailMessage[];
  /** Stubs still collapsed after the expand-all attempt. Non-zero = suspect the read. */
  collapsedCount: number;
  note?: string;
}

/** Re-exported so a caller has ONE place to import the label shape from. */
export type GmailLabel = Labels.LabelInfo;

export interface SyncWindowResult {
  jobId: string;
  state: SyncProgress['state'];
  /** True when a walk was already running and this call joined it rather than starting a second. */
  already: boolean;
  /** True when the job finished inside this call's budget. False = counts are PARTIAL. */
  complete: boolean;
  threadsSynced: number;
  messagesSynced: number;
  threadsSkipped: number;
  pagesFetched: number;
  windowDays: number;
  label: string;
  stopReason: string | null;
  error: string | null;
  note: string | null;
}

export interface SendOutcome {
  ok: true;
  to: string;
  recipients: string[];
  subject: string;
  /** 🔴 READ BACK from the compose's `input[name="from"]`, never assumed. null = unreadable. */
  from: string | null;
  verified: boolean;
  note?: string;
}

export interface ReplyOutcome {
  ok: true;
  threadId: string;
  mode: 'reply' | 'reply_all';
  from: string | null;
  verified: boolean;
  note?: string;
}

export interface DraftOutcome {
  ok: true;
  to: string;
  recipients: string[];
  subject: string;
  draftId: string | null;
  from: string | null;
  verified: boolean;
  note?: string;
}

// ─── preconditions shared by every operation ─────────────────────────────────

async function readStatusRaw(cdp: Cdp): Promise<{ loggedIn: boolean; self: string | null; url: string; hash: string }> {
  return cdp.evaluate(JS_STATUS);
}

/** Throw unless the mail app is loaded and authenticated. */
async function assertLoggedIn(cdp: Cdp): Promise<void> {
  const st = await readStatusRaw(cdp);
  if (!st.loggedIn) {
    throw new GmError(
      'NOT_LOGGED_IN',
      'the Gmail driver browser is not logged in — run gmail_login and finish the Google sign-in.',
    );
  }
}

/**
 * The MOBILE_UI guard. Throws a DISTINCT code so an alternate Gmail surface is
 * reported as an error rather than as an empty result.
 */
async function assertDesktopUi(cdp: Cdp): Promise<void> {
  const r = await cdp.evaluate<{ hit: string[]; url: string }>(JS_UI_LANDMARKS);
  if (!r || !Array.isArray(r.hit) || r.hit.length === 0) {
    throw new GmError(
      'MOBILE_UI',
      `none of the desktop Gmail landmarks (${UI_LANDMARKS.join(', ')}) are present at ${r?.url ?? 'unknown url'} — ` +
        'this is not the desktop mail app (mobile/basic HTML, an interstitial, or a changed UI). ' +
        'Refusing to read or write against an unrecognised surface rather than reporting an empty mailbox.',
    );
  }
}

/**
 * Charge one action against ./safety's limiter and refuse LOUDLY when the
 * budget is gone. `record` is called by the caller in a `finally`, because the
 * limiter counts ATTEMPTS — a failed send still consumed Google's attention.
 */
function gate(kind: SafetyNS.ActionKind): void {
  const v = safety().checkRate(kind);
  if (!v.allowed) throw new GmError('RATE_LIMITED', v.reason);
}

function charge(kind: SafetyNS.ActionKind): void {
  try {
    safety().recordAction(kind);
  } catch {
    /* the limiter must never be the reason an operation fails */
  }
}

/**
 * The entry sequence every browser-touching operation shares:
 * rate budget -> session -> logged in -> desktop UI -> work.
 */
async function op<T>(kind: SafetyNS.ActionKind, fn: (cdp: Cdp) => Promise<T>): Promise<T> {
  gate(kind);
  try {
    return await withCdp(async (cdp) => {
      await assertLoggedIn(cdp);
      await assertDesktopUi(cdp);
      return fn(cdp);
    });
  } catch (e) {
    throw toGmError(e);
  } finally {
    charge(kind);
  }
}

// ─── status + send-as identities ─────────────────────────────────────────────

/**
 * Read the "Send mail as" table.
 *
 * This NAVIGATES the driver browser to `#settings/accounts` and routes back to
 * wherever it was, because the browser is a shared, visible resource the
 * operator may be looking at — a read that silently strands them in Settings is
 * a read they will stop trusting.
 */
export async function listSendAs(): Promise<SendAsIdentity[]> {
  return op('read', (cdp) => readSendAs(cdp));
}

/** The navigate-read-restore body, so cdpStatus() can reuse ONE session. */
async function readSendAs(cdp: Cdp): Promise<SendAsIdentity[]> {
  const before = (await readStatusRaw(cdp)).hash || '#inbox';
  try {
    await gotoHash(cdp, '#settings/accounts', 'div[role="main"]');
    // The settings page renders progressively; the table is what we are after,
    // so wait for an addressed row rather than for the container.
    await waitFor(
      cdp,
      `/#settings\\/accounts/.test(location.hash) &&
       [...document.querySelectorAll('tr')].some(tr => /<[^<>\\s]+@[^<>\\s]+>/.test(tr.textContent || ''))`,
      15000,
    );
    const rows = await cdp.evaluate<SendAsIdentity[]>(JS_SENDAS);
    return Array.isArray(rows) ? rows : [];
  } finally {
    // Best-effort restore. A failure here must not lose the rows we just read.
    await gotoHash(cdp, before && before !== '#settings/accounts' ? before : '#inbox', SELECTORS.listReady, 12000).catch(
      () => undefined,
    );
  }
}

/**
 * Connector status: is the driver browser up and authenticated, as whom, and —
 * the part that actually decides what a send does — which send-as identity is
 * the default.
 *
 * The send-as table is served from the config cache and refreshed only when it
 * is missing or older than `GMAIL_SENDAS_TTL_MS` (12h), because reading it costs
 * a navigation. Pass `refreshSendAs: true` to force it.
 */
export async function cdpStatus(opts: { refreshSendAs?: boolean } = {}): Promise<GmailStatus> {
  return withCdp(async (cdp) => {
    const st = await readStatusRaw(cdp);
    let ui: GmailStatus['ui'] = 'unrecognised';
    try {
      await assertDesktopUi(cdp);
      ui = 'desktop';
    } catch {
      /* reported, not thrown: status must still answer for a broken UI */
    }

    const cfg = readGmailConfig();
    let sendAs = Array.isArray(cfg.sendAs) ? cfg.sendAs : [];
    let checkedAt = typeof cfg.sendAsCheckedAt === 'number' ? cfg.sendAsCheckedAt : null;
    const ttl = sendAsTtlMs();
    const stale = checkedAt === null || ttl === 0 || Date.now() - checkedAt > ttl;

    if (st.loggedIn && ui === 'desktop' && (opts.refreshSendAs === true || stale)) {
      try {
        const fresh = await readSendAs(cdp);
        if (fresh.length) {
          sendAs = fresh;
          checkedAt = Date.now();
          writeGmailConfig({
            sendAs: fresh,
            defaultSendAs: fresh.find((r) => r.isDefault)?.email ?? null,
            sendAsCheckedAt: checkedAt,
          });
        }
      } catch {
        // A settings read that fails must never fail `gmail_status` — the cached
        // (or empty) value is still the honest answer, and `sendAsCheckedAt`
        // tells the caller how old it is.
      }
    }

    return {
      loggedIn: st.loggedIn,
      self: st.self ?? null,
      url: st.url,
      defaultSendAs: sendAs.find((r) => r.isDefault)?.email ?? cfg.defaultSendAs ?? null,
      sendAsCount: sendAs.length,
      sendAsCheckedAt: checkedAt,
      ui,
    };
  });
}

// ─── reads ───────────────────────────────────────────────────────────────────

/** List threads in a mailbox view (`inbox` by default, or any label). */
export async function listThreads(opts: { limit?: number; label?: string } = {}): Promise<GmailThread[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));
  const label = (opts.label || 'inbox').trim();
  const hash = /^inbox$/i.test(label) ? '#inbox' : `#label/${encodeURIComponent(label)}`;
  return op('read', async (cdp) => {
    await gotoHash(cdp, hash, SELECTORS.listReady);
    await ensureRows(cdp, limit);
    return (await cdp.evaluate<GmailThread[]>(JS_THREAD_ROWS(limit))) || [];
  });
}

/**
 * Search with Gmail's own query syntax (`from:x`, `is:unread`, `has:attachment`,
 * …). Runs as a hash route rather than typing into the search box — a URL change
 * is deterministic where UI typing is not.
 */
export async function searchThreads(query: string, limit = 25): Promise<GmailThread[]> {
  const q = String(query || '').trim();
  if (!q) throw new GmError('INVALID_QUERY', 'query is required');
  const n = Math.max(1, Math.min(limit, 100));
  return op('read', async (cdp) => {
    await gotoHash(cdp, `#search/${encodeURIComponent(q)}`, SELECTORS.listReady);
    await ensureRows(cdp, n);
    return (await cdp.evaluate<GmailThread[]>(JS_THREAD_ROWS(n))) || [];
  });
}

/** Unread threads (a saved search — `is:unread`). */
export async function unreadThreads(limit = 25): Promise<GmailThread[]> {
  return searchThreads('is:unread', limit);
}

/** The label tree from the left nav, with unread counts. Delegated to ./labels. */
export async function listLabels(): Promise<GmailLabel[]> {
  return op('read', async (cdp) => {
    await gotoHash(cdp, '#inbox', SELECTORS.listReady).catch(() => undefined);
    return Labels.listLabels(cdp);
  });
}

/** The labels currently on ONE thread. */
export async function threadLabels(threadId: string): Promise<string[]> {
  const id = requireThreadId(threadId);
  return op('read', (cdp) => Labels.threadLabels(cdp, id));
}

function requireThreadId(threadId: string): string {
  const id = String(threadId || '').trim();
  if (!id) throw new GmError('INVALID_THREAD', 'threadId is required');
  return id;
}

// ─── attachment shaping ──────────────────────────────────────────────────────

/** Extension -> MIME. Short on purpose: a guess that is wrong is worse than a null. */
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  txt: 'text/plain', csv: 'text/csv', html: 'text/html', md: 'text/markdown', json: 'application/json', xml: 'application/xml',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', mov: 'video/quicktime', ics: 'text/calendar', eml: 'message/rfc822',
};

function guessMime(name: string): string | null {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  return m ? MIME_BY_EXT[m[1]] ?? null : null;
}

/**
 * Gmail's human size label -> bytes. `null` when there is nothing to parse —
 * never 0, because 0 would read as "an empty file".
 *
 * Gmail writes `128K` for kilobytes; the bare-letter forms are binary multiples,
 * which is what Gmail displays.
 */
function parseSizeLabel(label: string | null): number | null {
  if (!label) return null;
  const m = String(label).match(/(\d+(?:[.,]\d+)?)\s*(KB|MB|GB|TB|bytes|K|M|G|T|B)\b/i);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toUpperCase();
  const mult: Record<string, number> = {
    B: 1, BYTES: 1, K: 1024, KB: 1024, M: 1024 ** 2, MB: 1024 ** 2,
    G: 1024 ** 3, GB: 1024 ** 3, T: 1024 ** 4, TB: 1024 ** 4,
  };
  return Math.round(n * (mult[unit] ?? 1));
}

/**
 * Build the attachment download URL from the MEASURED shape:
 *   .../mail/u/0?ui=2&ik=<ik>&attid=0.<n>&permmsgid=msg-f:<decimal>&th=<threadIdHex>&view=att&zw&
 *
 * ⚠️ CONSTRUCTED, not observed — that is why callers get `downloadUrlSource`.
 * It is only ever a fallback for when the page held no anchor, and it is
 * refused outright for SENT mail: sent messages use `permmsgid=msg-a:r-<decimal>`,
 * whose decimal is NOT the legacy message id, so a `msg-f:` guess there would be
 * a confidently wrong link.
 */
function constructAttachmentUrl(ik: string | null, threadId: string, messageId: string | null, index: number): string | null {
  if (!ik || !messageId || !/^[0-9a-f]+$/i.test(messageId)) return null;
  let decimal: string;
  try {
    decimal = BigInt(`0x${messageId}`).toString(10);
  } catch {
    return null;
  }
  return `${ORIGIN}/mail/u/0?ui=2&ik=${encodeURIComponent(ik)}&attid=0.${index}&permmsgid=msg-f:${decimal}&th=${encodeURIComponent(threadId)}&view=att&zw&`;
}

function shapeAttachments(
  raw: Array<{ name: string; sizeLabel: string | null; downloadUrl: string | null; messageId?: string | null }>,
  strategy: string | null,
  ctx: { ik: string | null; threadId: string },
): GmailAttachmentRow[] {
  const perMessage = new Map<string, number>();
  return raw.map((a) => {
    const messageId = a.messageId ?? null;
    const key = messageId ?? '';
    const index = (perMessage.get(key) ?? 0) + 1;
    perMessage.set(key, index);
    const observed = a.downloadUrl ?? null;
    const constructed = observed ? null : constructAttachmentUrl(ctx.ik, ctx.threadId, messageId, index);
    const url = observed ?? constructed;
    return {
      name: a.name,
      mimeType: guessMime(a.name),
      sizeBytes: parseSizeLabel(a.sizeLabel),
      sizeLabel: a.sizeLabel ?? null,
      messageId,
      downloadable: !!url,
      downloadUrl: url,
      downloadUrlSource: observed ? 'observed' : constructed ? 'constructed' : null,
      strategy,
    };
  });
}

/**
 * Attachment metadata for one thread.
 *
 * 🔴 MEASURED: the thread must be EXPANDED first or every selector returns 0 —
 * collapsed messages hold no attachment nodes at all, and the resulting empty
 * array is indistinguishable from "this thread has no attachments".
 */
export async function listAttachments(threadId: string): Promise<GmailAttachmentRow[]> {
  const id = requireThreadId(threadId);
  return op('read', async (cdp) => {
    await gotoHash(cdp, `#all/${encodeURIComponent(id)}`, SELECTORS.threadReady);
    await expandThread(cdp);
    await sleep(400);
    const scan = await cdp.evaluate<GmailAttachmentScan>(JS_ATTACHMENTS_IN_THREAD);
    const ik = (await cdp.evaluate<{ ik: string | null }>(JS_IK).catch(() => ({ ik: null }))).ik;
    const rows = Array.isArray(scan?.attachments) ? scan.attachments : [];
    return shapeAttachments(rows, scan?.strategy ?? null, { ik, threadId: id });
  });
}

// ─── thread reads ────────────────────────────────────────────────────────────

function clip(text: string, max: number): { body: string; truncated: boolean } {
  const s = String(text ?? '');
  return s.length > max ? { body: s.slice(0, max), truncated: true } : { body: s, truncated: false };
}

/** The rendered-DOM read, shared by both paths (the raw path uses it as its skeleton). */
async function readThreadDom(cdp: Cdp, id: string): Promise<{ detail: GmailThreadDetail; ik: string | null }> {
  await gotoHash(cdp, `#all/${encodeURIComponent(id)}`, SELECTORS.threadReady);
  // JS_THREAD_FULL performs the expand-all itself, then reads visible-scoped.
  const d = await cdp.evaluate<GmailThreadFull>(JS_THREAD_FULL);
  const ik = (await cdp.evaluate<{ ik: string | null }>(JS_IK).catch(() => ({ ik: null }))).ik;
  const cap = maxBodyChars();
  const messages: GmailMessage[] = (d?.messages || []).map((m) => {
    const { body, truncated } = clip(m.body, cap);
    return {
      messageId: m.messageId,
      fromName: m.fromName,
      fromEmail: m.fromEmail,
      to: Array.isArray(m.to) ? m.to : [],
      cc: [],
      date: m.date,
      subject: null,
      body,
      bodySource: 'rendered-dom' as const,
      truncated,
      attachments: shapeAttachments(m.attachments || [], m.attachmentStrategy ?? null, { ik, threadId: id }),
    };
  });
  return {
    detail: {
      threadId: id,
      subject: d?.subject ?? null,
      url: d?.url ?? `${MAIL_BASE}#all/${id}`,
      labels: Array.isArray(d?.labels) ? d.labels : [],
      messages,
      collapsedCount: typeof d?.collapsedCount === 'number' ? d.collapsedCount : 0,
    },
    ik,
  };
}

/**
 * Open one thread and read it from the RENDERED DOM.
 *
 * Lossy by nature: Gmail clips long messages ("[Message clipped]") and hides
 * trimmed quotes, so this is the `full:false` path. Prefer readThreadFull().
 */
export async function readThread(threadId: string): Promise<GmailThreadDetail> {
  const id = requireThreadId(threadId);
  return op('read', async (cdp) => (await readThreadDom(cdp, id)).detail);
}

/** Per-thread ceiling on raw fetches. A 200-message thread is not a read, it is a sync. */
const MAX_RAW_MESSAGES = 25;
/** Ceiling on the `view=om` HTML we pull back per message before parsing. */
const MAX_RAW_HTML_CHARS = 5_000_000;

/**
 * Open one thread and read COMPLETE message bodies from Gmail's raw RFC822
 * source (`?ui=2&ik=<ik>&view=om&th=<legacy message id>`).
 *
 * ── How, and why it is shaped like this (all MEASURED 2026-07-29) ────────────
 *  - `view=om` serves an HTML page whose single `<pre>` holds the whole RFC822
 *    message. It is scraped with a REGEX in node, never in the page: that page
 *    enforces Trusted Types, under which `DOMParser.parseFromString` and
 *    `innerHTML` THROW.
 *  - It returns exactly ONE message. So ./mime's `parseRfc822Multi` is
 *    effectively DEAD for this path — do not reach for it here. To read a whole
 *    thread you collect each `data-legacy-message-id` from the EXPANDED DOM and
 *    fetch per message (verified on a 7-message thread: 4 distinct messages,
 *    24k–66k chars each).
 *  - ⚠️ It returns EMPTY for SENT mail. Sent messages are addressed as
 *    `permmsgid=msg-a:r-<decimal>` rather than `msg-f:`, and the `view=om`
 *    fetch yields nothing. Full-read of sent mail is therefore UNSUPPORTED: such
 *    a message falls back to its rendered body and SAYS SO in `note` +
 *    `bodySource`, rather than reporting an empty message as if that were the
 *    content.
 *
 * Output is bounded — see config.maxBodyChars/maxThreadChars. "Complete" is the
 * point of this path, but an unbounded complete read is how one tool result
 * exceeds a whole context window.
 */
export async function readThreadFull(threadId: string): Promise<GmailThreadDetail> {
  const id = requireThreadId(threadId);
  return op('read', async (cdp) => {
    const { detail, ik } = await readThreadDom(cdp, id);
    if (!detail.messages.length) return { ...detail, note: 'no messages rendered — nothing to read the raw source for' };
    if (!ik) {
      return {
        ...detail,
        note:
          'could not resolve the account `ik` token, so the raw-source path is unavailable; ' +
          'bodies below are the RENDERED view, which Gmail clips on long messages',
      };
    }

    const cap = maxBodyChars();
    const threadCap = maxThreadChars();
    const notes: string[] = [];
    let spent = 0;
    let fetched = 0;

    for (const m of detail.messages) {
      if (!m.messageId) {
        notes.push('a message had no data-legacy-message-id and kept its rendered body');
        continue;
      }
      if (fetched >= MAX_RAW_MESSAGES) {
        notes.push(`stopped after ${MAX_RAW_MESSAGES} raw fetches; later messages kept their rendered bodies`);
        break;
      }
      if (spent >= threadCap) {
        notes.push(`thread body budget (${threadCap} chars) reached; later messages kept their rendered bodies`);
        break;
      }
      fetched += 1;

      const url = `${MAIL_BASE}?ui=2&ik=${encodeURIComponent(ik)}&view=om&th=${encodeURIComponent(m.messageId)}`;
      const res = await cdp
        .evaluate<{ status: number; ok: boolean; text: string; fullLength: number; truncated: boolean }>(
          jsFetchText(url, MAX_RAW_HTML_CHARS),
        )
        .catch(() => null);

      const pre = res && res.ok ? extractPreFromOriginalPage(res.text) : null;
      if (!pre) {
        // The measured signature of SENT mail, and of any other view=om miss.
        m.bodySource = 'rendered-dom-fallback';
        m.note =
          'raw source unavailable for this message (view=om returned nothing) — this is the MEASURED behaviour for ' +
          'SENT mail, which Gmail addresses as permmsgid=msg-a:r-… rather than msg-f:. Body below is the RENDERED ' +
          'view, which Gmail clips on long messages. Full-read of sent mail is not supported.';
        continue;
      }

      const parsed = parseRfc822(pre);
      const text = parsed.textBody && parsed.textBody.trim() ? parsed.textBody : '';
      if (!text) {
        // HTML-only message: the raw source parsed, but there is no text/plain
        // part. The rendered DOM already holds Gmail's own rendering of that
        // HTML, which is a far better answer than an HTML-to-text guess here.
        m.bodySource = 'rendered-dom-fallback';
        m.note = 'the raw source carries no text/plain part (HTML-only message) — body below is the rendered view';
      } else {
        const { body, truncated } = clip(text, Math.min(cap, Math.max(1, threadCap - spent)));
        m.body = body;
        m.truncated = truncated;
        m.bodySource = 'raw-rfc822';
        if (truncated) m.note = `body truncated to ${body.length} of ${text.length} chars (GMAIL_MAX_BODY_CHARS)`;
        spent += body.length;
      }

      // Header-derived fields are strictly better than the scraped ones.
      if (parsed.from?.email) m.fromEmail = parsed.from.email;
      if (parsed.from?.name) m.fromName = parsed.from.name;
      if (parsed.subject) m.subject = parsed.subject;
      if (parsed.date) m.date = parsed.date;
      const to = parsed.to.map((a) => a.email).filter((x): x is string => !!x);
      const cc = parsed.cc.map((a) => a.email).filter((x): x is string => !!x);
      if (to.length) m.to = to;
      if (cc.length) m.cc = cc;
    }

    const fellBack = detail.messages.filter((m) => m.bodySource === 'rendered-dom-fallback').length;
    if (fellBack) notes.push(`${fellBack} of ${detail.messages.length} message(s) could not be read from raw source (see each message's note)`);
    return notes.length ? { ...detail, note: notes.join('; ') } : detail;
  });
}

// ─── sync ────────────────────────────────────────────────────────────────────

/**
 * How long syncWindow() waits for the background walk before returning PARTIAL
 * counts. 100s sits under the MCP layer's 120s workerPostRaw ceiling, so the
 * caller gets a structured partial answer instead of a transport timeout.
 */
const SYNC_WAIT_MS = 100_000;

/**
 * Fill the local window cache, and wait for it (bounded).
 *
 * ./sync owns the walk: it takes a FACTORY rather than a live session, because
 * the job outlives the request that started it and must not hold the caller's
 * connection. This function is the bridge — it starts the job, then polls until
 * it finishes or the call budget runs out.
 *
 * 🔴 `complete:false` means the counts are PARTIAL and the walk is STILL
 * RUNNING; it does not mean the sync failed. Widen `days` in steps rather than
 * asking for 60 in one call.
 */
export async function syncWindow(
  opts: { days?: number; label?: string; includeBodies?: boolean; timeoutMs?: number } = {},
): Promise<SyncWindowResult> {
  const days = Math.max(1, Math.min(Math.floor(opts.days ?? 10), 60));
  const label = String(opts.label || 'inbox').trim() || 'inbox';
  const budget = Math.max(5_000, Math.min(opts.timeoutMs ?? SYNC_WAIT_MS, 300_000));

  // Fail the CALLER's call for a logged-out browser, rather than a background
  // job the operator then has to go hunting for.
  await op('read', async () => undefined);

  let started: { jobId: string; already: boolean };
  try {
    started = startSync(openSession, {
      days,
      label: /^inbox$/i.test(label) ? undefined : label,
      includeBodies: opts.includeBodies !== false,
    });
  } catch (e) {
    throw toGmError(e);
  }

  const deadline = Date.now() + budget;
  let p: SyncProgress | null = syncProgress(started.jobId);
  while (p && p.state === 'running' && Date.now() < deadline) {
    await sleep(1500);
    p = syncProgress(started.jobId);
  }

  const complete = !!p && p.state !== 'running';
  const note = complete
    ? p?.note ?? null
    : `still running after ${Math.round(budget / 1000)}s — counts are PARTIAL. Poll gmail_sync_status, or widen \`days\` in smaller steps.`;

  return {
    jobId: started.jobId,
    state: p?.state ?? 'running',
    already: started.already,
    complete,
    threadsSynced: p?.threadsUpserted ?? 0,
    messagesSynced: p?.messagesUpserted ?? 0,
    threadsSkipped: p?.threadsSkipped ?? 0,
    pagesFetched: p?.pagesFetched ?? 0,
    windowDays: days,
    label,
    stopReason: p?.stopReason ?? null,
    error: p?.error ?? null,
    note,
  };
}

/** Poll a running/finished sync. Omit `jobId` for the most recent. */
export function syncJob(jobId?: string): SyncProgress | null {
  return syncProgress(jobId);
}

// ─── writes: compose / send / reply / draft ──────────────────────────────────

/** Split a comma-separated recipient string into addresses. */
function splitAddresses(raw: string): string[] {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A ComposeCtx that also captures WHO the message is being sent as.
 *
 * 🔴 The requirement is "read it back from `input[name=\"from\"]`, never assume",
 * and the only moment that field exists is while the compose is open — after
 * ./compose returns, the dialog is gone. So the ctx watches the traffic it is
 * proxying and, the first time ./compose evaluates its Send (or Save & close)
 * snippet, reads the field FIRST. The two marker strings are the error codes
 * those snippets carry (`SEND_BUTTON_NOT_FOUND`, `SAVE_CLOSE_NOT_FOUND`); they
 * are unique to that snippet and semantically pinned to that instant.
 *
 * If ./compose ever renames those codes this degrades to `from: null` plus an
 * explicit note — it CANNOT silently report the wrong identity, which is the
 * property that matters.
 */
interface IdentityCtx extends Compose.ComposeCtx {
  identity(): string | null;
  attempted(): boolean;
}

function makeComposeCtx(cdp: Cdp): IdentityCtx {
  let identity: string | null = null;
  let attempted = false;
  return {
    async evaluate<T>(expr: string): Promise<T> {
      if (!attempted && (expr.includes('SEND_BUTTON_NOT_FOUND') || expr.includes('SAVE_CLOSE_NOT_FOUND'))) {
        attempted = true;
        try {
          identity = await cdp.evaluate<string | null>(JS_FROM_FIELD);
        } catch {
          identity = null;
        }
      }
      return cdp.evaluate<T>(expr);
    },
    navigate: (url: string) => cdp.navigate(url),
    send: (method: string, params?: Record<string, unknown>) => cdp.send(method, params),
    identity: () => identity,
    attempted: () => attempted,
  };
}

/** The note appended when the identity could not be read back. */
function identityNote(ctx: IdentityCtx): string | null {
  if (ctx.identity()) return null;
  return ctx.attempted()
    ? 'the sending identity could not be read back from input[name="from"] — treat `from` as UNKNOWN, not as the default'
    : 'the sending identity was never read (the compose did not reach its Send/Save step)';
}

function joinNotes(...parts: Array<string | null | undefined>): string | undefined {
  const kept = parts.filter((s): s is string => !!s && !!s.trim());
  return kept.length ? kept.join('; ') : undefined;
}

/** Options shared by the three write verbs. */
export interface ComposeOptions {
  /**
   * Send-as identity. 🔴 MEASURED: the account carries 8 of them and the
   * compose does NOT default to the primary address — omitting this sends as
   * whatever Gmail picked, which is why the result always reports what was
   * ACTUALLY used.
   */
  from?: string;
  cc?: string;
  bcc?: string;
  /** Absolute paths on the machine running CHROME, not on the API host. */
  attachments?: string[];
}

/**
 * Compose and SEND a new message.
 *
 * `format` defaults to 'markdown' (rendered into real rich mail). The optional
 * 5th argument is deliberate: the pre-integration signature was
 * `(to, subject, body, format?)` and stays call-compatible.
 */
export async function sendMail(
  to: string,
  subject: string,
  body: string,
  format: Compose.MailFormat = 'markdown',
  opts: ComposeOptions = {},
): Promise<SendOutcome> {
  const recipients = splitAddresses(to);
  if (!recipients.length) throw new GmError('INVALID_RECIPIENT', 'to is required');

  const cc = splitAddresses(opts.cc ?? '');
  const bcc = splitAddresses(opts.bcc ?? '');

  // Policy BEFORE the browser: a hallucinated address must never reach the To
  // field, where Gmail's own chip behaviour becomes the only check.
  const policy = safety().checkRecipients([...recipients, ...cc, ...bcc]);
  if (!policy.allowed) throw new GmError('RECIPIENT_BLOCKED', policy.reason);

  const fp = safety().sendFingerprint({ to: recipients, cc, subject, body });
  const guard = safety().guardSend(fp);
  if (!guard.proceed) throw new GmError('DUPLICATE_SEND', guard.reason);

  const out = await op('send', async (cdp) => {
    const ctx = makeComposeCtx(cdp);
    const r = await Compose.composeAndSend(ctx, {
      to: recipients, cc, bcc, subject, body, format,
      attachments: opts.attachments,
      fromAlias: opts.from,
    });
    return { r, from: ctx.identity(), idNote: identityNote(ctx) };
  });

  safety().recordSend(fp, { threadId: null, at: Date.now() });
  const mismatch =
    opts.from && out.from && !out.from.includes(String(opts.from).toLowerCase().replace(/^.*<|>.*$/g, ''))
      ? `asked to send as "${opts.from}" but the compose reported "${out.from}"`
      : null;

  return {
    ok: true,
    to: recipients.join(', '),
    recipients,
    subject,
    from: out.from,
    verified: out.r.verified,
    note: joinNotes(out.r.note, out.idNote, mismatch),
  };
}

/**
 * Reply to an existing thread. `opts.all` picks reply vs reply-all EXPLICITLY —
 * ./compose refuses (REPLY_MODE_MISMATCH) rather than sending to the wrong set.
 */
export async function replyToThread(
  threadId: string,
  body: string,
  format: Compose.MailFormat = 'markdown',
  opts: ComposeOptions & { all?: boolean } = {},
): Promise<ReplyOutcome> {
  const id = requireThreadId(threadId);
  if (!String(body || '').trim()) throw new GmError('INVALID_BODY', 'body is required');

  // Recipients come from the thread, so the fingerprint keys on the thread. An
  // identical reply to the SAME thread inside the window is the duplicate this
  // catches; the same words to a different thread is not.
  const fp = safety().sendFingerprint({ to: [], subject: `thread:${id}`, body });
  const guard = safety().guardSend(fp);
  if (!guard.proceed) throw new GmError('DUPLICATE_SEND', guard.reason);

  const out = await op('send', async (cdp) => {
    const ctx = makeComposeCtx(cdp);
    const r = await Compose.replyToThread(ctx, id, body, {
      all: opts.all === true,
      format,
      attachments: opts.attachments,
    });
    return { r, from: ctx.identity(), idNote: identityNote(ctx) };
  });

  safety().recordSend(fp, { threadId: id, at: Date.now() });
  return {
    ok: true,
    threadId: id,
    mode: out.r.mode,
    from: out.from,
    verified: out.r.verified,
    note: joinNotes(out.r.note, out.idNote),
  };
}

/** Compose and SAVE AS DRAFT. Nothing is delivered, so this is a `mutate`, not a `send`. */
export async function draftMail(
  to: string,
  subject: string,
  body: string,
  format: Compose.MailFormat = 'markdown',
  opts: ComposeOptions = {},
): Promise<DraftOutcome> {
  const recipients = splitAddresses(to);
  const cc = splitAddresses(opts.cc ?? '');
  const bcc = splitAddresses(opts.bcc ?? '');
  if (recipients.length || cc.length || bcc.length) {
    const policy = safety().checkRecipients([...recipients, ...cc, ...bcc]);
    if (!policy.allowed) throw new GmError('RECIPIENT_BLOCKED', policy.reason);
  }

  const out = await op('mutate', async (cdp) => {
    const ctx = makeComposeCtx(cdp);
    const r = await Compose.composeDraft(ctx, {
      to: recipients, cc, bcc, subject, body, format,
      attachments: opts.attachments,
      fromAlias: opts.from,
    });
    return { r, from: ctx.identity(), idNote: identityNote(ctx) };
  });

  return {
    ok: true,
    to: recipients.join(', '),
    recipients,
    subject,
    draftId: out.r.draftId ?? null,
    from: out.from,
    verified: out.r.verified,
    note: joinNotes(out.r.note, out.idNote),
  };
}

/** Forward a thread to new recipients. */
export async function forwardThread(
  threadId: string,
  to: string,
  opts: { body?: string; format?: Compose.MailFormat } = {},
): Promise<Compose.ForwardResult> {
  const id = requireThreadId(threadId);
  const recipients = splitAddresses(to);
  if (!recipients.length) throw new GmError('INVALID_RECIPIENT', 'to is required');
  const policy = safety().checkRecipients(recipients);
  if (!policy.allowed) throw new GmError('RECIPIENT_BLOCKED', policy.reason);
  return op('send', (cdp) => Compose.forwardThread(makeComposeCtx(cdp), id, recipients, opts));
}

/** Saved drafts. `draftId` is the row's data-legacy-thread-id, NOT a Gmail API draft id. */
export async function listDrafts(limit = 25): Promise<Compose.DraftRow[]> {
  return op('read', (cdp) => Compose.listDrafts(makeComposeCtx(cdp), limit));
}

export async function sendDraft(draftId: string): Promise<Compose.SendDraftResult> {
  return op('send', (cdp) => Compose.sendDraft(makeComposeCtx(cdp), String(draftId || '').trim()));
}

export async function deleteDraft(draftId: string): Promise<Compose.DeleteDraftResult> {
  return op('mutate', (cdp) => Compose.deleteDraft(makeComposeCtx(cdp), String(draftId || '').trim()));
}

/**
 * Was this message ACTUALLY sent? Searches `in:sent` for it.
 *
 * The `SEND_UNCONFIRMED` case is the dangerous one — the message MAY have gone —
 * and this is the only honest way to close it out before a retry.
 */
export async function verifySent(subject: string, to: string, timeoutMs?: number): Promise<{ found: boolean; threadId: string | null; searched: string }> {
  return op('read', (cdp) => safety().verifyInSent(cdp, subject, to, timeoutMs ? { timeoutMs } : {}));
}

// ─── writes: labels ──────────────────────────────────────────────────────────
//
// Delegated to ./labels. Its own `GmError` is normalised by op() -> toGmError,
// so LABEL_NOT_FOUND / NOT_ON_GMAIL / THREAD_NOT_OPEN reach the caller intact.

export async function applyLabel(threadId: string, label: string): Promise<Labels.ApplyResult> {
  const id = requireThreadId(threadId);
  return op('mutate', (cdp) => Labels.applyLabel(cdp, id, label));
}

export async function removeLabel(threadId: string, label: string): Promise<Labels.RemoveResult> {
  const id = requireThreadId(threadId);
  return op('mutate', (cdp) => Labels.removeLabel(cdp, id, label));
}

export async function createLabel(name: string, opts?: { parent?: string }): Promise<Labels.CreateResult> {
  return op('mutate', (cdp) => Labels.createLabel(cdp, name, opts));
}

export async function moveToLabel(threadId: string, label: string): Promise<Labels.MoveResult> {
  const id = requireThreadId(threadId);
  return op('mutate', (cdp) => Labels.moveToLabel(cdp, id, label));
}

// ─── writes: thread verbs ────────────────────────────────────────────────────
//
// Delegated to ./actions, which owns the read-state-THEN-click discipline:
// 🔴 never blind-click a toggle, and re-query the star node after clicking
// because Gmail REPLACES it (a held reference reports a STALE aria-label).

export async function archiveThread(threadId: string): Promise<Actions.ActionResult> {
  const id = requireThreadId(threadId);
  return op('mutate', (cdp) => Actions.archiveThread(cdp, id));
}

export async function trashThread(threadId: string): Promise<Actions.ActionResult> {
  const id = requireThreadId(threadId);
  return op('mutate', (cdp) => Actions.trashThread(cdp, id));
}

export async function markRead(threadId: string, read: boolean): Promise<Actions.ActionResult> {
  const id = requireThreadId(threadId);
  return op('mutate', (cdp) => Actions.markRead(cdp, id, read));
}

export async function starThread(threadId: string, starred: boolean): Promise<Actions.ActionResult> {
  const id = requireThreadId(threadId);
  return op('mutate', (cdp) => Actions.starThread(cdp, id, starred));
}

export async function markSpam(threadId: string, spam: boolean): Promise<Actions.ActionResult> {
  const id = requireThreadId(threadId);
  return op('mutate', (cdp) => Actions.markSpam(cdp, id, spam));
}

export async function muteThread(threadId: string, muted: boolean): Promise<Actions.ActionResult> {
  const id = requireThreadId(threadId);
  return op('mutate', (cdp) => Actions.muteThread(cdp, id, muted));
}

export async function markImportant(threadId: string, important: boolean): Promise<Actions.ActionResult> {
  const id = requireThreadId(threadId);
  return op('mutate', (cdp) => Actions.markImportant(cdp, id, important));
}

export async function snoozeThread(
  threadId: string,
  until: 'tomorrow' | 'later-today' | 'next-week',
): Promise<Actions.ActionResult> {
  const id = requireThreadId(threadId);
  return op('mutate', (cdp) => Actions.snoozeThread(cdp, id, until));
}

/** Bulk triage, capped at BULK_MAX and run SEQUENTIALLY (one shared DOM). */
export async function bulkAction(
  threadIds: string[],
  action: 'archive' | 'trash' | 'read' | 'unread' | 'star' | 'unstar',
): Promise<Actions.BulkResult> {
  return op('mutate', (cdp) => Actions.bulkAction(cdp, threadIds, action));
}

// ─── keep-alive ──────────────────────────────────────────────────────────────

/**
 * Keep the session warm. The open SPA maintains its own realtime channel, so
 * this deliberately does NOT issue a heavy request (the mail entry point is
 * ~1.4 MB); it re-asserts the app is on a mail view and reports login state so
 * the keepalive timer can surface a DROPPED session, which is the actionable
 * signal.
 *
 * Not routed through op(): a background heartbeat must not consume the read
 * budget an operator's next call depends on, and it must not fail on a
 * temporarily unrecognised UI.
 */
export async function keepSessionWarm(): Promise<{ loggedIn: boolean; warmed: boolean; self: string | null }> {
  return withCdp(async (cdp) => {
    const st = await readStatusRaw(cdp);
    if (!st.loggedIn) return { loggedIn: false, warmed: false, self: st.self ?? null };
    let warmed = false;
    try {
      await gotoHash(cdp, '#inbox', SELECTORS.listReady, 8000);
      warmed = true;
    } catch {
      /* the view did not settle; the session is still logged in */
    }
    return { loggedIn: true, warmed, self: st.self ?? null };
  });
}

// ─── re-exports: ONE import surface for routes and tools ─────────────────────
//
// Types only — every VALUE a caller needs is a function above that owns its own
// session. Exporting the modules' raw `(cdp, …)` functions would hand callers a
// surface they cannot legally call, since they have no session to pass.

export type { SendAsIdentity } from './config';
export type { MailFormat, DraftRow, ForwardResult, SendDraftResult, DeleteDraftResult } from './compose';
export type { ApplyResult, RemoveResult, CreateResult, MoveResult, LabelInfo } from './labels';
export type { ActionResult, BulkResult } from './actions';
export type { SyncProgress, SyncOptions } from './sync';
export type { GmailAttachment, GmailThreadRowFull, GmailThreadFull } from './extractors';
export type { MimeMessage, MimeAddress, MimeAttachment } from './mime';
export { BULK_MAX } from './actions';
export { MAX_ATTACHMENT_TOTAL_BYTES, MAX_ATTACHMENT_COUNT } from './compose';
export { SELECTORS_EXT } from './extractors';
export { LABEL_SELECTORS } from './labels';
