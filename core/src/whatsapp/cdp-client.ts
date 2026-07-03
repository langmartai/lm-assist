/**
 * WhatsApp CDP provider (local deployment).
 *
 * Drives a logged-in WhatsApp Web session over the Chrome DevTools Protocol
 * (CDP) and mirrors what it reads into the SHARED message store (store.ts) —
 * so the local (desktop, CDP) and server (Meta Cloud API) deployments serve
 * the exact same data shape (WaMessage) through the exact same MCP tools.
 *
 * HOST: any Chromium with web.whatsapp.com open + logged in and a CDP debug
 * port. On Windows that is the WhatsApp Desktop Store app (WebView2), launched
 * with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222
 * --remote-allow-origins=*". Endpoint resolved via config.resolveCdpBase().
 *
 * WhatsApp Web VIRTUALIZES the message list — only rows near the viewport are
 * in the DOM — so reads capture the most-recent RENDERED messages. That is the
 * local analogue of the Cloud API's "no server-side history" constraint.
 *
 * Exports:
 *   cdpStatus()          -> { loggedIn, self }
 *   syncFromCdp()        -> ingest the rendered chat list into the store
 *   syncChat(chatId)     -> open a chat + ingest its rendered messages
 *   sendText(to, text)   -> open a chat + send a text; returns a synthetic id
 *   getMedia(id)         -> not-yet-supported stub (media extraction is a follow-up)
 */

import * as fs from 'fs';
import * as path from 'path';
import WebSocket from 'ws';
import { resolveCdpBase, WA_DATA_DIR } from './config';
import * as store from './store';
import type { WaMessage } from './store';

const log = (...a: unknown[]) => console.error('[wa-cdp]', ...a);

export class WaError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Digits-only phone. */
function normalizePhone(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

/** Does a display title look like a raw phone number (vs a saved contact/group name)? */
function looksLikePhone(title: string): boolean {
  const t = String(title || '').trim();
  return /^\+?[\d\s\-()]+$/.test(t) && /\d/.test(t);
}

/**
 * Canonical chatId for a title: digits if it looks like a phone, else the
 * display-name string verbatim. Used everywhere so listChats, syncChat, and
 * sendText all key the same conversation identically.
 */
export function canonicalChatId(title: unknown): string {
  const t = String(title ?? '').trim();
  return looksLikePhone(t) ? normalizePhone(t) : t;
}

/** Small stable hash so synthesized message ids are idempotent by content. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// ─── CDP session plumbing ────────────────────────────────────────────────────

/** Find the web.whatsapp.com page target; return a ws URL host-matched to base. */
async function findPageWs(base: string): Promise<string> {
  let list: unknown;
  try {
    const res = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(8000) });
    list = await res.json();
  } catch (e) {
    throw new WaError('CDP_UNREACHABLE', `cannot reach CDP at ${base}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const page = (Array.isArray(list) ? list : []).find(
    (t: { type?: string; url?: string }) => t.type === 'page' && /web\.whatsapp\.com/.test(t.url || ''),
  ) as { webSocketDebuggerUrl?: string } | undefined;
  if (!page || !page.webSocketDebuggerUrl) {
    throw new WaError('PAGE_NOT_FOUND', 'no web.whatsapp.com page found on this CDP endpoint');
  }
  const baseHost = new URL(base).host;
  return String(page.webSocketDebuggerUrl).replace(/^ws:\/\/[^/]+/, `ws://${baseHost}`);
}

interface Cdp {
  evaluate<T = unknown>(expr: string): Promise<T>;
  click(x: number, y: number): Promise<void>;
  insertText(text: string): Promise<void>;
  pressEnter(): Promise<void>;
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
      reject(new WaError('CDP_UNREACHABLE', 'CDP websocket connect timeout'));
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
        if (m.error) rej(new WaError('CDP_ERROR', JSON.stringify(m.error)));
        else res(m.result);
      }
    });
    ws.on('error', (e: Error) => {
      clearTimeout(to);
      reject(new WaError('CDP_UNREACHABLE', String(e.message || e)));
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
          const r = (await send('Runtime.evaluate', {
            expression: `(async()=>{${expr}})()`,
            awaitPromise: true,
            returnByValue: true,
          })) as { exceptionDetails?: { exception?: { description?: string } }; result?: { value?: T } };
          if (r.exceptionDetails) {
            throw new WaError('PAGE_EVAL_ERROR', r.exceptionDetails.exception?.description || 'page eval error');
          }
          return r.result?.value as T;
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
          const k = { windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' };
          await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
          await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...k });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
        },
        close() {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      };
      send('Runtime.enable')
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

