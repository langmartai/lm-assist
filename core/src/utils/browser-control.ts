/**
 * Generic browser control via Chrome DevTools Protocol.
 *
 * Targets any Chrome that was started with `--remote-debugging-port=<n>`,
 * including the one spawned by /claude-ai/browser/launch (port 9222 by
 * default). Provides a thin, typed surface over CDP for tab management,
 * navigation, JS evaluation, cookie + DOM inspection, and screenshots.
 *
 * Not claude.ai-specific — the claude.ai capture flow is one consumer.
 * Other callers (debugging tools, integration tests, agents) can use the
 * same surface when a Chrome MCP isn't loaded or isn't suitable.
 */

import * as http from 'http';
import WebSocket from 'ws';

// ─────────────────────────────────────────────────────────────────────────────
// Low-level CDP primitives
// ─────────────────────────────────────────────────────────────────────────────

export interface CDPTarget {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl: string;
}

export interface CDPVersionInfo {
  webSocketDebuggerUrl: string;
  'User-Agent'?: string;
  Browser?: string;
}

/** HTTP GET helper for the CDP JSON endpoints. Tight timeout (3s) by default. */
export function httpGetJSON<T>(url: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch (e) {
          reject(new Error(`Invalid JSON from ${url}: ${(e as Error).message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout (${timeoutMs}ms) fetching ${url}`)));
  });
}

/**
 * Variant of httpGetJSON that PUTs to a JSON endpoint. Chrome's /json/new
 * accepts PUT; the response body is the new target descriptor.
 */
export function httpPutJSON<T>(url: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'PUT',
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(data) as T); }
          catch (e) { reject(new Error(`Invalid JSON from ${url}: ${(e as Error).message}`)); }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout (${timeoutMs}ms) PUT ${url}`)));
    req.end();
  });
}

/** One-shot CDP command — opens WS, sends, closes. Use this for stateless calls. */
export function sendCDP<T>(wsUrl: string, method: string, params: object = {}, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => { ws.close(); reject(new Error(`CDP ${method} timeout after ${timeoutMs}ms`)); }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ id, method, params })));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { id: number; result?: T; error?: { code: number; message: string } };
        if (msg.id === id) {
          clearTimeout(timer);
          ws.close();
          if (msg.error) reject(new Error(`CDP ${method} error: ${msg.error.message}`));
          else resolve(msg.result as T);
        }
      } catch (e) {
        clearTimeout(timer);
        ws.close();
        reject(e);
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Persistent CDP session — opens one WS, sends many commands. Needed when
 * a command's effect dies if the session disconnects (e.g.
 * Page.addScriptToEvaluateOnNewDocument is auto-removed when its client
 * disconnects).
 */
export class CDPSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private opened: Promise<void>;
  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.opened = new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { id?: number; error?: { message: string }; result?: unknown };
        if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
          const slot = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) slot.reject(new Error(msg.error.message));
          else slot.resolve(msg.result);
        }
      } catch { /* ignore malformed */ }
    });
  }
  async ready(): Promise<void> { await this.opened; }
  async send<T = unknown>(method: string, params: object = {}, timeoutMs = 5000): Promise<T> {
    await this.opened;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close(): void { try { this.ws.close(); } catch { /* ignore */ } }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab-level helpers — find a target's WS URL by id
// ─────────────────────────────────────────────────────────────────────────────

export async function listTargets(port: number): Promise<CDPTarget[]> {
  return httpGetJSON<CDPTarget[]>(`http://127.0.0.1:${port}/json/list`);
}

export async function findTargetWS(port: number, tabId: string): Promise<string | null> {
  const targets = await listTargets(port);
  const t = targets.find((x) => x.id === tabId);
  return t?.webSocketDebuggerUrl || null;
}

