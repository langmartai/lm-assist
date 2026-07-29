/**
 * Gmail CDP provider.
 *
 * Drives a logged-in mail.google.com session over the Chrome DevTools Protocol
 * (CDP). The companion login.ts launches a dedicated persistent-profile Chrome
 * at mail.google.com on port 9224 (config.resolveCdpBase()); the user logs in
 * once and the profile keeps the session.
 *
 * ── Why the DOM and not an internal endpoint (MEASURED 2026-07-29) ──────────
 * The obvious "drive Gmail's own JSON feeds" plan does not survive contact:
 *   - `/mail/u/0/h/` (basic HTML Gmail) is RETIRED — 200s, then redirects into
 *     the SPA.
 *   - `?ui=2&ik=<ik>&view=tl&rt=j` no longer returns JSON; it serves the ~1.4 MB
 *     SPA shell as text/html.
 *   - `/sync/u/0/i/fd` is binary protobuf (application/vnd.google.octet-stream-
 *     compressible) — an undocumented wire format, a project in itself.
 * Seeing the SPA call an endpoint is NOT evidence a third party can call it.
 * So this connector reads the rendered DOM, exactly like the LinkedIn one.
 *
 * ── DOM reality (verified live 2026-07-29) ──────────────────────────────────
 * Gmail keeps its long-stable legacy class names (`zA`, `zE`, `yX`, `y6`, `y2`,
 * `hP`, `adn ads`, `gD`, `g3`, `a3s aiL`) AND exposes real server ids as data
 * attributes (`data-legacy-thread-id`, `data-legacy-message-id`). That is
 * BETTER than LinkedIn, which has to key conversations on a display name.
 *
 * Navigation is hash-based (`#inbox`, `#search/<q>`, `#label/<name>`,
 * `#all/<threadId>`), so routing is deterministic and needs no UI choreography
 * — notably, SEARCH is a URL change, not typing into the search box.
 *
 * Like every virtualized list, the thread list renders a window of rows, so a
 * read returns the most-recent RENDERED threads. Ask for more with `limit`
 * (the client scrolls to force render) rather than expecting full history.
 *
 * All selectors + entry URLs are centralized in SELECTORS / URL_* below — fix
 * breakage THERE, never inline.
 */

import WebSocket from 'ws';
import { resolveCdpBase } from './config';

export class GmError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── surface URLs ─────────────────────────────────────────────────────────────

const ORIGIN = 'https://mail.google.com';
const MAIL_BASE = `${ORIGIN}/mail/u/0/`;

// ─── DOM selectors (single source of truth — verified live) ──────────────────

const SELECTORS = {
  /** Logged-in signal — any of the mail-app chrome. */
  appReady: 'input[name="q"], div[role="main"], tr.zA, [gh="tm"]',
  /** A thread-list row. Unread rows additionally carry `zE`. */
  threadRow: 'tr.zA',
  /** The list container being present means a list view rendered. */
  listReady: 'div[role="main"] table, tr.zA, .Cp',
  /** Open-thread signal: the subject header. */
  threadReady: 'h2.hP',
  /** Subject of the open thread. */
  threadSubject: 'h2.hP',
  /** One rendered (expanded) message inside an open thread. */
  msgItem: '.adn.ads',
  /** Sender chip inside a message — carries name= and email= attributes. */
  msgSender: '.gD, span[email]',
  /** Message timestamp — the full date is in title=. */
  msgDate: '.g3',
  /** Message body (rendered text). */
  msgBody: '.a3s.aiL, .a3s',
  /** "Expand all" button in a collapsed thread. */
  expandAll: '[aria-label="Expand all"], [data-tooltip="Expand all"]',
  /** Compose button. */
  composeBtn: '[gh="cm"]',
  /** Compose dialog fields. */
  composeTo: 'input[name="to"], textarea[name="to"]',
  composeSubject: 'input[name="subjectbox"]',
  composeBody: 'div[aria-label="Message Body"][role="textbox"], div[g_editable="true"][role="textbox"]',
  composeSend: 'div[role="button"][data-tooltip^="Send"], div[role="button"][aria-label^="Send"]',
  composeClose: '[aria-label="Save & close"], [aria-label="Save and close"]',
  /** Left-nav label links. */
  navLabel: 'div[role="navigation"] a[href*="#label/"]',
} as const;

/** Text used to find the Reply control inside an open thread. */
const REPLY_TEXTS = ['reply', 'reply all'];

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

