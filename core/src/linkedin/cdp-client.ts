/**
 * LinkedIn CDP provider.
 *
 * Drives a logged-in linkedin.com session over the Chrome DevTools Protocol
 * (CDP) and mirrors messaging into the SHARED store (store.ts). LinkedIn spans
 * several surfaces (messaging, feed, notifications, share/article composers), so
 * each action NAVIGATES to the right surface, waits for it to render, then
 * scrapes / drives it.
 *
 * HOST: a Chromium logged into linkedin.com with a CDP debug port. The companion
 * login.ts launches a dedicated persistent-profile Chrome at linkedin.com on
 * port 9223 (config.resolveCdpBase()); the user logs in once and the profile
 * keeps the session.
 *
 * ── DOM reality (verified live 2026-07) ─────────────────────────────────────
 * LinkedIn ships TWO front-end generations at once:
 *   - MESSAGING + NOTIFICATIONS still use classic semantic classes
 *     (`msg-conversations-container__conversations-list`, `msg-s-message-list…`,
 *     `nt-card`).
 *   - FEED + global-nav + the share composer are the newer "SDUI" build with
 *     HASHED class names, so those surfaces are anchored on stable hooks that
 *     survive the hashing: ARIA labels/roles, `data-testid`, and href patterns.
 * All selectors + entry URLs are centralized in SELECTORS / URL_* below — fix
 * breakage THERE, never inline.
 *
 * Like WhatsApp Web, LinkedIn VIRTUALIZES its lists — only near-viewport rows
 * exist — so reads capture the most-recent RENDERED items; messaging reads
 * accumulate in the store across calls.
 *
 * Exports: cdpStatus, syncConversations, syncThread, sendMessage, readFeed,
 * readNotifications, createPost, publishArticle, canonicalChatId.
 */

import WebSocket from 'ws';
import { resolveCdpBase } from './config';
import * as store from './store';
import type { LiMessage } from './store';

const log = (...a: unknown[]) => console.error('[li-cdp]', ...a);

export class LiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── surface URLs ─────────────────────────────────────────────────────────────

const ORIGIN = 'https://www.linkedin.com';
const URL_MESSAGING = `${ORIGIN}/messaging/`;
const URL_FEED = `${ORIGIN}/feed/`;
const URL_NOTIFICATIONS = `${ORIGIN}/notifications/`;
const URL_SHAREBOX = `${ORIGIN}/preload/sharebox/`; // opens the feed-post composer
const URL_ARTICLE_NEW = `${ORIGIN}/article/new/`;

// ─── DOM selectors (single source of truth — verified live) ──────────────────

const SELECTORS = {
  /** Logged-in signal — the nav (data-testid survives SDUI hashing; the classic
   *  class + a feed link are fallbacks). The URL guard (not on login/checkpoint)
   *  is applied in JS_STATUS since the nav class re-renders intermittently. */
  loggedIn: '[data-testid="primary-nav"], .global-nav__primary-items, a[href*="/feed/"]',
  /** The signed-in user's own name (alt of the "Me" nav avatar). */
  selfPhoto: '.global-nav__me img, .global-nav__me-photo, img.global-nav__me-photo',

  // messaging — conversation list (classic classes)
  convListReady: 'ul.msg-conversations-container__conversations-list',
  convRow: 'ul.msg-conversations-container__conversations-list > li',
  convNameLabel: 'label[aria-label^="Select conversation with"]',
  convNameText: '.msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names',
  convSnippet: '.msg-conversation-card__message-snippet, .msg-conversation-listitem__message-snippet',

  // messaging — open thread (classic classes)
  threadReady: 'ul.msg-s-message-list-content',
  threadTitle: '#thread-detail-jump-target, .msg-entity-lockup__entity-title, .msg-thread__link-to-profile',
  msgItem: 'ul.msg-s-message-list-content .msg-s-event-listitem',
  msgGroup: '.msg-s-message-group',
  msgSender: '.msg-s-message-group__name',
  msgTime: 'time.msg-s-message-group__timestamp, time',
  msgBody: '.msg-s-event-listitem__body',
  msgOtherClass: 'msg-s-event-listitem--other', // present on INBOUND items only
  composeBox: 'div[role="textbox"][aria-label*="Write a message"], .msg-form__contenteditable',

  // feed (SDUI — ARIA/testid anchors)
  feedReady: '[data-testid="mainFeed"]',
  feedPostMenu: 'button[aria-label^="Open control menu for post by"]',
  feedText: '[data-testid="expandable-text-box"]',
  feedComment: 'button[aria-label="Comment"]',
  feedRepost: 'button[aria-label="Repost"]',

  // notifications (classic nt-card)
  notifReady: '.nt-card, main',
  notifCard: '.nt-card, article.nt-card',

  // feed-post composer (SDUI dialog reached via URL_SHAREBOX)
  postEditor: 'div.ql-editor[role="textbox"], [role="dialog"] div.ql-editor',

  // article editor
  articleTitle: 'textarea.article-editor-headline__textarea, textarea[placeholder="Title"]',
  articleBody: 'div[role="textbox"].ProseMirror, [aria-label="Article editor content"]',

  // profile page actions
  profileFollowBtn: 'button[aria-label^="Follow "]',
  profileConnectBtn: 'button[aria-label^="Invite "][aria-label*="connect" i], button[aria-label^="Connect"]',
  profileMessageBtn: 'button[aria-label^="Message "], a[aria-label^="Message "]',
  inviteSendNote: 'textarea[name="message"], #custom-message',

  // comment on a post (the editor is a TipTap ProseMirror, not Quill)
  commentBtn: 'button[aria-label="Comment"]',
  commentEditor: '[aria-label="Text editor for creating comment"], .comments-comment-box .ProseMirror, .tiptap.ProseMirror',

  // delete a post
  postControlMenu: 'button[aria-label^="Open control menu for post by"]',
} as const;

const URL_SEARCH_PEOPLE = `${ORIGIN}/search/results/people/?keywords=`;

/** A stable hash so synthesized message ids are idempotent by content. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Canonical conversation key: the trimmed participant name. */
export function canonicalChatId(nameOrId: unknown): string {
  return String(nameOrId ?? '').trim();
}

// ─── CDP session plumbing ────────────────────────────────────────────────────