// ─── page-side snippets (run inside WhatsApp Web) ─────────────────────────────

const JS_STATUS = `
  const loggedIn = !!document.querySelector('#pane-side');
  // Own number: WhatsApp Web keeps the logged-in wid in localStorage
  // ("6590052422:1@c.us" under last-wid-md, older builds use last-wid).
  let self = null;
  try {
    const raw = localStorage.getItem('last-wid-md') || localStorage.getItem('last-wid') || '';
    const m = raw.match(/(\\d{6,15})/);
    if (m) self = m[1];
  } catch (e) { /* storage blocked — leave null */ }
  return { loggedIn, self };
`;

/** Chat-list rows: name + preview + time label + unread + outbound marker,
 *  in DOM order (the app already sorts most-recent-first). */
const JS_CHATS = `
  const rows = [...document.querySelectorAll('#pane-side [role="row"]')];
  const rows_out = rows.map((row, index) => {
    const titles = [...row.querySelectorAll('span[title]')].map(s => s.getAttribute('title'));
    const name = titles[0] || '';
    const preview = titles.length > 1 ? (titles[titles.length-1] || '') : '';
    // candidate short texts — the row's time label is one of these (formats vary
    // by locale: "10:30", "下午1:30", "昨天", "星期三", "2026/7/1", "7/1/2026")
    const texts = [...new Set([...row.querySelectorAll('div,span')]
      .map(e => (e.textContent || '').trim())
      .filter(t => t && t.length <= 12 && !/wds-ic-/.test(t)))];
    // outbound preview: the row carries a status-tick icon ligature
    const isOut = /wds-ic-(read|delivered|sent|check|time)/.test(row.textContent || '');
    // unread badge: explicit aria-label first, else a small pure-digit span
    let unread = 0;
    const badgeAria = [...row.querySelectorAll('[aria-label]')]
      .map(e => e.getAttribute('aria-label') || '')
      .find(a => /unread|未读/.test(a));
    if (badgeAria) {
      const n = (badgeAria.match(/\\d+/) || [])[0];
      unread = n ? +n : 1;
    } else if (!isOut) {
      const dig = texts.find(t => /^\\d{1,3}$/.test(t) && t !== name);
      if (dig) unread = +dig;
    }
    return { index, name, preview, texts, isOut, unread, row };
  }).filter(r => r.name);
  // Avatars: each row renders the contact's profile picture. blob: images are
  // fetched in-page to a small data URL; https CDN URLs pass through as-is.
  for (const r of rows_out) {
    let avatar = null;
    const img = r.row.querySelector('img');
    if (img && img.src) {
      if (img.src.startsWith('blob:')) {
        try {
          const b = await (await fetch(img.src)).blob();
          const dataUrl = await new Promise((res) => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result);
            fr.onerror = () => res(null);
            fr.readAsDataURL(b);
          });
          if (typeof dataUrl === 'string' && dataUrl.length < 80000) avatar = dataUrl;
        } catch (e) { /* avatar is optional */ }
      } else if (/^https:/.test(img.src)) {
        avatar = img.src;
      }
    }
    r.avatar = avatar;
    delete r.row;
  }
  return rows_out;
`;