interface Cdp {
  evaluate<T = unknown>(expr: string): Promise<T>;
  insertText(text: string): Promise<void>;
  navigate(url: string): Promise<void>;
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
        async insertText(text: string) {
          await send('Input.insertText', { text });
        },
        async navigate(url: string) {
          await send('Page.navigate', { url });
        },
        close() {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      };
      Promise.all([send('Runtime.enable'), send('Page.enable').catch(() => undefined)])
        .then(() => resolve(cdp))
        .catch(reject);
    });
  });
}

async function withCdp<T>(fn: (cdp: Cdp) => Promise<T>): Promise<T> {
  const base = resolveCdpBase();
  const wsUrl = await findPageWs(base);
  const cdp = await connect(wsUrl);
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
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

/** Throw unless the mail app is loaded and authenticated. */
async function assertLoggedIn(cdp: Cdp): Promise<void> {
  const st = await readStatus(cdp);
  if (!st.loggedIn) {
    throw new GmError('NOT_LOGGED_IN', 'the Gmail driver browser is not logged in — run gmail_login and finish the Google sign-in.');
  }
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

/**
 * Click an element IN-PAGE via `el.click()`. Gmail's controls are custom
 * `div[role=button]` widgets that respond to a synthetic in-page click; a CDP
 * coordinate click is both fragile and layout-dependent, so this is the default.
 */
async function clickSelector(cdp: Cdp, selector: string, what: string): Promise<void> {
  const ok = await cdp.evaluate<boolean>(
    `const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
     el.scrollIntoView({block:'center'}); await new Promise(r=>setTimeout(r,120)); el.click(); return true;`,
  );
  if (!ok) throw new GmError('ELEMENT_NOT_FOUND', `could not find ${what}`);
}

/** Click the first visible role=button/link whose trimmed text matches one of `texts`. */
async function clickByText(cdp: Cdp, texts: readonly string[], what: string): Promise<void> {
  const want = JSON.stringify(texts.map((t) => t.toLowerCase()));
  const ok = await cdp.evaluate<boolean>(
    `const want = ${want};
     const els = [...document.querySelectorAll('div[role="button"], span[role="link"], button, [role="link"]')];
     const el = els.find(x => { const r = x.getBoundingClientRect();
       const t = (x.textContent||'').replace(/\\s+/g,' ').trim().toLowerCase();
       return r.width > 0 && r.height > 0 && want.includes(t); });
     if (!el) return false; el.scrollIntoView({block:'center'});
     await new Promise(r=>setTimeout(r,120)); el.click(); return true;`,
  );
  if (!ok) throw new GmError('ELEMENT_NOT_FOUND', `could not find ${what}`);
}

/** Focus a field in-page so a following Input.insertText types into it. */
async function focusField(cdp: Cdp, selector: string, what: string): Promise<void> {
  const ok = await cdp.evaluate<boolean>(
    `const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
     el.scrollIntoView({block:'center'}); el.focus(); if (el.click) el.click(); return true;`,
  );
  if (!ok) throw new GmError('ELEMENT_NOT_FOUND', `could not find ${what}`);
}

/** Scroll the thread list until at least `want` rows have rendered (or it stops growing). */
async function ensureRows(cdp: Cdp, want: number): Promise<void> {
  let last = -1;
  for (let i = 0; i < 6; i++) {
    const n = await cdp.evaluate<number>(`return document.querySelectorAll(${JSON.stringify(SELECTORS.threadRow)}).length;`);
    if (n >= want || n === last) return;
    last = n;
    await cdp.evaluate(
      `const sc = document.querySelector('div[role="main"]') || document.scrollingElement;
       if (sc) sc.scrollBy(0, sc.clientHeight * 1.5); return true;`,
    );
    await sleep(900);
  }
}

// ─── page-side extraction snippets ───────────────────────────────────────────

const JS_STATUS = `
  const onMail = /(^|\\.)mail\\.google\\.com$/.test(location.hostname);
  const signin = /signin|ServiceLogin|AccountChooser/i.test(location.href);
  const app = !!document.querySelector(${JSON.stringify(SELECTORS.appReady)});
  let self = null;
  try { const g = window.GLOBALS && window.GLOBALS[10]; if (g && /@/.test(String(g))) self = String(g); } catch (e) {}
  return { loggedIn: onMail && !signin && app, self, url: location.href };`;

function jsThreadRows(limit: number): string {
  return `
  const rows = [...document.querySelectorAll(${JSON.stringify(SELECTORS.threadRow)})].slice(0, ${limit});
  return rows.map(tr => {
    const idEl = tr.querySelector('[data-legacy-thread-id]');
    const s = tr.querySelector('.yX span[email], span[email]');
    const subj = tr.querySelector('.y6 span');
    const snip = tr.querySelector('.y2');
    const when = tr.querySelector('td.xW span[title], span[title]');
    return {
      threadId: idEl ? idEl.getAttribute('data-legacy-thread-id') : null,
      unread: tr.classList.contains('zE'),
      fromEmail: s ? s.getAttribute('email') : null,
      fromName: s ? (s.getAttribute('name') || (s.textContent||'').trim() || null) : null,
      subject: subj ? (subj.textContent||'').trim() : null,
      snippet: snip ? (snip.textContent||'').replace(/^\\s*[-\\u2010-\\u2015]\\s*/, '').trim().slice(0, 200) : null,
      date: when ? when.getAttribute('title') : null
    };
  });`;
}

const JS_THREAD = `
  const out = { subject: null, url: location.href, messages: [] };
  const h = document.querySelector(${JSON.stringify(SELECTORS.threadSubject)});
  out.subject = h ? (h.textContent||'').trim() : null;
  for (const m of document.querySelectorAll(${JSON.stringify(SELECTORS.msgItem)})) {
    const s = m.querySelector(${JSON.stringify(SELECTORS.msgSender)});
    const b = m.querySelector(${JSON.stringify(SELECTORS.msgBody)});
    const d = m.querySelector(${JSON.stringify(SELECTORS.msgDate)});
    const holder = m.closest('[data-legacy-message-id]') || m.querySelector('[data-legacy-message-id]');
    out.messages.push({
      messageId: holder ? holder.getAttribute('data-legacy-message-id') : null,
      fromName: s ? s.getAttribute('name') : null,
      fromEmail: s ? s.getAttribute('email') : null,
      date: d ? d.getAttribute('title') : null,
      body: b ? (b.innerText||'').trim().slice(0, 20000) : ''
    });
  }
  return out;`;

const JS_LABELS = `
  const seen = new Set(); const out = [];
  for (const a of document.querySelectorAll(${JSON.stringify(SELECTORS.navLabel)})) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/#label\\/([^?&]+)/);
    if (!m) continue;
    const name = decodeURIComponent(m[1].replace(/\\+/g, ' '));
    if (seen.has(name)) continue; seen.add(name);
    const cnt = a.querySelector('.bsU, [aria-label*="unread"]');
    out.push({ name, unread: cnt ? (cnt.textContent||'').trim() : null });
  }
  return out;`;

// ─── public API ──────────────────────────────────────────────────────────────

export interface GmailStatus {
  loggedIn: boolean;
  self: string | null;
  url?: string;
}

export interface GmailThread {
  threadId: string | null;
  unread: boolean;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  snippet: string | null;
  date: string | null;
}

export interface GmailMessage {
  messageId: string | null;
  fromName: string | null;
  fromEmail: string | null;
  date: string | null;
  body: string;
}

export interface GmailThreadDetail {
  threadId: string;
  subject: string | null;
  url: string;
  messages: GmailMessage[];
}

export interface GmailLabel {
  name: string;
  unread: string | null;
}

async function readStatus(cdp: Cdp): Promise<GmailStatus> {
  return await cdp.evaluate<GmailStatus>(JS_STATUS);
}

/** Connector status: is the driver browser up and authenticated, and as whom. */
export async function cdpStatus(): Promise<GmailStatus> {
  return withCdp(async (cdp) => readStatus(cdp));
}

/** List threads in a mailbox view (`inbox` by default, or any label). */
export async function listThreads(opts: { limit?: number; label?: string } = {}): Promise<GmailThread[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));
  const label = (opts.label || 'inbox').trim();
  const hash = /^inbox$/i.test(label) ? '#inbox' : `#label/${encodeURIComponent(label)}`;
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    await gotoHash(cdp, hash, SELECTORS.listReady);
    await ensureRows(cdp, limit);
    return await cdp.evaluate<GmailThread[]>(jsThreadRows(limit));
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
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    await gotoHash(cdp, `#search/${encodeURIComponent(q)}`, SELECTORS.listReady);
    await ensureRows(cdp, n);
    return await cdp.evaluate<GmailThread[]>(jsThreadRows(n));
  });
}