/** Find the linkedin.com page target; return a ws URL host-matched to base. */
async function findPageWs(base: string): Promise<string> {
  let list: unknown;
  try {
    const res = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(8000) });
    list = await res.json();
  } catch (e) {
    throw new LiError('CDP_UNREACHABLE', `cannot reach CDP at ${base}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const pages = (Array.isArray(list) ? list : []).filter(
    (t: { type?: string; url?: string }) => t.type === 'page',
  ) as Array<{ url?: string; webSocketDebuggerUrl?: string }>;
  const page = pages.find((t) => /linkedin\.com/.test(t.url || '')) || pages[0];
  if (!page || !page.webSocketDebuggerUrl) {
    throw new LiError('PAGE_NOT_FOUND', 'no driveable page found on this CDP endpoint (is the LinkedIn login browser running?)');
  }
  const baseHost = new URL(base).host;
  return String(page.webSocketDebuggerUrl).replace(/^ws:\/\/[^/]+/, `ws://${baseHost}`);
}

interface Cdp {
  evaluate<T = unknown>(expr: string): Promise<T>;
  click(x: number, y: number): Promise<void>;
  insertText(text: string): Promise<void>;
  pressEnter(): Promise<void>;
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
      reject(new LiError('CDP_UNREACHABLE', 'CDP websocket connect timeout'));
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
        if (m.error) rej(new LiError('CDP_ERROR', JSON.stringify(m.error)));
        else res(m.result);
      }
    });
    ws.on('error', (e: Error) => {
      clearTimeout(to);
      reject(new LiError('CDP_UNREACHABLE', String(e.message || e)));
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
          // A navigation can destroy the execution context mid-evaluate ("Promise
          // was collected" / "Cannot find context" / "context was destroyed").
          // That is transient — retry once after letting the new context settle.
          let lastErr: unknown;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const r = (await send('Runtime.evaluate', {
                expression: `(async()=>{${expr}})()`,
                awaitPromise: true,
                returnByValue: true,
              })) as { exceptionDetails?: { exception?: { description?: string } }; result?: { value?: T } };
              if (r.exceptionDetails) {
                throw new LiError('PAGE_EVAL_ERROR', r.exceptionDetails.exception?.description || 'page eval error');
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
        async click(x: number, y: number) {
          const b = { x, y, button: 'left', clickCount: 1 };
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...b });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...b });
        },
        async insertText(text: string) {
          await send('Input.insertText', { text });
        },
        async pressEnter() {
          // A keyDown that CARRIES `text` is what makes Chromium synthesize the
          // keypress/char for the page. Two things were wrong here:
          //   - `rawKeyDown` is by definition "keydown that generates no character",
          //     and CDP documents `text` as "not needed for keyUp and rawKeyDown";
          //   - the separate `type:'char'` event is a 2016-era recipe that neither
          //     Puppeteer nor Playwright has emitted in years. Both use exactly
          //     `type: text ? 'keyDown' : 'rawKeyDown'`.
          // utils/browser-control.ts in this same repo already sends the correct
          // keyDown/keyUp pair, so this was also an internal inconsistency.
          const k = { windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', location: 0 };
          await send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...k });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
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

// ─── navigation + click helpers ───────────────────────────────────────────────

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
 * Ensure the page is on `url` and `readySel` rendered. When `force`, always
 * re-navigates (used for the composer surfaces that must start clean).
 */