function jsLocate(target: string): string {
  const nm = JSON.stringify(target);
  const digits = JSON.stringify(normalizePhone(target));
  return `
    const want = ${nm};
    const wantDigits = ${digits};
    const norm = t => (t||'').replace(/\\D/g,'');
    const rowFor = () => {
      const spans = [...document.querySelectorAll('#pane-side [role="row"] span[title]')];
      let s = spans.find(s => s.getAttribute('title') === want);
      if (!s && wantDigits) s = spans.find(s => norm(s.getAttribute('title')) && norm(s.getAttribute('title')) === wantDigits);
      return s ? s.closest('[role="row"]') : null;
    };
    let row = rowFor();
    if (!row) {
      const sb = document.querySelector('div[contenteditable="true"][data-tab="3"]');
      if (sb) { sb.focus(); document.execCommand('selectAll',false,null); document.execCommand('insertText',false,want); }
      await new Promise(r=>setTimeout(r,1300));
      row = rowFor();
      if (!row) {
        // fall back to the first surfaced search result
        const first = document.querySelector('#pane-side [role="row"] span[title]');
        row = first ? first.closest('[role="row"]') : null;
      }
    }
    if (!row) return { ok:false };
    row.scrollIntoView({block:'center'});
    await new Promise(r=>setTimeout(r,200));
    const r = row.getBoundingClientRect();
    return { ok:true, x: r.left + r.width/2, y: r.top + r.height/2 };
  `;
}

function jsRead(n: number): string {
  return `
    const header = document.querySelector('#main header span[title]')?.getAttribute('title') || null;
    // WhatsApp Web virtualizes the list — only near-viewport rows exist in the DOM.
    const rows = [...document.querySelectorAll('#main [role="row"]')];
    const out = [];
    for (const row of rows) {
      const pptEl = row.querySelector('[data-pre-plain-text]');
      const ppt = pptEl ? pptEl.getAttribute('data-pre-plain-text') : '';
      const textEl = row.querySelector('span.selectable-text');
      const text = textEl ? textEl.innerText.trim() : '';
      const aria = [...row.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label') || '');
      const icons = [...row.querySelectorAll('[data-icon]')].map(e => e.getAttribute('data-icon') || '');
      const hasIcon = (re) => icons.some(i => re.test(i));
      // Direction: this WebView2 build has no message-in/out classes. Outbound
      // bubbles ALWAYS carry a status tick (icon ligature wds-ic-*) and group
      // leaders carry data-icon="tail-out"; inbound rows have neither.
      const isOut = !!row.querySelector('[data-icon="tail-out"]')
        || /wds-ic-(read|delivered|sent|check|time)/.test(row.textContent || '');
      const isVoice = hasIcon(/mic|ptt|audio-play/) || aria.some(a => /语音消息|voice message/i.test(a));
      const isImage = !!row.querySelector('img[src^="blob:"], img[src^="data:"]') || aria.some(a => /图片|photo/i.test(a));
      const isVideo = !!row.querySelector('video') || hasIcon(/media-play|video/) || aria.some(a => /视频|video/i.test(a));
      const isDoc = hasIcon(/document|audio-download/) || aria.some(a => /文件|document/i.test(a));
      if (!ppt && !text && !isVoice && !isImage && !isVideo && !isDoc) continue;
      const dur = (row.innerText.match(/\\b\\d{1,2}:\\d{2}\\b/) || [])[0] || null;
      let type = 'text', body = text;
      if (isVoice) { type = 'voice'; body = text || ('[voice message' + (dur ? ' ' + dur : '') + ']'); }
      else if (isImage) { type = 'image'; body = text ? ('[image] ' + text) : '[image]'; }
      else if (isVideo) { type = 'video'; body = text ? ('[video] ' + text) : '[video]'; }
      else if (isDoc) {
        type = 'document';
        const fn = [...row.querySelectorAll('[title]')].map(e => e.getAttribute('title')).find(t => t && /\\.\\w{2,5}$/.test(t));
        body = '[document' + (fn ? ': ' + fn : '') + ']';
      } else if (!body) { continue; }
      let ppTime = null, sender = null;
      const m = ppt.match(/^\\[(.*?)\\]\\s*(.*?):\\s*$/);
      if (m) { ppTime = m[1]; sender = m[2]; }
      if (!sender) { const al = aria.find(a => /[:：]\\s*$/.test(a)); if (al) sender = al.replace(/[:：]\\s*$/, '').trim(); }
      out.push({ ppt: ppTime, sender, direction: isOut ? 'out' : 'in', type, text: body });
    }
    return { header, messages: out.slice(-${n}) };
  `;
}

