// @ts-nocheck
// core/src/whatsapp/whatsapp-service.ts
//
// Drive a WhatsApp Web session over the Chrome DevTools Protocol (CDP).
//
// HOST-AGNOSTIC: this talks to any Chromium that (a) has web.whatsapp.com open
// and logged in, and (b) exposes a CDP debug port. Two common hosts:
//   - Windows: the WhatsApp Desktop Store app renders its UI in an embedded
//     WebView2 (Chromium). Launch it with
//       WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222 --remote-allow-origins=*"
//     and restart the app.
//   - Linux/any: a Chrome/Chromium started with
//       --remote-debugging-port=9222 --remote-allow-origins=*
//     with web.whatsapp.com open and the phone paired.
//
// The CDP endpoint is configurable per call (`cdpUrl` / `port`) or via env
// (WHATSAPP_CDP_URL / WHATSAPP_CDP_PORT), defaulting to http://localhost:9222.
//
// runAction(action, params) -> { ok:true, data } | { ok:false, error:{code,message} }

import WebSocket from 'ws';

const log = (...a: any[]) => console.error('[wa-svc]', ...a);

const DEFAULT_PORT = 9222;

function resolveBase(params: any): string {
  if (params && params.cdpUrl) return String(params.cdpUrl).replace(/\/+$/, '');
  if (process.env.WHATSAPP_CDP_URL) return String(process.env.WHATSAPP_CDP_URL).replace(/\/+$/, '');
  const port = (params && params.port) || process.env.WHATSAPP_CDP_PORT || DEFAULT_PORT;
  return `http://localhost:${port}`;
}

class WaError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

// ---- CDP session ----------------------------------------------------------

// Find the web.whatsapp.com page target and return a ws URL whose host:port
// matches `base` (so it works through a port-forward / non-loopback base too).
async function findPageWs(base: string): Promise<string> {
  let list: any;
  try {
    const res = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(8000) });
    list = await res.json();
  } catch (e: any) {
    throw new WaError('CDP_UNREACHABLE', `cannot reach CDP at ${base}: ${e.message || e}`);
  }
  const page = (Array.isArray(list) ? list : []).find(
    (t: any) => t.type === 'page' && /web\.whatsapp\.com/.test(t.url || ''),
  );
  if (!page || !page.webSocketDebuggerUrl) {
    throw new WaError('PAGE_NOT_FOUND', 'no logged-in web.whatsapp.com page found on this CDP endpoint');
  }
  const baseHost = new URL(base).host; // host:port
  return String(page.webSocketDebuggerUrl).replace(/^ws:\/\/[^/]+/, `ws://${baseHost}`);
}

interface Cdp {
  evaluate(expr: string): Promise<any>;
  click(x: number, y: number): Promise<void>;
  insertText(text: string): Promise<void>;
  pressEnter(): Promise<void>;
  close(): void;
}

function connect(wsUrl: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    const to = setTimeout(() => { try { ws.terminate(); } catch {} reject(new WaError('CDP_UNREACHABLE', 'CDP websocket connect timeout')); }, 8000);
    let id = 0;
    const pending = new Map<number, { res: (v: any) => void; rej: (e: any) => void }>();
    ws.on('message', (buf: any) => {
      let m: any; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id)!;
        pending.delete(m.id);
        m.error ? rej(new WaError('CDP_ERROR', JSON.stringify(m.error))) : res(m.result);
      }
    });
    ws.on('error', (e: any) => { clearTimeout(to); reject(new WaError('CDP_UNREACHABLE', String(e.message || e))); });
    ws.on('open', () => {
      clearTimeout(to);
      const send = (method: string, params: any = {}) => new Promise((res, rej) => {
        const mid = ++id;
        pending.set(mid, { res, rej });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
      const cdp: Cdp = {
        async evaluate(expr: string) {
          const r: any = await send('Runtime.evaluate', {
            expression: `(async()=>{${expr}})()`,
            awaitPromise: true,
            returnByValue: true,
          });
          if (r.exceptionDetails) {
            throw new WaError('PAGE_EVAL_ERROR', r.exceptionDetails.exception?.description || 'page eval error');
          }
          return r.result.value;
        },
        async click(x: number, y: number) {
          const base = { x, y, button: 'left', clickCount: 1 };
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
        },
        async insertText(text: string) { await send('Input.insertText', { text }); },
        async pressEnter() {
          const k = { windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' };
          await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
          await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...k });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
        },
        close() { try { ws.close(); } catch {} },
      };
      send('Runtime.enable').then(() => resolve(cdp)).catch(reject);
    });
  });
}