async function goto(cdp: Cdp, url: string, readySel: string, opts: { force?: boolean; timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const sel = JSON.stringify(readySel);
  const path = url.replace(ORIGIN, '').replace(/\?.*$/, '');
  const already = opts.force
    ? false
    : await cdp.evaluate<boolean>(`return location.href.indexOf(${JSON.stringify(path)}) >= 0 && !!document.querySelector(${sel});`);
  if (!already) {
    await cdp.navigate(url);
    await sleep(1000);
  }
  const ready = await waitFor(cdp, `!!document.querySelector(${sel})`, timeoutMs);
  if (!ready) throw new LiError('PAGE_NOT_READY', `timed out waiting for ${url} to render (${readySel})`);
  await sleep(500);
}

/**
 * Click an element IN-PAGE via `el.click()`. LinkedIn's React/artdeco buttons
 * (Follow, Connect, More, menu items, Post, Send, Next, Publish) respond to a
 * synthetic in-page click but NOT to a CDP coordinate click, so this is the
 * default for buttons. (Text CARET placement still uses focus + Input.insertText.)
 */
async function clickSelector(cdp: Cdp, selector: string, what: string): Promise<void> {
  const ok = await cdp.evaluate<boolean>(
    `const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({block:'center'}); await new Promise(r=>setTimeout(r,120)); el.click(); return true;`,
  );
  if (!ok) throw new LiError('ELEMENT_NOT_FOUND', `could not find ${what}`);
}

/** Click the first ENABLED, visible button whose trimmed text equals `text`. */
async function clickButtonByText(cdp: Cdp, text: string, what: string): Promise<void> {
  const want = JSON.stringify(text.toLowerCase());
  const ok = await cdp.evaluate<boolean>(
    `const b=[...document.querySelectorAll('button')].find(x=>!x.disabled && x.getBoundingClientRect().width>0 && (x.textContent||'').trim().toLowerCase()===${want}); if(!b) return false; b.scrollIntoView({block:'center'}); await new Promise(r=>setTimeout(r,120)); b.click(); return true;`,
  );
  if (!ok) throw new LiError('ELEMENT_NOT_FOUND', `could not find ${what} (button "${text}")`);
}

/**
 * Click the first visible element (button/menuitem/link/div) inside an OPEN
 * dropdown/dialog whose trimmed text starts with `text`. Used for menu actions
 * (Connect, Delete post, Send without a note) that are not plain <button> text.
 */
async function clickMenuItem(cdp: Cdp, text: string, what: string): Promise<void> {
  const want = JSON.stringify(text.toLowerCase());
  const ok = await cdp.evaluate<boolean>(
    `const els=[...document.querySelectorAll('[role="menuitem"], .artdeco-dropdown__content [role="button"], [role="menu"] *, [role="dialog"] button, [role="dialog"] [role="button"]')];
     const el=els.find(x=>{const r=x.getBoundingClientRect(); const t=(x.textContent||'').replace(/\\s+/g,' ').trim().toLowerCase(); return r.width>0 && r.height>0 && (t===${want} || t.startsWith(${want}));});
     if(!el) return false; el.scrollIntoView({block:'center'}); await new Promise(r=>setTimeout(r,120)); el.click(); return true;`,
  );
  if (!ok) throw new LiError('ELEMENT_NOT_FOUND', `could not find ${what} ("${text}")`);
}

/** Focus a text editor in-page (so a following Input.insertText types into it). */
async function focusEditor(cdp: Cdp, selector: string, what: string): Promise<void> {
  const ok = await cdp.evaluate<boolean>(
    `const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return false; el.scrollIntoView({block:'center'}); el.focus(); if(el.click) el.click(); return true;`,
  );
  if (!ok) throw new LiError('ELEMENT_NOT_FOUND', `could not find ${what}`);
}

/** Resolve a profile URL from a handle, a /in/ URL, or a people-search by name. */
async function resolveProfileUrl(cdp: Cdp, target: string): Promise<string> {
  const t = target.trim();
  if (/^https?:\/\/.*linkedin\.com\/in\//i.test(t)) return t.split('?')[0];
  if (/^[\w-]+$/.test(t)) return `${ORIGIN}/in/${t}/`; // a bare handle
  // else treat as a name → people search, take the first result
  const results = await searchPeople(t, 1);
  if (!results.length) throw new LiError('PROFILE_NOT_FOUND', `no LinkedIn profile found for "${target}"`);
  return results[0].url;
}

// ─── page-side snippets ───────────────────────────────────────────────────────

const JS_STATUS = `
  const onLogin = /\\/(login|uas|checkpoint|authwall|signup)/.test(location.pathname);
  const loggedIn = !onLogin && !!document.querySelector(${JSON.stringify(SELECTORS.loggedIn)});
  let self = null;
  const me = document.querySelector(${JSON.stringify(SELECTORS.selfPhoto)});
  if (me) self = me.getAttribute('alt') || null;
  return { loggedIn, self };
`;

/** Scrape the rendered conversation list. */
const JS_CONVERSATIONS = `
  const rows = [...document.querySelectorAll(${JSON.stringify(SELECTORS.convRow)})];
  return rows.map(row => {
    const label = row.querySelector(${JSON.stringify(SELECTORS.convNameLabel)});
    let name = label ? (label.getAttribute('aria-label')||'').replace(/^Select conversation with\\s*/i,'').trim() : '';
    if (!name) { const nEl = row.querySelector(${JSON.stringify(SELECTORS.convNameText)}); name = nEl ? nEl.textContent.trim() : ''; }
    const snipEl = row.querySelector(${JSON.stringify(SELECTORS.convSnippet)});
    const snippet = snipEl ? snipEl.textContent.trim() : '';
    const timeEl = row.querySelector('time');
    const timeLabel = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent.trim()) : '';
    return { name, snippet, timeLabel };
  }).filter(r => r.name);
`;

/** Locate a conversation row by participant name; return click xy. */
function jsLocateConversation(target: string): string {
  const want = JSON.stringify(target.toLowerCase());
  return `
    const want = ${want};
    const rows = [...document.querySelectorAll(${JSON.stringify(SELECTORS.convRow)})];
    let match = null;
    for (const row of rows) {
      const label = row.querySelector(${JSON.stringify(SELECTORS.convNameLabel)});
      let name = label ? (label.getAttribute('aria-label')||'').replace(/^Select conversation with\\s*/i,'').trim() : '';
      if (!name) { const nEl = row.querySelector(${JSON.stringify(SELECTORS.convNameText)}); name = nEl ? nEl.textContent.trim() : ''; }
      const low = name.toLowerCase();
      if (low === want || (low && low.indexOf(want) >= 0)) { match = row; break; }
    }
    if (!match) return { ok:false };
    match.scrollIntoView({block:'center'});
    await new Promise(r=>setTimeout(r,150));
    const r = match.getBoundingClientRect();
    return { ok:true, x: r.left + r.width/2, y: r.top + r.height/2 };
  `;
}

/** Read the rendered messages of the open thread (direction via --other class). */
function jsReadThread(n: number): string {
  return `
    const titleEl = document.querySelector(${JSON.stringify(SELECTORS.threadTitle)});
    const header = titleEl ? titleEl.textContent.trim().split('\\n')[0] : null;
    const items = [...document.querySelectorAll(${JSON.stringify(SELECTORS.msgItem)})];
    const out = [];
    for (const it of items) {
      const bodyEl = it.querySelector(${JSON.stringify(SELECTORS.msgBody)});
      const text = bodyEl ? bodyEl.innerText.trim() : '';
      if (!text) continue;
      const group = it.closest(${JSON.stringify(SELECTORS.msgGroup)});
      const senderEl = group ? group.querySelector(${JSON.stringify(SELECTORS.msgSender)}) : null;
      const sender = senderEl ? senderEl.textContent.trim() : null;
      const timeEl = group ? group.querySelector(${JSON.stringify(SELECTORS.msgTime)}) : it.querySelector('time');
      const timeLabel = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent.trim()) : null;
      const inbound = it.classList.contains(${JSON.stringify(SELECTORS.msgOtherClass)}) || !!it.querySelector('.' + ${JSON.stringify(SELECTORS.msgOtherClass)});
      out.push({ sender, timeLabel, text, direction: inbound ? 'in' : 'out' });
    }
    return { header, messages: out.slice(-${n}) };
  `;
}

/** Scrape rendered feed posts (SDUI — anchored on the control-menu button). */
function jsReadFeed(n: number): string {
  return `
    const menus = [...document.querySelectorAll(${JSON.stringify(SELECTORS.feedPostMenu)})];
    const out = [];
    for (const btn of menus) {
      const actor = (btn.getAttribute('aria-label')||'').replace(/^Open control menu for post by\\s*/i,'').trim();
      let node = btn;
      for (let i=0;i<12 && node;i++){ node = node.parentElement; if (node && node.querySelector(${JSON.stringify(SELECTORS.feedText)})) break; }
      const textEl = node ? node.querySelector(${JSON.stringify(SELECTORS.feedText)}) : null;
      const text = textEl ? textEl.innerText.replace(/\\s+/g,' ').trim() : '';
      const cmt = node ? node.querySelector(${JSON.stringify(SELECTORS.feedComment)}) : null;
      const rep = node ? node.querySelector(${JSON.stringify(SELECTORS.feedRepost)}) : null;
      if (!actor && !text) continue;
      out.push({ actor, text, comments: cmt ? cmt.textContent.trim() : '', reposts: rep ? rep.textContent.trim() : '' });
    }
    return out.slice(0, ${n});
  `;
}

/** Scrape rendered notifications (classic nt-card). */
function jsReadNotifications(n: number): string {
  return `
    const cards = [...document.querySelectorAll(${JSON.stringify(SELECTORS.notifCard)})];
    const out = [];
    for (const c of cards) {
      let text = (c.innerText||'').replace(/\\s+/g,' ').trim();
      const unread = /unread/i.test(c.className) || /^Unread notification/i.test(text);
      text = text.replace(/^Unread notification\\.?\\s*/i,'');
      const timeEl = c.querySelector('time');
      const timeLabel = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent.trim()) : '';
      if (!text) continue;
      out.push({ text: text.slice(0, 240), timeLabel, unread });
    }
    return out.slice(0, ${n});
  `;
}

// ─── time parsing ─────────────────────────────────────────────────────────────

/** Parse a LinkedIn time label — an ISO datetime attr, a clock, a weekday, or a date. */
function parseTimeLabel(label: string | null, fallback: number): number {
  const t = String(label || '').trim();
  if (!t) return fallback;
  if (/\d{4}-\d{2}-\d{2}|T\d{2}:/.test(t)) {
    const iso = new Date(t);
    if (!isNaN(iso.getTime())) return Math.floor(iso.getTime() / 1000);
  }
  const now = new Date();
  const hm = t.match(/^(\d{1,2}):(\d{2})/);
  if (hm) {
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +hm[1], +hm[2], 0);
    return Math.floor(dt.getTime() / 1000);
  }
  // relative labels: "2h", "3d", "1w", "5m", "1mo"
  const rel = t.match(/^(\d+)\s*(mo|m|min|h|hr|hour|d|day|w|week)/i);
  if (rel) {
    const nnum = +rel[1];
    const unit = rel[2].toLowerCase();
    const secs = unit === 'mo' ? nnum * 2592000
      : unit.startsWith('m') ? nnum * 60
      : unit.startsWith('h') ? nnum * 3600
      : unit.startsWith('d') ? nnum * 86400
      : unit.startsWith('w') ? nnum * 604800
      : 0;
    return Math.floor(Date.now() / 1000) - secs;
  }
  // "Jul 1", "Jun 27", weekday names, or a full date — Date can parse most
  const parsed = new Date(/^[A-Za-z]{3}\s+\d/.test(t) ? `${t} ${now.getFullYear()}` : t);
  if (!isNaN(parsed.getTime())) return Math.floor(parsed.getTime() / 1000);
  return fallback;
}

// ─── public provider API ─────────────────────────────────────────────────────

export interface CdpStatus {
  loggedIn: boolean;
  self: string | null;
}

async function assertLoggedIn(cdp: Cdp): Promise<string | null> {
  const s = await cdp.evaluate<CdpStatus>(JS_STATUS);
  if (!s || !s.loggedIn) {
    throw new LiError('NOT_LOGGED_IN', 'LinkedIn is not logged in / not ready on the driver browser');
  }
  return s.self ?? null;
}

/** CDP reachability + logged-in state (+ best-effort self identity). */
export async function cdpStatus(): Promise<CdpStatus> {
  return withCdp(async (cdp) => {
    const s = await cdp.evaluate<CdpStatus>(JS_STATUS);
    return { loggedIn: !!s?.loggedIn, self: s?.self ?? null };
  });
}

/**
 * Ingest the currently-rendered conversation list into the store. Each row
 * becomes one synthesized (idempotent-by-id) LiMessage carrying the last-message
 * snippet so store.listChats() has a row per conversation. Returns the count.
 */
export async function syncConversations(): Promise<{ chats: number; ingested: number }> {
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    await goto(cdp, URL_MESSAGING, SELECTORS.convListReady);
    const rows = await cdp.evaluate<Array<{ name: string; snippet: string; timeLabel: string }>>(JS_CONVERSATIONS);
    const list = Array.isArray(rows) ? rows : [];
    let ingested = 0;
    const now = Math.floor(Date.now() / 1000);
    list.forEach((r, i) => {
      const chatId = canonicalChatId(r.name);
      if (!chatId) return;
      const ts = parseTimeLabel(r.timeLabel, now - i);
      const text = r.snippet || '';
      const id = `li-${chatId}-preview-${hash(`${ts}|${text}`)}`;
      store.addInbound({
        id,
        chatId,
        direction: 'in',
        from: r.name,
        type: 'text',
        text,
        timestamp: ts,
        contactName: r.name,
      });
      ingested++;
    });
    return { chats: list.length, ingested };
  });
}