const JS_COMPOSE_XY = `
  const box = document.querySelector('footer div[contenteditable="true"][data-tab="10"]')
           || document.querySelector('footer div[contenteditable="true"]');
  if (!box) return { ok:false };
  const r = box.getBoundingClientRect();
  return { ok:true, x: r.left + r.width/2, y: r.top + r.height/2 };
`;

// ─── timestamp parsing (Node side) ───────────────────────────────────────────

/** Parse a data-pre-plain-text "[HH:MM, <date>]" into unix seconds, best-effort. */
function parsePptTime(ppt: string | null, fallback: number): number {
  if (!ppt) return fallback;
  const m = String(ppt).match(/(\d{1,2}):(\d{2})/);
  if (!m) return fallback;
  const hh = +m[1];
  const mm = +m[2];
  // the date portion follows the time, up to the closing bracket if present
  const dm = String(ppt).match(/\d{1,2}:\d{2}\s*,?\s*(.+?)\]?$/);
  let datePart = dm ? dm[1].trim() : '';
  let y: number | undefined;
  let mo: number | undefined;
  let d: number | undefined;
  const zh = datePart.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (zh) {
    y = +zh[1];
    mo = +zh[2] - 1;
    d = +zh[3];
  } else if (datePart) {
    const parsed = new Date(datePart);
    if (!isNaN(parsed.getTime())) {
      y = parsed.getFullYear();
      mo = parsed.getMonth();
      d = parsed.getDate();
    }
  }
  const now = new Date();
  if (y === undefined) {
    y = now.getFullYear();
    mo = now.getMonth();
    d = now.getDate();
  }
  const dt = new Date(y, mo as number, d as number, hh, mm, 0);
  const ts = Math.floor(dt.getTime() / 1000);
  return isFinite(ts) && ts > 0 ? ts : fallback;
}

/** Parse ONE chat-list time label ("10:30", "下午1:30", "Yesterday", "昨天",
 *  "星期三", "Wednesday", "2026/7/1", "7/1/2026"). Returns unix seconds or null. */
function parseOneChatListLabel(t: string): number | null {
  const now = new Date();
  const day = (offset: number, hh = 12, mm = 0) =>
    Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset, hh, mm, 0).getTime() / 1000);
  let m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return day(0, +m[1], +m[2]);
  m = t.match(/^(上午|下午)\s*(\d{1,2}):(\d{2})$/);
  if (m) {
    let hh = +m[2] % 12;
    if (m[1] === '下午') hh += 12;
    return day(0, hh, +m[3]);
  }
  if (/^(昨天|Yesterday)$/i.test(t)) return day(1);
  const ZH_DAYS = ['日', '一', '二', '三', '四', '五', '六'];
  m = t.match(/^星期([日一二三四五六天])$/);
  const EN_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const enIdx = EN_DAYS.indexOf(t.toLowerCase());
  const targetDow = m ? ZH_DAYS.indexOf(m[1] === '天' ? '日' : m[1]) : enIdx;
  if (targetDow >= 0) {
    let offset = (now.getDay() - targetDow + 7) % 7;
    if (offset === 0) offset = 7; // a weekday label always means a PAST day
    return day(offset);
  }
  m = t.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/); // yyyy/m/d (zh locale)
  if (m) return Math.floor(new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0).getTime() / 1000);
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // d/m/yyyy or m/d/yyyy
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const dd = a > 12 ? a : b > 12 ? b : a; // disambiguate when possible; else d/m
    const mo = a > 12 ? b : b > 12 ? a : b;
    const ts = new Date(+m[3], mo - 1, dd, 12, 0, 0).getTime();
    if (!isNaN(ts)) return Math.floor(ts / 1000);
  }
  return null;
}