export interface ControlError {
  code:
    | 'debug_port_unreachable'
    | 'tab_not_found'
    | 'cdp_error'
    | 'invalid_request';
  message: string;
  hint?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 1: Tab CRUD
// ─────────────────────────────────────────────────────────────────────────────

export async function listTabs(port: number): Promise<{ ok: true; tabs: Array<Pick<CDPTarget, 'id' | 'type' | 'url' | 'title'>> } | { ok: false; error: ControlError }> {
  try {
    const all = await listTargets(port);
    return {
      ok: true,
      tabs: all
        .filter((t) => t.type === 'page' || t.type === 'iframe' || t.type === 'background_page' || t.type === 'service_worker')
        .map((t) => ({ id: t.id, type: t.type, url: t.url, title: t.title })),
    };
  } catch (e) {
    return { ok: false, error: { code: 'debug_port_unreachable', message: (e as Error).message } };
  }
}

export async function createTab(port: number, url?: string): Promise<{ ok: true; tab: CDPTarget } | { ok: false; error: ControlError }> {
  try {
    const path = url ? `/json/new?${encodeURIComponent(url)}` : `/json/new`;
    const target = await httpPutJSON<CDPTarget>(`http://127.0.0.1:${port}${path}`);
    return { ok: true, tab: target };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

export async function closeTab(port: number, tabId: string): Promise<{ ok: true } | { ok: false; error: ControlError }> {
  try {
    // /json/close/:id returns a string body, not JSON. Use raw HTTP.
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(tabId)}`, (res) => {
        res.on('data', () => undefined);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`HTTP ${res.statusCode}`));
        });
      });
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('Timeout closing tab')));
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2: Navigation + scripting
// ─────────────────────────────────────────────────────────────────────────────

export async function navigateTab(
  port: number,
  tabId: string,
  opts: { url?: string; direction?: 'back' | 'forward' | 'reload' },
): Promise<{ ok: true; frameId?: string; loaderId?: string } | { ok: false; error: ControlError }> {
  const wsUrl = await findTargetWS(port, tabId);
  if (!wsUrl) return { ok: false, error: { code: 'tab_not_found', message: `No CDP target with id=${tabId}` } };
  try {
    if (opts.url) {
      const result = await sendCDP<{ frameId?: string; loaderId?: string; errorText?: string }>(
        wsUrl, 'Page.navigate', { url: opts.url },
      );
      if (result?.errorText) {
        return { ok: false, error: { code: 'cdp_error', message: `Page.navigate: ${result.errorText}` } };
      }
      return { ok: true, frameId: result?.frameId, loaderId: result?.loaderId };
    }
    if (opts.direction === 'reload') {
      await sendCDP(wsUrl, 'Page.reload', {});
      return { ok: true };
    }
    if (opts.direction === 'back' || opts.direction === 'forward') {
      // History navigation: get entries, find current, jump by ±1.
      const hist = await sendCDP<{ currentIndex: number; entries: Array<{ id: number }> }>(wsUrl, 'Page.getNavigationHistory');
      const delta = opts.direction === 'back' ? -1 : 1;
      const targetIdx = hist.currentIndex + delta;
      const entry = hist.entries[targetIdx];
      if (!entry) {
        return { ok: false, error: { code: 'invalid_request', message: `Cannot go ${opts.direction}: at history boundary` } };
      }
      await sendCDP(wsUrl, 'Page.navigateToHistoryEntry', { entryId: entry.id });
      return { ok: true };
    }
    return { ok: false, error: { code: 'invalid_request', message: 'Provide either url or direction' } };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

export async function evalInTab(
  port: number,
  tabId: string,
  opts: { expression: string; returnByValue?: boolean; awaitPromise?: boolean; timeoutMs?: number },
): Promise<{ ok: true; result: unknown; exceptionDetails?: unknown } | { ok: false; error: ControlError }> {
  const wsUrl = await findTargetWS(port, tabId);
  if (!wsUrl) return { ok: false, error: { code: 'tab_not_found', message: `No CDP target with id=${tabId}` } };
  try {
    const res = await sendCDP<{ result: { value?: unknown; description?: string }; exceptionDetails?: unknown }>(
      wsUrl, 'Runtime.evaluate',
      {
        expression: opts.expression,
        returnByValue: opts.returnByValue !== false,
        awaitPromise: opts.awaitPromise !== false,
      },
      opts.timeoutMs ?? 10000,
    );
    return {
      ok: true,
      result: res.result?.value !== undefined ? res.result.value : res.result?.description,
      exceptionDetails: res.exceptionDetails,
    };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

interface CDPCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: string;
}

export async function getCookies(
  port: number,
  tabId: string | undefined,
  opts: { domain?: string },
): Promise<{ ok: true; cookies: CDPCookie[] } | { ok: false; error: ControlError }> {
  // Cookies live at the browser level — tab id is informational here.
  try {
    const version = await httpGetJSON<CDPVersionInfo>(`http://127.0.0.1:${port}/json/version`);
    const wsUrl = version.webSocketDebuggerUrl;
    let cookieResp: { cookies: CDPCookie[] };
    try {
      cookieResp = await sendCDP<{ cookies: CDPCookie[] }>(wsUrl, 'Storage.getCookies');
    } catch {
      cookieResp = await sendCDP<{ cookies: CDPCookie[] }>(wsUrl, 'Network.getAllCookies');
    }
    let cookies = cookieResp.cookies;
    if (opts.domain) {
      const d = opts.domain.toLowerCase().replace(/^\./, '');
      cookies = cookies.filter((c) => {
        const cd = c.domain.toLowerCase().replace(/^\./, '');
        return cd === d || cd.endsWith(`.${d}`);
      });
    }
    return { ok: true, cookies };
  } catch (e) {
    return { ok: false, error: { code: 'debug_port_unreachable', message: (e as Error).message } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 3: Page inspection
// ─────────────────────────────────────────────────────────────────────────────

export async function getPageText(
  port: number,
  tabId: string,
  opts: { maxBytes?: number } = {},
): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; error: ControlError }> {
  const wsUrl = await findTargetWS(port, tabId);
  if (!wsUrl) return { ok: false, error: { code: 'tab_not_found', message: `No CDP target with id=${tabId}` } };
  const maxBytes = opts.maxBytes ?? 200_000;
  try {
    const res = await sendCDP<{ result: { value?: string } }>(wsUrl, 'Runtime.evaluate', {
      expression: '(document.body && document.body.innerText) || ""',
      returnByValue: true,
    });
    const full = res.result?.value || '';
    if (full.length > maxBytes) {
      return { ok: true, text: full.slice(0, maxBytes), truncated: true };
    }
    return { ok: true, text: full, truncated: false };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

export async function getPageHTML(
  port: number,
  tabId: string,
  opts: { maxBytes?: number } = {},
): Promise<{ ok: true; html: string; truncated: boolean } | { ok: false; error: ControlError }> {
  const wsUrl = await findTargetWS(port, tabId);
  if (!wsUrl) return { ok: false, error: { code: 'tab_not_found', message: `No CDP target with id=${tabId}` } };
  const maxBytes = opts.maxBytes ?? 500_000;
  try {
    const res = await sendCDP<{ result: { value?: string } }>(wsUrl, 'Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true,
    });
    const full = res.result?.value || '';
    if (full.length > maxBytes) {
      return { ok: true, html: full.slice(0, maxBytes), truncated: true };
    }
    return { ok: true, html: full, truncated: false };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 3b: DOM interaction — click / type / wait-for
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Click an element matched by a CSS selector. Uses element.click() via
 * Runtime.evaluate which fires a synthetic MouseEvent — works for almost
 * every site and avoids the coordinate math + iframe gotchas that
 * Input.dispatchMouseEvent runs into. Pages that gate behavior on
 * isTrusted=true won't trigger via this path; for those, use eval directly.
 */
export async function clickElement(
  port: number,
  tabId: string,
  opts: { selector: string; allMatches?: boolean },
): Promise<{ ok: true; matched: number } | { ok: false; error: ControlError }> {
  const wsUrl = await findTargetWS(port, tabId);
  if (!wsUrl) return { ok: false, error: { code: 'tab_not_found', message: `No CDP target with id=${tabId}` } };
  const expr = opts.allMatches
    ? `(() => { const all = document.querySelectorAll(${JSON.stringify(opts.selector)}); all.forEach(e => e.click()); return all.length; })()`
    : `(() => { const e = document.querySelector(${JSON.stringify(opts.selector)}); if (!e) return 0; e.click(); return 1; })()`;
  try {
    const res = await sendCDP<{ result: { value?: number } }>(wsUrl, 'Runtime.evaluate', {
      expression: expr, returnByValue: true,
    });
    const matched = res.result?.value ?? 0;
    if (matched === 0) {
      return { ok: false, error: { code: 'invalid_request', message: `No element matched selector: ${opts.selector}` } };
    }
    return { ok: true, matched };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

/**
 * Type text into a field matched by CSS selector. Sets .value AND
 * dispatches `input` + `change` events so React/Vue/Svelte handlers fire.
 * Pass `clear: true` to wipe the existing value first.
 */
export async function typeIntoElement(
  port: number,
  tabId: string,
  opts: { selector: string; text: string; clear?: boolean },
): Promise<{ ok: true } | { ok: false; error: ControlError }> {
  const wsUrl = await findTargetWS(port, tabId);
  if (!wsUrl) return { ok: false, error: { code: 'tab_not_found', message: `No CDP target with id=${tabId}` } };
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(opts.selector)});
    if (!el) return { ok: false, reason: 'not_found' };
    el.focus();
    if (${opts.clear ? 'true' : 'false'}) el.value = '';
    // React/Vue use property descriptor setter — use native to bypass overrides
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    const setter = desc && desc.set;
    const newValue = (el.value || '') + ${JSON.stringify(opts.text)};
    if (setter) setter.call(el, newValue); else el.value = newValue;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`;
  try {
    const res = await sendCDP<{ result: { value?: { ok: boolean; reason?: string } } }>(wsUrl, 'Runtime.evaluate', {
      expression: expr, returnByValue: true,
    });
    const v = res.result?.value;
    if (!v?.ok) return { ok: false, error: { code: 'invalid_request', message: `No element matched: ${opts.selector}` } };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

/**
 * Wait for a selector to appear OR for the page URL to match a regex.
 * Returns as soon as either condition is met. Polls every 200ms by default.
 */
export async function waitFor(
  port: number,
  tabId: string,
  opts: { selector?: string; urlPattern?: string; timeoutMs?: number; intervalMs?: number },
): Promise<{ ok: true; matchedOn: 'selector' | 'urlPattern'; elapsedMs: number; url?: string } | { ok: false; error: ControlError }> {
  if (!opts.selector && !opts.urlPattern) {
    return { ok: false, error: { code: 'invalid_request', message: 'Provide selector or urlPattern' } };
  }
  const timeoutMs = opts.timeoutMs ?? 10000;
  const intervalMs = opts.intervalMs ?? 200;
  const start = Date.now();
  let urlRe: RegExp | null = null;
  if (opts.urlPattern) {
    try { urlRe = new RegExp(opts.urlPattern); } catch (e) {
      return { ok: false, error: { code: 'invalid_request', message: `Invalid urlPattern regex: ${(e as Error).message}` } };
    }
  }
  while (Date.now() - start < timeoutMs) {
    const wsUrl = await findTargetWS(port, tabId);
    if (!wsUrl) return { ok: false, error: { code: 'tab_not_found', message: `No CDP target with id=${tabId}` } };
    try {
      const probeExpr = `JSON.stringify({
        url: location.href,
        selectorMatched: ${opts.selector ? `!!document.querySelector(${JSON.stringify(opts.selector)})` : 'false'}
      })`;
      const res = await sendCDP<{ result: { value?: string } }>(wsUrl, 'Runtime.evaluate', { expression: probeExpr, returnByValue: true });
      const v = JSON.parse(res.result?.value || '{}') as { url: string; selectorMatched: boolean };
      if (v.selectorMatched) return { ok: true, matchedOn: 'selector', elapsedMs: Date.now() - start, url: v.url };
      if (urlRe && urlRe.test(v.url)) return { ok: true, matchedOn: 'urlPattern', elapsedMs: Date.now() - start, url: v.url };
    } catch { /* transient; retry */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, error: { code: 'cdp_error', message: `Wait timed out after ${timeoutMs}ms` } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 3c: Web Storage + Cookie writes
// ─────────────────────────────────────────────────────────────────────────────

export async function getStorage(
  port: number,
  tabId: string,
  opts: { type: 'local' | 'session' },
): Promise<{ ok: true; entries: Record<string, string> } | { ok: false; error: ControlError }> {
  const wsUrl = await findTargetWS(port, tabId);
  if (!wsUrl) return { ok: false, error: { code: 'tab_not_found', message: `No CDP target with id=${tabId}` } };
  const obj = opts.type === 'session' ? 'sessionStorage' : 'localStorage';
  try {
    const res = await sendCDP<{ result: { value?: string } }>(wsUrl, 'Runtime.evaluate', {
      expression: `JSON.stringify(Object.fromEntries(Object.keys(${obj}).map(k => [k, ${obj}.getItem(k)])))`,
      returnByValue: true,
    });
    const entries = JSON.parse(res.result?.value || '{}');
    return { ok: true, entries };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

export async function setStorage(
  port: number,
  tabId: string,
  opts: { type: 'local' | 'session'; key: string; value: string },
): Promise<{ ok: true } | { ok: false; error: ControlError }> {
  const wsUrl = await findTargetWS(port, tabId);
  if (!wsUrl) return { ok: false, error: { code: 'tab_not_found', message: `No CDP target with id=${tabId}` } };
  const obj = opts.type === 'session' ? 'sessionStorage' : 'localStorage';
  try {
    await sendCDP(wsUrl, 'Runtime.evaluate', {
      expression: `${obj}.setItem(${JSON.stringify(opts.key)}, ${JSON.stringify(opts.value)})`,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

export async function deleteStorage(
  port: number,
  tabId: string,
  opts: { type: 'local' | 'session'; key?: string },
): Promise<{ ok: true } | { ok: false; error: ControlError }> {
  const wsUrl = await findTargetWS(port, tabId);
  if (!wsUrl) return { ok: false, error: { code: 'tab_not_found', message: `No CDP target with id=${tabId}` } };
  const obj = opts.type === 'session' ? 'sessionStorage' : 'localStorage';
  const expr = opts.key
    ? `${obj}.removeItem(${JSON.stringify(opts.key)})`
    : `${obj}.clear()`;
  try {
    await sendCDP(wsUrl, 'Runtime.evaluate', { expression: expr });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

export async function setCookies(
  port: number,
  opts: { cookies: Array<{ name: string; value: string; domain?: string; path?: string; url?: string; expires?: number; secure?: boolean; httpOnly?: boolean; sameSite?: 'Strict' | 'Lax' | 'None' }> },
): Promise<{ ok: true; set: number } | { ok: false; error: ControlError }> {
  try {
    const version = await httpGetJSON<CDPVersionInfo>(`http://127.0.0.1:${port}/json/version`);
    const wsUrl = version.webSocketDebuggerUrl;
    await sendCDP(wsUrl, 'Storage.setCookies', { cookies: opts.cookies });
    return { ok: true, set: opts.cookies.length };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

export async function deleteCookies(
  port: number,
  opts: { name?: string; domain?: string; url?: string; clearAll?: boolean },
): Promise<{ ok: true; mode: 'cleared_all' | 'filtered'; deleted?: number } | { ok: false; error: ControlError }> {
  try {
    const version = await httpGetJSON<CDPVersionInfo>(`http://127.0.0.1:${port}/json/version`);
    const browserWS = version.webSocketDebuggerUrl;
    if (opts.clearAll) {
      // Storage.clearCookies IS supported at browser target.
      await sendCDP(browserWS, 'Storage.clearCookies');
      return { ok: true, mode: 'cleared_all' };
    }
    if (!opts.name) {
      return { ok: false, error: { code: 'invalid_request', message: 'Provide either { clearAll: true } or { name, domain?/url? }' } };
    }
    // Network.deleteCookies is only available on a PAGE target in modern
    // Chrome — not the browser-level endpoint. Route through any page.
    const targets = await listTargets(port);
    const page = targets.find((t) => t.type === 'page');
    if (!page) {
      return { ok: false, error: { code: 'cdp_error', message: 'No page target available to route Network.deleteCookies through. Open a tab first.' } };
    }
    await sendCDP(page.webSocketDebuggerUrl, 'Network.deleteCookies', {
      name: opts.name,
      ...(opts.domain ? { domain: opts.domain } : {}),
      ...(opts.url ? { url: opts.url } : {}),
    });
    return { ok: true, mode: 'filtered' };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 3d: Viewport, key dispatch, find-by-text
// ─────────────────────────────────────────────────────────────────────────────

export async function setViewport(
  port: number,
  tabId: string,
  opts: { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean },
): Promise<{ ok: true } | { ok: false; error: ControlError }> {
  const wsUrl = await findTargetWS(port, tabId);
  if (!wsUrl) return { ok: false, error: { code: 'tab_not_found', message: `No CDP target with id=${tabId}` } };
  try {
    await sendCDP(wsUrl, 'Emulation.setDeviceMetricsOverride', {
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: opts.deviceScaleFactor ?? 1,
      mobile: opts.mobile ?? false,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

/**
 * Press a key combination (Ctrl+T, Cmd+K, Tab, etc.). Uses Input.dispatchKeyEvent
 * which simulates real keyboard input — important for shortcuts the page
 * listens for via addEventListener('keydown').
 */
export async function pressKey(
  port: number,
  tabId: string,
  opts: { key: string; modifiers?: Array<'ctrl' | 'alt' | 'shift' | 'meta'> },
): Promise<{ ok: true } | { ok: false; error: ControlError }> {
  const wsUrl = await findTargetWS(port, tabId);
  if (!wsUrl) return { ok: false, error: { code: 'tab_not_found', message: `No CDP target with id=${tabId}` } };
  // CDP modifier bitmask: alt=1, ctrl=2, meta=4, shift=8.
  const mods = (opts.modifiers || []).reduce((acc, m) => {
    return acc | ({ alt: 1, ctrl: 2, meta: 4, shift: 8 } as const)[m];
  }, 0);
  // CDP wants windowsVirtualKeyCode + key name. Use minimal common mappings;
  // single chars fall through to .toUpperCase() as VK code.
  const KEYS: Record<string, { code: string; vk: number }> = {
    Enter: { code: 'Enter', vk: 13 },
    Tab: { code: 'Tab', vk: 9 },
    Escape: { code: 'Escape', vk: 27 },
    Backspace: { code: 'Backspace', vk: 8 },
    Delete: { code: 'Delete', vk: 46 },
    ArrowUp: { code: 'ArrowUp', vk: 38 },
    ArrowDown: { code: 'ArrowDown', vk: 40 },
    ArrowLeft: { code: 'ArrowLeft', vk: 37 },
    ArrowRight: { code: 'ArrowRight', vk: 39 },
    Space: { code: 'Space', vk: 32 },
  };
  const norm = opts.key.length === 1 ? { code: `Key${opts.key.toUpperCase()}`, vk: opts.key.toUpperCase().charCodeAt(0) } : KEYS[opts.key];
  if (!norm) return { ok: false, error: { code: 'invalid_request', message: `Unsupported key: ${opts.key}` } };
  try {
    await sendCDP(wsUrl, 'Input.dispatchKeyEvent', { type: 'keyDown', key: opts.key, code: norm.code, windowsVirtualKeyCode: norm.vk, modifiers: mods });
    await sendCDP(wsUrl, 'Input.dispatchKeyEvent', { type: 'keyUp', key: opts.key, code: norm.code, windowsVirtualKeyCode: norm.vk, modifiers: mods });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

/**
 * Find DOM elements by visible text, optionally narrowed by tag.
 * Returns first N matches with selector path that addresses each element.
 */
export async function findByText(
  port: number,
  tabId: string,
  opts: { text: string; tag?: string; limit?: number },
): Promise<{ ok: true; matches: Array<{ tag: string; text: string; cssSelector: string; visible: boolean }> } | { ok: false; error: ControlError }> {
  const wsUrl = await findTargetWS(port, tabId);
  if (!wsUrl) return { ok: false, error: { code: 'tab_not_found', message: `No CDP target with id=${tabId}` } };
  const limit = opts.limit ?? 10;
  const tag = opts.tag ? opts.tag.toUpperCase() : null;
  const expr = `JSON.stringify((() => {
    const needle = ${JSON.stringify(opts.text.toLowerCase())};
    const tagFilter = ${JSON.stringify(tag)};
    const limit = ${limit};
    const out = [];
    const cssFor = el => {
      const parts = [];
      while (el && el.nodeType === 1 && parts.length < 6) {
        let s = el.nodeName.toLowerCase();
        if (el.id) { s += '#' + el.id; parts.unshift(s); break; }
        const cls = (el.className && typeof el.className === 'string')
          ? el.className.trim().split(/\\s+/).slice(0, 2).map(c => '.' + c).join('') : '';
        s += cls;
        const sib = Array.from(el.parentElement ? el.parentElement.children : []).filter(c => c.nodeName === el.nodeName);
        if (sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(el) + 1) + ')';
        parts.unshift(s);
        el = el.parentElement;
      }
      return parts.join(' > ');
    };
    for (const el of document.querySelectorAll('*')) {
      if (out.length >= limit) break;
      if (tagFilter && el.nodeName !== tagFilter) continue;
      const text = (el.innerText || el.textContent || '').trim();
      if (!text || !text.toLowerCase().includes(needle)) continue;
      // Skip elements whose text is from descendants only
      const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      if (!own.toLowerCase().includes(needle) && el.childElementCount > 0) continue;
      const rect = el.getBoundingClientRect();
      out.push({
        tag: el.nodeName,
        text: text.length > 200 ? text.slice(0, 200) + '…' : text,
        cssSelector: cssFor(el),
        visible: rect.width > 0 && rect.height > 0,
      });
    }
    return out;
  })())`;
  try {
    const res = await sendCDP<{ result: { value?: string } }>(wsUrl, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    return { ok: true, matches: JSON.parse(res.result?.value || '[]') };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 3e: Console + Network taps (via page-script injection)
// ─────────────────────────────────────────────────────────────────────────────

const CONSOLE_TAP_SCRIPT = `
(function() {
  if (window.__lmAssistConsoleTap) return;
  window.__lmAssistConsoleTap = { buffer: [], maxBuffer: 500 };
  const tap = window.__lmAssistConsoleTap;
  const fmt = a => {
    try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
    catch { return String(a); }
  };
  ['log', 'warn', 'error', 'info', 'debug'].forEach(level => {
    const orig = console[level];
    console[level] = function() {
      try {
        tap.buffer.push({
          level,
          ts: Date.now(),
          args: Array.from(arguments).map(fmt),
          url: location.href,
        });
        if (tap.buffer.length > tap.maxBuffer) tap.buffer.shift();
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  });
  window.addEventListener('error', e => {
    tap.buffer.push({ level: 'page-error', ts: Date.now(), args: [e.message + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0)], url: location.href });
  });
  window.addEventListener('unhandledrejection', e => {
    tap.buffer.push({ level: 'unhandled-promise', ts: Date.now(), args: [String(e.reason)], url: location.href });
  });
})();
`;

const NETWORK_TAP_SCRIPT = `
(function() {
  if (window.__lmAssistNetworkTap) return;
  window.__lmAssistNetworkTap = { buffer: [], maxBuffer: 200 };
  const tap = window.__lmAssistNetworkTap;
  const push = entry => {
    tap.buffer.push(entry);
    if (tap.buffer.length > tap.maxBuffer) tap.buffer.shift();
  };
  // fetch
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function(input, init) {
      const t0 = Date.now();
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      const id = 'f' + (tap.buffer.length + 1) + '-' + t0;
      return origFetch.apply(this, arguments).then(r => {
        push({ id, kind: 'fetch', url, method, status: r.status, ok: r.ok, type: r.type, durationMs: Date.now() - t0, ts: t0 });
        return r;
      }, err => {
        push({ id, kind: 'fetch', url, method, status: 0, error: String(err && err.message || err), durationMs: Date.now() - t0, ts: t0 });
        throw err;
      });
    };
  }
  // XHR
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__lmAssistInfo = { method, url, t0: 0 };
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    if (this.__lmAssistInfo) {
      this.__lmAssistInfo.t0 = Date.now();
      this.addEventListener('loadend', () => {
        const i = this.__lmAssistInfo;
        push({ id: 'x' + i.t0, kind: 'xhr', url: i.url, method: i.method, status: this.status, durationMs: Date.now() - i.t0, ts: i.t0 });
      });
    }
    return origSend.apply(this, arguments);
  };
})();
`;

export async function installConsoleTap(port: number, tabId: string): Promise<{ ok: true } | { ok: false; error: ControlError }> {
  const wsUrl = await findTargetWS(port, tabId);
  if (!wsUrl) return { ok: false, error: { code: 'tab_not_found', message: `No CDP target with id=${tabId}` } };
  try {
    // Inject NOW for the current document; new docs need a persistent
    // session via Page.addScriptToEvaluateOnNewDocument — caller can pair
    // with installOverlay-style retention if survival across nav is needed.
    await sendCDP(wsUrl, 'Runtime.evaluate', { expression: CONSOLE_TAP_SCRIPT });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

export async function readConsoleMessages(
  port: number,
  tabId: string,
  opts: { since?: number; limit?: number; clear?: boolean } = {},
): Promise<{ ok: true; messages: Array<{ level: string; ts: number; args: string[]; url: string }>; total: number } | { ok: false; error: ControlError }> {
  const wsUrl = await findTargetWS(port, tabId);
  if (!wsUrl) return { ok: false, error: { code: 'tab_not_found', message: `No CDP target with id=${tabId}` } };
  const since = opts.since ?? 0;
  const limit = opts.limit ?? 100;
  const expr = `(() => {
    if (!window.__lmAssistConsoleTap) return null;
    const buf = window.__lmAssistConsoleTap.buffer || [];
    const filtered = buf.filter(m => m.ts >= ${since});
    const out = filtered.slice(-${limit});
    if (${opts.clear ? 'true' : 'false'}) window.__lmAssistConsoleTap.buffer = [];
    return { messages: out, total: buf.length };
  })()`;
  try {
    const res = await sendCDP<{ result: { value?: { messages: unknown[]; total: number } | null } }>(wsUrl, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    const v = res.result?.value;
    if (!v) return { ok: false, error: { code: 'invalid_request', message: 'Console tap not installed. POST /browser/tabs/:id/console first.' } };
    return { ok: true, messages: v.messages as Array<{ level: string; ts: number; args: string[]; url: string }>, total: v.total };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

export async function installNetworkTap(port: number, tabId: string): Promise<{ ok: true } | { ok: false; error: ControlError }> {
  const wsUrl = await findTargetWS(port, tabId);
  if (!wsUrl) return { ok: false, error: { code: 'tab_not_found', message: `No CDP target with id=${tabId}` } };
  try {
    await sendCDP(wsUrl, 'Runtime.evaluate', { expression: NETWORK_TAP_SCRIPT });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

export async function readNetworkRequests(
  port: number,
  tabId: string,
  opts: { since?: number; limit?: number; urlPattern?: string; clear?: boolean } = {},
): Promise<{ ok: true; requests: unknown[]; total: number } | { ok: false; error: ControlError }> {
  const wsUrl = await findTargetWS(port, tabId);
  if (!wsUrl) return { ok: false, error: { code: 'tab_not_found', message: `No CDP target with id=${tabId}` } };
  const since = opts.since ?? 0;
  const limit = opts.limit ?? 100;
  let pattern: RegExp | null = null;
  if (opts.urlPattern) {
    try { pattern = new RegExp(opts.urlPattern); } catch (e) {
      return { ok: false, error: { code: 'invalid_request', message: `Invalid urlPattern: ${(e as Error).message}` } };
    }
  }
  const expr = `(() => {
    if (!window.__lmAssistNetworkTap) return null;
    const buf = window.__lmAssistNetworkTap.buffer || [];
    const filtered = buf.filter(r => r.ts >= ${since});
    if (${opts.clear ? 'true' : 'false'}) window.__lmAssistNetworkTap.buffer = [];
    return { reqs: filtered.slice(-${limit}), total: buf.length };
  })()`;
  try {
    const res = await sendCDP<{ result: { value?: { reqs: Array<{ url: string }>; total: number } | null } }>(wsUrl, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    const v = res.result?.value;
    if (!v) return { ok: false, error: { code: 'invalid_request', message: 'Network tap not installed. POST /browser/tabs/:id/network first.' } };
    const reqs = pattern ? v.reqs.filter((r) => pattern!.test(r.url)) : v.reqs;
    return { ok: true, requests: reqs, total: v.total };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 4: Screenshot
// ─────────────────────────────────────────────────────────────────────────────

export async function screenshot(
  port: number,
  tabId: string,
  opts: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean } = {},
): Promise<{ ok: true; format: 'png' | 'jpeg'; dataBase64: string; bytes: number } | { ok: false; error: ControlError }> {
  const wsUrl = await findTargetWS(port, tabId);
  if (!wsUrl) return { ok: false, error: { code: 'tab_not_found', message: `No CDP target with id=${tabId}` } };
  const format = opts.format ?? 'png';
  try {
    const params: Record<string, unknown> = { format };
    if (format === 'jpeg' && typeof opts.quality === 'number') params.quality = opts.quality;
    if (opts.fullPage) params.captureBeyondViewport = true;
    const res = await sendCDP<{ data: string }>(wsUrl, 'Page.captureScreenshot', params, 15000);
    const data = res.data || '';
    return {
      ok: true,
      format,
      dataBase64: data,
      bytes: Math.floor((data.length * 3) / 4),
    };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_error', message: (e as Error).message } };
  }
}