/**
 * Open the conversation for `target` (participant name) and ingest its rendered
 * messages into the store, keyed by the name so store.getMessages(target)
 * matches. Returns { chatId, ingested }.
 */
export async function syncThread(
  target: string,
): Promise<{ chatId: string; contactName: string | null; ingested: number }> {
  const key = canonicalChatId(target);
  if (!key) throw new LiError('BAD_REQUEST', 'conversation identifier is required');
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    await goto(cdp, URL_MESSAGING, SELECTORS.convListReady);
    const loc = await cdp.evaluate<{ ok: boolean; x?: number; y?: number }>(jsLocateConversation(target));
    if (!loc || !loc.ok) throw new LiError('CHAT_NOT_FOUND', `conversation not found: ${target}`);
    await cdp.click(loc.x!, loc.y!);
    await waitFor(cdp, `!!document.querySelector(${JSON.stringify(SELECTORS.threadReady)})`, 12000);
    await sleep(800);
    const r = await cdp.evaluate<{
      header: string | null;
      messages: Array<{ sender: string | null; timeLabel: string | null; text: string; direction: 'in' | 'out' }>;
    }>(jsReadThread(200));
    const contactName = r?.header || null;
    const chatId = key;
    const msgs = (r?.messages || []).filter((m) => m && m.text);
    let ingested = 0;
    const now = Math.floor(Date.now() / 1000);
    msgs.forEach((m, i) => {
      const fallback = now - (msgs.length - i);
      const ts = parseTimeLabel(m.timeLabel, fallback);
      const id = `li-${chatId}-${ts}-${hash(`${m.direction}|${m.text}`)}`;
      const rec: LiMessage = {
        id,
        chatId,
        direction: m.direction,
        from: m.direction === 'out' ? 'me' : m.sender || chatId,
        to: m.direction === 'out' ? chatId : undefined,
        type: 'text',
        text: m.text,
        timestamp: ts,
        contactName: contactName || undefined,
      };
      if (m.direction === 'out') store.addOutbound(rec);
      else store.addInbound(rec);
      ingested++;
    });
    return { chatId, contactName, ingested };
  });
}