async function withCdp<T>(params: any, fn: (cdp: Cdp) => Promise<T>): Promise<T> {
  const base = resolveBase(params);
  const wsUrl = await findPageWs(base);
  const cdp = await connect(wsUrl);
  try { return await fn(cdp); } finally { cdp.close(); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- page-side snippets (run inside WhatsApp Web) --------------------------
// DOM facts (WhatsApp Web mid-2026): chat rows = #pane-side [role="row"];
// messages = #main [data-pre-plain-text] (meta "[HH:MM, date] Sender: "),
// text = span.selectable-text; compose = footer div[contenteditable="true"].

const JS_STATUS = `
  const loggedIn = !!document.querySelector('#pane-side');
  const qr = !!document.querySelector('canvas[aria-label], div[data-ref]');
  return { loggedIn, qrVisible: qr && !loggedIn, title: document.title };
`;

const JS_CHATS = `
  const rows = [...document.querySelectorAll('#pane-side [role="row"]')];
  return rows.map(row => {
    const titles = [...row.querySelectorAll('span[title]')].map(s => s.getAttribute('title'));
    const name = titles[0] || '';
    const preview = titles.length > 1 ? titles[titles.length-1] : '';
    const unread = row.querySelector('span[aria-label*="unread"], span[aria-label*="未读"]')?.getAttribute('aria-label') || '';
    return { name, preview, unread };
  }).filter(r => r.name);
`;

function jsLocate(name: string): string {
  const nm = JSON.stringify(name);
  return `
    const want = ${nm};
    const rowFor = () => {
      const s = [...document.querySelectorAll('#pane-side [role="row"] span[title]')]
                  .find(s => s.getAttribute('title') === want);
      return s ? s.closest('[role="row"]') : null;
    };
    let row = rowFor();
    if (!row) {
      const sb = document.querySelector('div[contenteditable="true"][data-tab="3"]');
      if (sb) { sb.focus(); document.execCommand('selectAll',false,null); document.execCommand('insertText',false,want); }
      await new Promise(r=>setTimeout(r,1300));
      row = rowFor();
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
    const els = [...document.querySelectorAll('#main [data-pre-plain-text]')];
    const msgs = els.slice(-${n}).map(r => {
      const meta = r.getAttribute('data-pre-plain-text') || '';
      const m = meta.match(/^\\[(.*?)\\]\\s*(.*?):\\s*$/);
      const t = r.querySelector('span.selectable-text')?.innerText ?? r.innerText ?? '';
      return { time: m ? m[1] : null, sender: m ? m[2] : null, text: (t||'').trim() };
    });
    return { header, messages: msgs };
  `;
}

const JS_COMPOSE_XY = `
  const box = document.querySelector('footer div[contenteditable="true"][data-tab="10"]')
           || document.querySelector('footer div[contenteditable="true"]');
  if (!box) return { ok:false };
  const r = box.getBoundingClientRect();
  return { ok:true, x: r.left + r.width/2, y: r.top + r.height/2 };
`;

// ---- action implementations ----------------------------------------------

async function assertLoggedIn(cdp: Cdp) {
  const s = await cdp.evaluate(JS_STATUS);
  if (!s.loggedIn) throw new WaError('NOT_LOGGED_IN', s.qrVisible ? 'WhatsApp Web shows the QR login screen (not paired)' : 'WhatsApp Web not logged in / not ready');
}

async function openChat(cdp: Cdp, name: string) {
  const loc = await cdp.evaluate(jsLocate(name));
  if (!loc.ok) throw new WaError('CHAT_NOT_FOUND', `chat not found: ${name}`);
  await cdp.click(loc.x, loc.y);
  await sleep(700);
}

const ACTION_HANDLERS: Record<string, (params: any) => Promise<any>> = {
  async status(params) {
    return withCdp(params, async (cdp) => cdp.evaluate(JS_STATUS));
  },
  async chats(params) {
    return withCdp(params, async (cdp) => {
      await assertLoggedIn(cdp);
      const chats = await cdp.evaluate(JS_CHATS);
      return { count: chats.length, chats };
    });
  },
  async open(params) {
    if (!params.name) throw new WaError('BAD_REQUEST', 'open requires "name"');
    return withCdp(params, async (cdp) => {
      await assertLoggedIn(cdp);
      await openChat(cdp, params.name);
      return { opened: params.name };
    });
  },
  async read(params) {
    const n = Math.max(1, Math.min(200, parseInt(params.n, 10) || 30));
    return withCdp(params, async (cdp) => {
      await assertLoggedIn(cdp);
      if (params.name) await openChat(cdp, params.name);
      const r = await cdp.evaluate(jsRead(n));
      if (!r.header && (!r.messages || !r.messages.length)) throw new WaError('NO_CHAT_OPEN', 'no chat is open (pass "name" to open one first)');
      return r;
    });
  },
  async type(params) {
    return typeOrSend(params, false);
  },
  async send(params) {
    return typeOrSend(params, true);
  },
};

async function typeOrSend(params: any, doSend: boolean) {
  if (!params.text) throw new WaError('BAD_REQUEST', `${doSend ? 'send' : 'type'} requires "text"`);
  return withCdp(params, async (cdp) => {
    await assertLoggedIn(cdp);
    if (params.name) await openChat(cdp, params.name);
    const box = await cdp.evaluate(JS_COMPOSE_XY);
    if (!box.ok) throw new WaError('NO_CHAT_OPEN', 'compose box not found — open a chat first (pass "name")');
    await cdp.click(box.x, box.y);
    await sleep(200);
    await cdp.insertText(String(params.text));
    await sleep(250);
    if (doSend) { await cdp.pressEnter(); await sleep(300); }
    return { chat: params.name || '(open chat)', sent: doSend };
  });
}

// ---- public API -----------------------------------------------------------

export const WHATSAPP_ACTIONS = [
  { action: 'status', scope: 'read', params: ['cdpUrl?', 'port?'], desc: 'CDP reachability + logged-in state' },
  { action: 'chats', scope: 'read', params: ['cdpUrl?', 'port?'], desc: 'list conversations in the side pane' },
  { action: 'read', scope: 'read', params: ['name?', 'n?', 'cdpUrl?', 'port?'], desc: 'read last N messages (opens "name" if given, else the open chat)' },
  { action: 'open', scope: 'write', params: ['name', 'cdpUrl?', 'port?'], desc: 'open a chat by contact/group name' },
  { action: 'type', scope: 'write', params: ['name?', 'text', 'cdpUrl?', 'port?'], desc: 'stage text in the compose box WITHOUT sending' },
  { action: 'send', scope: 'write', params: ['name?', 'text', 'cdpUrl?', 'port?'], desc: 'type text and press Enter (SENDS)' },
];

export async function runAction(action: string, params: any = {}): Promise<any> {
  const fn = ACTION_HANDLERS[action];
  if (!fn) return { ok: false, error: { code: 'UNKNOWN_ACTION', message: `unknown action: ${action}` } };
  try {
    const data = await fn(params || {});
    return { ok: true, data };
  } catch (e: any) {
    const code = e instanceof WaError ? e.code : 'SERVER';
    log(action, 'failed:', code, e.message);
    return { ok: false, error: { code, message: String(e.message || e) } };
  }
}