/** Unread threads (a saved search — `is:unread`). */
export async function unreadThreads(limit = 25): Promise<GmailThread[]> {
  return searchThreads('is:unread', limit);
}

/** Open one thread and return its messages, expanding collapsed ones first. */
export async function readThread(threadId: string): Promise<GmailThreadDetail> {
  const id = String(threadId || '').trim();
  if (!id) throw new GmError('INVALID_THREAD', 'threadId is required');
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    // `#all/<id>` resolves both the legacy hex id and the newer permalink id.
    await gotoHash(cdp, `#all/${encodeURIComponent(id)}`, SELECTORS.threadReady);
    // Long threads render collapsed; expand so every message body is in the DOM.
    await cdp
      .evaluate(
        `const b = document.querySelector(${JSON.stringify(SELECTORS.expandAll)});
         if (b) { b.click(); await new Promise(r=>setTimeout(r,900)); } return true;`,
      )
      .catch(() => undefined);
    const d = await cdp.evaluate<{ subject: string | null; url: string; messages: GmailMessage[] }>(JS_THREAD);
    return { threadId: id, subject: d.subject, url: d.url, messages: d.messages };
  });
}

/** The label list from the left nav. */
export async function listLabels(): Promise<GmailLabel[]> {
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    await gotoHash(cdp, '#inbox', SELECTORS.listReady);
    return await cdp.evaluate<GmailLabel[]>(JS_LABELS);
  });
}