/**
 * Open the conversation for `to` and send `text`. Returns a synthetic message
 * id; the caller records the outbound message in the store.
 */
export async function sendMessage(
  to: string,
  text: string,
): Promise<{ messageId: string; chatId: string; contactName: string | null }> {
  if (!to) throw new LiError('BAD_REQUEST', '`to` is required');
  if (!text) throw new LiError('BAD_REQUEST', '`text` is required');
  const chatId = canonicalChatId(to);
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    await goto(cdp, URL_MESSAGING, SELECTORS.convListReady);
    const loc = await cdp.evaluate<{ ok: boolean; x?: number; y?: number }>(jsLocateConversation(to));
    if (!loc || !loc.ok) throw new LiError('CHAT_NOT_FOUND', `conversation not found: ${to}`);
    await cdp.click(loc.x!, loc.y!);
    await waitFor(cdp, `!!document.querySelector(${JSON.stringify(SELECTORS.composeBox)})`, 12000);
    await sleep(600);
    const header = await cdp.evaluate<string | null>(
      `const t = document.querySelector(${JSON.stringify(SELECTORS.threadTitle)}); return t ? t.textContent.trim().split('\\n')[0] : null;`,
    );
    await focusEditor(cdp, SELECTORS.composeBox, 'the message compose box');
    await sleep(300);
    await cdp.insertText(String(text));
    await sleep(400);
    // Prefer the Send button; fall back to Enter (LinkedIn sends on Enter).
    try {
      await clickButtonByText(cdp, 'Send', 'the Send button');
    } catch {
      await cdp.pressEnter();
    }
    await sleep(600);
    const messageId = `out-${Math.floor(Date.now() / 1000)}-${chatId}-${hash(text)}`;
    return { messageId, chatId, contactName: header || null };
  });
}

export interface FeedPost {
  actor: string;
  text: string;
  reactions: string;
  comments: string;
}

/** Live-scrape the most-recent rendered feed posts (scrolls to load a few). */
export async function readFeed(limit = 15): Promise<FeedPost[]> {
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    await goto(cdp, URL_FEED, SELECTORS.feedReady);
    // The feed is virtualized — scroll a few times to render up to ~limit posts.
    for (let i = 0; i < 6; i++) {
      const count = await cdp.evaluate<number>(
        `return document.querySelectorAll(${JSON.stringify(SELECTORS.feedPostMenu)}).length;`,
      );
      if (count >= limit) break;
      await cdp.evaluate('window.scrollBy(0, window.innerHeight * 1.5); return true;');
      await sleep(900);
    }
    const posts = await cdp.evaluate<Array<{ actor: string; text: string; comments: string; reposts: string }>>(jsReadFeed(limit));
    return (Array.isArray(posts) ? posts : []).map((p) => ({
      actor: p.actor,
      text: p.text,
      reactions: '',
      comments: p.comments,
    }));
  });
}

export interface Notification {
  text: string;
  timeLabel: string;
  unread: boolean;
}

/** Live-scrape the most-recent rendered notifications (not persisted). */
export async function readNotifications(limit = 20): Promise<Notification[]> {
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    await goto(cdp, URL_NOTIFICATIONS, SELECTORS.notifReady);
    await sleep(1000);
    const items = await cdp.evaluate<Notification[]>(jsReadNotifications(limit));
    return Array.isArray(items) ? items : [];
  });
}

/**
 * Publish a feed post with `text`. Opens the share composer (via URL), types the
 * body, waits for the Post button to enable, and clicks it. Returns { ok }.
 */
export async function createPost(text: string): Promise<{ ok: true }> {
  if (!text || !text.trim()) throw new LiError('BAD_REQUEST', '`text` is required');
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    await goto(cdp, URL_SHAREBOX, SELECTORS.postEditor, { force: true, timeoutMs: 20000 });
    await sleep(500);
    await clickSelector(cdp, SELECTORS.postEditor, 'the post editor');
    await sleep(250);
    await cdp.insertText(String(text));
    await sleep(500);
    // Wait for the "Post" button to enable, then click it.
    const enabled = await waitFor(cdp, `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim().toLowerCase()==='post'); return b && !b.disabled; })()`, 8000);
    if (!enabled) throw new LiError('POST_DISABLED', 'the Post button did not enable (empty content?)');
    await clickButtonByText(cdp, 'Post', 'the Post button');
    await sleep(1500);
    return { ok: true };
  });
}

/**
 * Publish a long-form Article (title + body). Navigates to the article editor,
 * fills the headline (textarea) + body (ProseMirror), then drives Next → Publish.
 * Returns { ok }.
 */
export async function publishArticle(title: string, body: string): Promise<{ ok: true }> {
  if (!title || !title.trim()) throw new LiError('BAD_REQUEST', '`title` is required');
  if (!body || !body.trim()) throw new LiError('BAD_REQUEST', '`body` is required');
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    await goto(cdp, URL_ARTICLE_NEW, SELECTORS.articleTitle, { force: true, timeoutMs: 25000 });
    await sleep(800);
    await clickSelector(cdp, SELECTORS.articleTitle, 'the article title field');
    await sleep(250);
    await cdp.insertText(String(title));
    await sleep(400);
    await clickSelector(cdp, SELECTORS.articleBody, 'the article body editor');
    await sleep(250);
    await cdp.insertText(String(body));
    await sleep(500);
    // Two-step publish: "Next" opens the publish dialog, then "Publish" confirms.
    await clickButtonByText(cdp, 'Next', 'the Next button');
    const publishUp = await waitFor(
      cdp,
      `!!([...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim().toLowerCase()==='publish'))`,
      12000,
    );
    if (!publishUp) throw new LiError('PUBLISH_NOT_READY', 'the Publish dialog did not appear after Next');
    await sleep(500);
    await clickButtonByText(cdp, 'Publish', 'the Publish button');
    await sleep(2000);
    return { ok: true };
  });
}

// ─── people search + profile actions ─────────────────────────────────────────

export interface PersonResult {
  name: string;
  handle: string;
  url: string;
  headline: string;
}