/** Pick the first parseable time label out of a row's candidate short texts. */
function parseChatListTime(texts: string[], fallback: number): number {
  for (const t of texts || []) {
    const ts = parseOneChatListLabel(String(t).trim());
    if (ts !== null) return ts;
  }
  return fallback;
}

// ─── public provider API ─────────────────────────────────────────────────────

export interface CdpStatus {
  loggedIn: boolean;
  self: string | null;
}

async function assertLoggedIn(cdp: Cdp): Promise<void> {
  const s = await cdp.evaluate<{ loggedIn: boolean }>(JS_STATUS);
  if (!s || !s.loggedIn) {
    throw new WaError('NOT_LOGGED_IN', 'WhatsApp Web is not logged in / not ready');
  }
}

/** CDP reachability + logged-in state (+ best-effort self identity). */
export async function cdpStatus(): Promise<CdpStatus> {
  return withCdp(async (cdp) => {
    const s = await cdp.evaluate<CdpStatus>(JS_STATUS);
    return { loggedIn: !!s?.loggedIn, self: s?.self ?? null };
  });
}

// ─── chat-order sidecar ──────────────────────────────────────────────────────
// The app's own list order (most-recent-first) + per-chat unread counts, as
// captured at the last syncFromCdp. The store cannot know either reliably
// (preview timestamps are coarse), so the routes layer merges this in.

export interface ChatOrderEntry {
  chatId: string;
  unread: number;
  lastDirection: 'in' | 'out';
  lastMessageAt: number;
  /** Contact profile picture: a small data URL (blob avatars) or the CDN URL. */
  avatar?: string;
}

const chatOrderFile = () => path.join(WA_DATA_DIR, 'chat-order.json');

function writeChatOrder(rows: ChatOrderEntry[]): void {
  try {
    fs.mkdirSync(WA_DATA_DIR, { recursive: true });
    fs.writeFileSync(chatOrderFile(), JSON.stringify({ capturedAt: Date.now(), rows }));
  } catch {
    /* ordering is an enhancement — never fail the sync over it */
  }
}

export function readChatOrder(): ChatOrderEntry[] {
  try {
    const j = JSON.parse(fs.readFileSync(chatOrderFile(), 'utf8')) as { rows?: ChatOrderEntry[] };
    return Array.isArray(j.rows) ? j.rows : [];
  } catch {
    return [];
  }
}

/**
 * Ingest the currently-rendered chat list into the store. Each row becomes one
 * synthesized (idempotent-by-id) WaMessage carrying the last-message preview so
 * store.listChats() has a row per conversation; the DOM order + unread badges
 * are captured in the chat-order sidecar. Returns the number of chats seen.
 */
export async function syncFromCdp(): Promise<{ chats: number; ingested: number }> {
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    const rows = await cdp.evaluate<
      Array<{ index: number; name: string; preview: string; texts: string[]; isOut: boolean; unread: number; avatar: string | null }>
    >(JS_CHATS);
    const list = Array.isArray(rows) ? rows : [];
    let ingested = 0;
    const now = Math.floor(Date.now() / 1000);
    const order: ChatOrderEntry[] = [];
    list.forEach((r, i) => {
      const chatId = canonicalChatId(r.name);
      if (!chatId) return;
      const ts = parseChatListTime(r.texts, now - i * 60);
      const direction: 'in' | 'out' = r.isOut ? 'out' : 'in';
      order.push({
        chatId,
        unread: r.unread || 0,
        lastDirection: direction,
        lastMessageAt: ts,
        ...(r.avatar ? { avatar: r.avatar } : {}),
      });
      const text = r.preview || '';
      const id = `cdp-${chatId}-preview-${hash(`${direction}|${text}`)}`;
      const msg: WaMessage = {
        id,
        chatId,
        direction,
        from: direction === 'out' ? 'me' : chatId,
        to: direction === 'out' ? chatId : undefined,
        type: 'text',
        text,
        timestamp: ts,
        contactName: looksLikePhone(r.name) ? undefined : r.name,
      };
      if (direction === 'out') store.addOutbound(msg);
      else store.addInbound(msg);
      ingested++;
    });
    writeChatOrder(order);
    return { chats: list.length, ingested };
  });
}