/** Fill the open compose dialog. Shared by send and draft. */
async function fillCompose(cdp: Cdp, to: string, subject: string, body: string): Promise<void> {
  const ready = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(SELECTORS.composeTo)})`, 15000);
  if (!ready) throw new GmError('COMPOSE_NOT_READY', 'the compose dialog did not open');

  await focusField(cdp, SELECTORS.composeTo, 'the To field');
  await cdp.insertText(to);
  await sleep(300);

  await focusField(cdp, SELECTORS.composeSubject, 'the Subject field');
  await cdp.insertText(subject);
  await sleep(300);

  await focusField(cdp, SELECTORS.composeBody, 'the message body');
  await cdp.insertText(body);
  await sleep(400);
}

/** Compose and SEND a new message. */
export async function sendMail(to: string, subject: string, body: string): Promise<{ ok: true; to: string; subject: string }> {
  if (!to.trim()) throw new GmError('INVALID_RECIPIENT', 'to is required');
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    await gotoHash(cdp, '#inbox', SELECTORS.listReady);
    await clickSelector(cdp, SELECTORS.composeBtn, 'the Compose button');
    await fillCompose(cdp, to.trim(), subject, body);
    await clickSelector(cdp, SELECTORS.composeSend, 'the Send button');
    // The dialog closing is the observable confirmation that Gmail accepted it.
    const closed = await waitFor(cdp, `!document.querySelector(${JSON.stringify(SELECTORS.composeTo)})`, 15000);
    if (!closed) throw new GmError('SEND_UNCONFIRMED', 'clicked Send but the compose dialog is still open — the message may not have been sent');
    return { ok: true as const, to: to.trim(), subject };
  });
}

/** Compose and SAVE AS DRAFT (closing the dialog is what persists the draft). */
export async function draftMail(to: string, subject: string, body: string): Promise<{ ok: true; to: string; subject: string }> {
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    await gotoHash(cdp, '#inbox', SELECTORS.listReady);
    await clickSelector(cdp, SELECTORS.composeBtn, 'the Compose button');
    await fillCompose(cdp, to.trim(), subject, body);
    await clickSelector(cdp, SELECTORS.composeClose, 'the Save & close button');
    await sleep(1200);
    return { ok: true as const, to: to.trim(), subject };
  });
}

/** Reply to an existing thread. */
export async function replyToThread(threadId: string, body: string): Promise<{ ok: true; threadId: string }> {
  const id = String(threadId || '').trim();
  if (!id) throw new GmError('INVALID_THREAD', 'threadId is required');
  if (!String(body || '').trim()) throw new GmError('INVALID_BODY', 'body is required');
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    await gotoHash(cdp, `#all/${encodeURIComponent(id)}`, SELECTORS.threadReady);
    await clickByText(cdp, REPLY_TEXTS, 'the Reply control');
    const ready = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(SELECTORS.composeBody)})`, 15000);
    if (!ready) throw new GmError('REPLY_NOT_READY', 'the reply editor did not open');
    await focusField(cdp, SELECTORS.composeBody, 'the reply body');
    await cdp.insertText(body);
    await sleep(400);
    await clickSelector(cdp, SELECTORS.composeSend, 'the Send button');
    const gone = await waitFor(cdp, `!document.querySelector(${JSON.stringify(SELECTORS.composeBody)})`, 15000);
    if (!gone) throw new GmError('SEND_UNCONFIRMED', 'clicked Send but the reply editor is still open — the reply may not have been sent');
    return { ok: true as const, threadId: id };
  });
}

/**
 * Keep the session warm. The open SPA maintains its own realtime channel, so
 * this deliberately does NOT issue a heavy request (the mail entry point is
 * ~1.4 MB); it re-asserts the app is on a mail view and reports login state so
 * the keepalive timer can surface a DROPPED session, which is the actionable
 * signal.
 */
export async function keepSessionWarm(): Promise<{ loggedIn: boolean; warmed: boolean; self: string | null }> {
  return withCdp(async (cdp) => {
    const st = await readStatus(cdp);
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