/** Search LinkedIn people by name/keywords; returns the top profiles. */
export async function searchPeople(query: string, limit = 8): Promise<PersonResult[]> {
  const q = String(query || '').trim();
  if (!q) throw new LiError('BAD_REQUEST', 'search query is required');
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    await goto(cdp, `${URL_SEARCH_PEOPLE}${encodeURIComponent(q)}`, 'a[href*="/in/"]', { force: true, timeoutMs: 15000 });
    await sleep(1200);
    const rows = await cdp.evaluate<PersonResult[]>(`
      const links = [...document.querySelectorAll('a[href*="/in/"]')];
      const seen = new Set(); const out = [];
      for (const a of links) {
        const href = (a.getAttribute('href')||'').split('?')[0];
        const m = href.match(/\\/in\\/([^/]+)/); if (!m) continue;
        const handle = m[1]; if (seen.has(handle)) continue;
        let name = (a.innerText||'').replace(/\\s+/g,' ').trim();
        if (!name) continue;
        // strip the "• 3rd+ headline…" tail LinkedIn appends into the link text
        name = name.split('•')[0].replace(/View .*profile/i,'').trim();
        if (!name) continue;
        seen.add(handle);
        // headline: the sibling text near the result
        let headline = '';
        const card = a.closest('li') || a.parentElement;
        if (card) { const hl = card.querySelector('.entity-result__primary-subtitle, .t-14.t-black--light'); headline = hl ? hl.textContent.replace(/\\s+/g,' ').trim() : ''; }
        out.push({ name: name.slice(0,60), handle, url: href.indexOf('http')===0 ? href : ('${ORIGIN}'+href), headline: headline.slice(0,80) });
        if (out.length >= ${limit}) break;
      }
      return out;
    `);
    return Array.isArray(rows) ? rows : [];
  });
}

/**
 * Open the profile action-bar "More" dropdown. The action-bar More lives inside
 * <main> (the global-nav "More" does NOT), so scope there — robust regardless of
 * the primary action being Follow / Following / Message / Connect.
 */
async function openProfileMore(cdp: Cdp): Promise<boolean> {
  return !!(await cdp.evaluate<boolean>(`
    const more = [...document.querySelectorAll('main button')].find(b=>/^more$/i.test((b.textContent||'').trim()) && b.getBoundingClientRect().width>0);
    if (!more) return false; more.scrollIntoView({block:'center'}); more.click(); return true;
  `));
}

/** Follow a person (target = handle, /in/ URL, or a name to search). */
export async function followProfile(target: string): Promise<{ ok: true; following: boolean; alreadyFollowing: boolean }> {
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    const url = await resolveProfileUrl(cdp, target);
    await goto(cdp, url, 'main', { force: true, timeoutMs: 15000 });
    await sleep(1000);
    const hasFollow = await cdp.evaluate<boolean>(`return !!document.querySelector(${JSON.stringify(SELECTORS.profileFollowBtn)});`);
    if (!hasFollow) {
      const already = await cdp.evaluate<boolean>(`return !!document.querySelector('button[aria-label^="Unfollow "], button[aria-label^="Following"]');`);
      return { ok: true, following: already, alreadyFollowing: already };
    }
    await clickSelector(cdp, SELECTORS.profileFollowBtn, 'the Follow button');
    await sleep(1500);
    const following = await cdp.evaluate<boolean>(`return !!document.querySelector('button[aria-label^="Unfollow "], button[aria-label^="Following"]') || !document.querySelector(${JSON.stringify(SELECTORS.profileFollowBtn)});`);
    return { ok: true, following, alreadyFollowing: false };
  });
}

/**
 * Send a connection request (target = handle, /in/ URL, or a name to search).
 *
 * The profile's "Connect" action (whether a primary button or under "More") is
 * an `<a href="/preload/custom-invite/?vanityName=<handle>">`. The synthetic
 * click doesn't SPA-navigate reliably, so — like the share composer — we open
 * that invite URL directly; it renders the "Add a note to your invitation?"
 * modal with "Send without a note" / "Add a note". Returns { ok, state }.
 */
export async function connectProfile(target: string, note?: string): Promise<{ ok: true; state: string }> {
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    const url = await resolveProfileUrl(cdp, target);
    const handle = (url.match(/\/in\/([^/]+)/) || [])[1];
    if (!handle) throw new LiError('BAD_REQUEST', `could not resolve a profile handle from "${target}"`);

    // Already pending/connected? (check the profile action bar first.)
    await goto(cdp, url, 'main', { force: true, timeoutMs: 15000 });
    await sleep(800);
    const pending = await cdp.evaluate<boolean>(`return !!document.querySelector('button[aria-label^="Pending"], button[aria-label*="Withdraw" i]');`);
    if (pending) return { ok: true, state: 'already-pending' };

    // Open the invitation modal directly.
    await cdp.navigate(`${ORIGIN}/preload/custom-invite/?vanityName=${encodeURIComponent(handle)}`);
    const up = await waitFor(
      cdp,
      `[...document.querySelectorAll('button')].some(b=>b.getBoundingClientRect().width>0 && /^(send without a note|send|add a note)$/i.test((b.textContent||'').trim()))`,
      12000,
    );
    if (!up) throw new LiError('CONNECT_UNAVAILABLE', 'the invitation modal did not open (already connected, invite limit reached, or restricted).');
    await sleep(700);

    if (note && note.trim()) {
      await clickButtonByText(cdp, 'Add a note', 'the Add a note button');
      await sleep(700);
      await focusEditor(cdp, SELECTORS.inviteSendNote, 'the invitation note box');
      await cdp.insertText(note.trim().slice(0, 300));
      await sleep(400);
      await clickButtonByText(cdp, 'Send', 'the Send invitation button');
    } else {
      try {
        await clickButtonByText(cdp, 'Send without a note', 'Send without a note');
      } catch {
        await clickButtonByText(cdp, 'Send', 'the Send button');
      }
    }
    await sleep(1500);

    // Verify via the sent-invitations manager (the profile action bar renders
    // the pending state unreliably; the sent list is authoritative).
    await goto(cdp, `${ORIGIN}/mynetwork/invitation-manager/sent/`, 'main', { force: true, timeoutMs: 15000 });
    await sleep(1500);
    await cdp.evaluate('window.scrollBy(0, 600); return true;');
    await sleep(1200);
    const sent = await cdp.evaluate<boolean>(`return !!document.querySelector('a[href*="/in/${handle}"]');`);
    return { ok: true, state: sent ? 'invitation-sent' : 'sent' };
  });
}