/**
 * Open the chat for `target` (contact/group name or phone) and ingest its
 * rendered messages into the store, keyed by canonicalChatId(target) so a
 * subsequent store.getMessages(target) matches. Returns { chatId, ingested }.
 */
export async function syncChat(target: string): Promise<{ chatId: string; contactName: string | null; ingested: number }> {
  const chatId = canonicalChatId(target);
  if (!chatId) throw new WaError('BAD_REQUEST', 'chat identifier is required');
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    const loc = await cdp.evaluate<{ ok: boolean; x?: number; y?: number }>(jsLocate(target));
    if (!loc || !loc.ok) throw new WaError('CHAT_NOT_FOUND', `chat not found: ${target}`);
    await cdp.click(loc.x!, loc.y!);
    await sleep(700);
    const r = await cdp.evaluate<{
      header: string | null;
      messages: Array<{ ppt: string | null; sender: string | null; direction: 'in' | 'out'; type: string; text: string }>;
    }>(jsRead(200));
    const header = r?.header || null;
    const contactName = header && !looksLikePhone(header) ? header : null;
    const msgs = (r?.messages || []).filter((m) => m && (m.text || m.type !== 'text'));
    let ingested = 0;
    const now = Math.floor(Date.now() / 1000);
    msgs.forEach((m, i) => {
      // Older rows first; give unparseable ones a decreasing offset to keep order.
      const fallback = now - (msgs.length - i);
      const ts = parsePptTime(m.ppt, fallback);
      const id = `cdp-${chatId}-${ts}-${hash(`${m.direction}|${m.text}`)}`;
      const rec: WaMessage = {
        id,
        chatId,
        direction: m.direction,
        from: m.direction === 'out' ? 'me' : chatId,
        to: m.direction === 'out' ? chatId : undefined,
        type: m.type,
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
 * Open the chat for `to` and send `text`. Returns a synthetic message id; the
 * caller records the outbound message in the store (parity with the server
 * route, which records after the hub send).
 */
export async function sendText(
  to: string,
  text: string,
): Promise<{ messageId: string; chatId: string; contactName: string | null }> {
  if (!to) throw new WaError('BAD_REQUEST', '`to` is required');
  if (!text) throw new WaError('BAD_REQUEST', '`text` is required');
  const chatId = canonicalChatId(to);
  return withCdp(async (cdp) => {
    await assertLoggedIn(cdp);
    const loc = await cdp.evaluate<{ ok: boolean; x?: number; y?: number }>(jsLocate(to));
    if (!loc || !loc.ok) throw new WaError('CHAT_NOT_FOUND', `chat not found: ${to}`);
    await cdp.click(loc.x!, loc.y!);
    await sleep(700);
    const header = await cdp.evaluate<string | null>(
      `return document.querySelector('#main header span[title]')?.getAttribute('title') || null;`,
    );
    const box = await cdp.evaluate<{ ok: boolean; x?: number; y?: number }>(JS_COMPOSE_XY);
    if (!box || !box.ok) throw new WaError('NO_CHAT_OPEN', 'compose box not found after opening chat');
    await cdp.click(box.x!, box.y!);
    await sleep(200);
    await cdp.insertText(String(text));
    await sleep(250);
    await cdp.pressEnter();
    await sleep(300);
    const contactName = header && !looksLikePhone(header) ? header : null;
    const messageId = `out-${Math.floor(Date.now() / 1000)}-${chatId}-${hash(text)}`;
    return { messageId, chatId, contactName };
  });
}

/**
 * Media download is not yet supported on the local CDP provider (WhatsApp Web
 * serves media as blob: URLs behind its own decryption — a known follow-up).
 */
export async function getMedia(id: string): Promise<never> {
  log('getMedia not supported on cdp provider', id);
  throw new WaError(
    'MEDIA_UNSUPPORTED',
    'media download is not yet supported on the local CDP WhatsApp provider (follow-up)',
  );
}