/** Message a person by profile (target = handle, /in/ URL, or a name to search). */
export async function messageProfile(target: string, text: string): Promise<{ ok: true }> {
  if (!text || !text.trim()) throw new LiError('BAD_REQUEST', '`text` is required');
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    const url = await resolveProfileUrl(cdp, target);
    await goto(cdp, url, 'main', { force: true, timeoutMs: 15000 });
    await sleep(1000);
    const hasMsg = await cdp.evaluate<boolean>(`const b=document.querySelector(${JSON.stringify(SELECTORS.profileMessageBtn)}); if(b && b.getBoundingClientRect().width>0){b.scrollIntoView({block:'center'}); b.click(); return true;} return false;`);
    if (!hasMsg) throw new LiError('MESSAGE_UNAVAILABLE', 'no Message button on this profile (not connected / messaging restricted)');
    // the message overlay opens with its own compose box
    const up = await waitFor(cdp, `!!document.querySelector('div[role="textbox"][aria-label*="message" i], .msg-form__contenteditable')`, 10000);
    if (!up) throw new LiError('COMPOSE_NOT_READY', 'the message compose overlay did not open');
    await sleep(500);
    await focusEditor(cdp, 'div[role="textbox"][aria-label*="message" i], .msg-form__contenteditable', 'the message compose box');
    await sleep(300);
    await cdp.insertText(String(text));
    await sleep(400);
    try { await clickButtonByText(cdp, 'Send', 'the Send button'); }
    catch { await cdp.pressEnter(); }
    await sleep(700);
    return { ok: true };
  });
}

// ─── comment + delete a post ──────────────────────────────────────────────────

/** Type + submit a comment into the currently-open comment box. Shared by both
 *  the feed-inline and permalink paths. The submit "Comment" button appears only
 *  after text is entered; the action toggle has aria-label="Comment" but EMPTY
 *  text, so clickButtonByText('Comment') (matches textContent) hits the submit. */
async function submitOpenComment(cdp: Cdp, text: string): Promise<void> {
  const up = await waitFor(cdp, `!!document.querySelector(${JSON.stringify(SELECTORS.commentEditor)})`, 10000);
  if (!up) throw new LiError('COMMENT_BOX_NOT_READY', 'the comment box did not open');
  await sleep(500);
  await focusEditor(cdp, SELECTORS.commentEditor, 'the comment editor');
  await sleep(300);
  await cdp.insertText(String(text));
  await sleep(700);
  // Submit: the enabled "Comment" button INSIDE the comment box (the post's
  // action toggle also reads "Comment" but has empty text / is elsewhere).
  // Retry a few times — LinkedIn briefly re-disables the button while it debounces.
  let submitted = false;
  for (let i = 0; i < 8 && !submitted; i++) {
    submitted = await cdp.evaluate<boolean>(`
      const ed=document.querySelector(${JSON.stringify(SELECTORS.commentEditor)});
      if(!ed) return false;
      let box=ed;
      for(let i=0;i<8&&box;i++){ box=box.parentElement; if(box && [...box.querySelectorAll('button')].some(b=>(b.textContent||'').trim().toLowerCase()==='comment')) break; }
      const scope = box || document;
      const b=[...scope.querySelectorAll('button')].find(x=>x.getBoundingClientRect().width>0 && !x.disabled && (x.textContent||'').trim().toLowerCase()==='comment');
      if(!b) return false; b.scrollIntoView({block:'center'}); b.click(); return true;
    `);
    if (!submitted) await sleep(500);
  }
  if (!submitted) throw new LiError('COMMENT_SUBMIT_NOT_READY', 'the comment submit button did not enable/click');
  await sleep(1500);
}

/**
 * Comment on a post. `match` selects the post whose author or text contains it
 * (case-insensitive). Tries the FEED inline first (for others' posts in your
 * feed); if not found there, resolves one of YOUR OWN posts via recent-activity
 * and comments on its permalink (a stable single-post surface). Returns { ok }.
 */
export async function commentOnPost(text: string, match = ''): Promise<{ ok: true; postActor: string }> {
  if (!text || !text.trim()) throw new LiError('BAD_REQUEST', '`text` is required');
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);

    // Path A — comment inline on a matching rendered feed post.
    await goto(cdp, URL_FEED, SELECTORS.feedReady);
    for (let i = 0; i < 4; i++) {
      const actor = await cdp.evaluate<string | null>(`
        const want = ${JSON.stringify(match.toLowerCase())};
        const menus=[...document.querySelectorAll(${JSON.stringify(SELECTORS.postControlMenu)})];
        for (const btn of menus) {
          const actor=(btn.getAttribute('aria-label')||'').replace(/^Open control menu for post by\\s*/i,'').trim();
          let node=btn; for(let i=0;i<12&&node;i++){node=node.parentElement; if(node&&node.querySelector(${JSON.stringify(SELECTORS.feedText)}))break;}
          const txt=node?((node.querySelector(${JSON.stringify(SELECTORS.feedText)})||{}).innerText||''):'';
          if(want && !(actor.toLowerCase().includes(want) || txt.toLowerCase().includes(want))) continue;
          const cbtn=node?node.querySelector(${JSON.stringify(SELECTORS.commentBtn)}):null;
          if(cbtn){cbtn.scrollIntoView({block:'center'}); cbtn.click(); return actor;}
        }
        return null;
      `);
      if (actor !== null) {
        await submitOpenComment(cdp, text);
        return { ok: true, postActor: actor };
      }
      if (!match) break; // no match filter → only the rendered top posts matter
      await cdp.evaluate('window.scrollBy(0, window.innerHeight * 1.5); return true;');
      await sleep(900);
    }

    // Path B — one of your OWN posts (not surfaced in the feed): resolve its
    // activity URN from recent activity and comment on the permalink.
    const urn = await cdp.evaluate<string | null>(`
      const want=${JSON.stringify(match.toLowerCase())};
      const menus=[...document.querySelectorAll(${JSON.stringify(SELECTORS.postControlMenu)})];
      for (const btn of menus) {
        let node=btn, urn=null, txt='';
        for(let i=0;i<15&&node;i++){ node=node.parentElement; if(!node)break; const du=node.getAttribute&&node.getAttribute('data-urn'); if(du&&/activity/.test(du)){urn=du; txt=(node.innerText||'').toLowerCase(); break;} }
        if(urn && (!want || txt.includes(want))) return urn;
      }
      return null;
    `);
    if (!urn) {
      // one more look on recent activity (feed didn't have it)
      await goto(cdp, `${ORIGIN}/in/me/recent-activity/all/`, SELECTORS.postControlMenu, { force: true, timeoutMs: 18000 });
      await sleep(1500);
    }
    const finalUrn = urn || (await cdp.evaluate<string | null>(`
      const want=${JSON.stringify(match.toLowerCase())};
      const menus=[...document.querySelectorAll(${JSON.stringify(SELECTORS.postControlMenu)})];
      for (const btn of menus) {
        let node=btn, urn=null, txt='';
        for(let i=0;i<15&&node;i++){ node=node.parentElement; if(!node)break; const du=node.getAttribute&&node.getAttribute('data-urn'); if(du&&/activity/.test(du)){urn=du; txt=(node.innerText||'').toLowerCase(); break;} }
        if(urn && (!want || txt.includes(want))) return urn;
      }
      return null;
    `));
    if (!finalUrn) throw new LiError('POST_NOT_FOUND', match ? `no post matches "${match}"` : 'no post found to comment on');

    await cdp.navigate(`${ORIGIN}/feed/update/${finalUrn}/`);
    await waitFor(cdp, `!!document.querySelector(${JSON.stringify(SELECTORS.commentBtn)})`, 15000);
    await sleep(2000);
    await cdp.evaluate('window.scrollBy(0, 240); return true;');
    await sleep(600);
    const actor = await cdp.evaluate<string | null>(
      `const b=document.querySelector(${JSON.stringify(SELECTORS.postControlMenu)}); return b ? (b.getAttribute('aria-label')||'').replace(/^Open control menu for post by\\s*/i,'').trim() : null;`,
    );
    await clickSelector(cdp, SELECTORS.commentBtn, 'the Comment button');
    await submitOpenComment(cdp, text);
    return { ok: true, postActor: actor || 'you' };
  });
}

/**
 * Delete one of YOUR OWN posts. `match` selects the own-post whose text contains
 * it; omit to delete your most-recent own post. Returns { ok, deleted }.
 *
 * Verified flow (LinkedIn 2026 SDUI):
 *   1. On /in/me/recent-activity/all/, resolve the target post's activity URN
 *      (match by the post's rendered text; the feed's `expandable-text-box`
 *      testid is absent on this page, so match against the container's innerText).
 *   2. Open the post's PERMALINK (single-post page) — a stable surface where the
 *      control menu is not obscured by a sticky header or sibling posts.
 *   3. Open the control menu with an IN-PAGE `.click()` (the toggle responds to
 *      a synthetic click, NOT to a CDP coordinate click).
 *   4. Click the `[role="menuitem"]` for "Delete post" in-page.
 *   5. Click the confirmation "Delete" button — a plain <button> (the confirm
 *      modal is NOT a `[role="dialog"]`/`.artdeco-modal`, so find it by text).
 */
export async function deletePost(match = ''): Promise<{ ok: true; deleted: boolean; urn: string }> {
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    // 1. resolve the target post's activity URN from recent activity.
    await goto(cdp, `${ORIGIN}/in/me/recent-activity/all/`, SELECTORS.postControlMenu, { force: true, timeoutMs: 18000 });
    await sleep(1500);
    const urn = await cdp.evaluate<string | null>(`
      const want=${JSON.stringify(match.toLowerCase())};
      const menus=[...document.querySelectorAll(${JSON.stringify(SELECTORS.postControlMenu)})];
      for (const btn of menus) {
        let node=btn, urn=null, txt='';
        for(let i=0;i<15&&node;i++){ node=node.parentElement; if(!node) break;
          const du=node.getAttribute&&node.getAttribute('data-urn');
          if(du&&/activity/.test(du)){ urn=du; txt=(node.innerText||'').toLowerCase(); break; } }
        if(urn && (!want || txt.includes(want))) return urn;
      }
      return null;
    `);
    if (!urn) throw new LiError('OWN_POST_NOT_FOUND', match ? `no own post matches "${match}"` : 'no own post found to delete');

    // 2. open the single-post permalink.
    await cdp.navigate(`${ORIGIN}/feed/update/${urn}/`);
    await waitFor(cdp, `!!document.querySelector(${JSON.stringify(SELECTORS.postControlMenu)})`, 15000);
    await sleep(2000);
    await cdp.evaluate('window.scrollBy(0, 240); return true;');
    await sleep(700);

    // 3. open the control menu (in-page click).
    await clickSelector(cdp, SELECTORS.postControlMenu, 'the post control menu');
    await sleep(2200);

    // 4. click the "Delete post" menu item (in-page click of its [role=menuitem]).
    const delClicked = await cdp.evaluate<boolean>(`
      let p=null;
      for(const el of document.querySelectorAll('*')){ const r=el.getBoundingClientRect();
        if(r.width>0&&r.height>0&&el.children.length===0&&/^delete post$/i.test((el.textContent||'').trim())){ p=el; break; } }
      if(!p) return false;
      const mi=p.closest('[role="menuitem"]')||p; mi.click(); return true;
    `);
    if (!delClicked) throw new LiError('DELETE_ITEM_NOT_FOUND', 'the "Delete post" menu item did not appear');
    await sleep(2500);

    // 5. click the confirmation "Delete" button (a plain <button>, not a dialog).
    const confirmed = await cdp.evaluate<boolean>(`
      const b=[...document.querySelectorAll('button')].find(x=>x.getBoundingClientRect().width>0 && /^delete$/i.test((x.textContent||'').trim()));
      if(!b) return false; b.click(); return true;
    `);
    await sleep(3500);
    return { ok: true, deleted: confirmed, urn };
  });
}

// ─── session keep-alive ───────────────────────────────────────────────────────

/**
 * Keep the logged-in LinkedIn session warm: issue ONE lightweight authenticated
 * request from inside the page (cookies attached) so LinkedIn sees recent
 * activity and does not idle-expire the session, then report whether the page is
 * still logged in. Non-disruptive — it does NOT navigate or mutate the DOM, so
 * it is safe to run on a timer even while the connector is otherwise idle.
 * Throws (CDP_UNREACHABLE / PAGE_NOT_FOUND) if the driver browser is not up.
 */
export async function keepSessionWarm(): Promise<{ loggedIn: boolean; warmed: boolean; httpStatus: number }> {
  return withCdp(async (cdp) => {
    const res = await cdp.evaluate<{ status: number }>(`
      try {
        const r = await fetch('https://www.linkedin.com/feed/', { credentials: 'include', headers: { 'accept': 'text/html' } });
        return { status: r.status };
      } catch (e) { return { status: 0 }; }
    `);
    const s = await cdp.evaluate<CdpStatus>(JS_STATUS);
    const httpStatus = res?.status ?? 0;
    return { loggedIn: !!s?.loggedIn, warmed: httpStatus > 0 && httpStatus < 400, httpStatus };
  });
}

void log;
