/**
 * Generic browser control routes.
 *
 * Targets any Chrome that was started with `--remote-debugging-port`.
 * Useful both as a fallback when claude-in-chrome MCP isn't loaded, and
 * as a programmatic surface for automation / debugging tools that need
 * the same primitives MCP provides.
 *
 * The /claude-ai/browser/* family composes these primitives for the
 * specific cookie-capture flow; this family stays domain-agnostic.
 */

import type { RouteHandler, RouteContext } from '../index';
import {
  listTabs,
  createTab,
  closeTab,
  navigateTab,
  evalInTab,
  getCookies,
  getPageText,
  getPageHTML,
  screenshot,
  clickElement,
  typeIntoElement,
  waitFor,
  getStorage,
  setStorage,
  deleteStorage,
  setCookies,
  deleteCookies,
  setViewport,
  pressKey,
  findByText,
  installConsoleTap,
  readConsoleMessages,
  installNetworkTap,
  readNetworkRequests,
} from '../../utils/browser-control';

/** Pick port from query (?port=) or body (.port), default 9222. */
function pickPort(q: Record<string, unknown>, body: Record<string, unknown>): number {
  const fromQ = typeof q.port === 'string' ? parseInt(q.port, 10) : NaN;
  const fromB = typeof body.port === 'number' ? body.port : NaN;
  return Number.isFinite(fromB) ? fromB as number : Number.isFinite(fromQ) ? fromQ : 9222;
}

/** Map our util result (ok-tagged union) to the route response envelope. */
function wrap(r: { ok: true } | { ok: false; error: { code: string; message: string; hint?: string } }):
  { success: true; data: unknown } | { success: false; error: { code: string; message: string; hint?: string } } {
  if (r.ok) {
    return { success: true, data: r };
  }
  const err = r.error;
  return { success: false, error: { code: err.code.toUpperCase(), message: err.message, hint: err.hint } };
}

export function createBrowserRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // ─── Tier 1: Tab CRUD ────────────────────────────────────────────────

    {
      method: 'GET',
      pattern: /^\/browser\/tabs$/,
      handler: async (req) => wrap(await listTabs(pickPort(req.query || {}, {}))),
    },

    {
      method: 'POST',
      pattern: /^\/browser\/tabs$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number; url?: string };
        return wrap(await createTab(pickPort({}, b), typeof b.url === 'string' ? b.url : undefined));
      },
    },

    {
      method: 'DELETE',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number };
        return wrap(await closeTab(pickPort(req.query || {}, b), req.params.id));
      },
    },

    // ─── Tier 2: Navigation, scripting, cookies (read) ───────────────────

    {
      method: 'POST',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/navigate$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number; url?: string; direction?: 'back' | 'forward' | 'reload' };
        return wrap(await navigateTab(pickPort({}, b), req.params.id, { url: b.url, direction: b.direction }));
      },
    },

    {
      method: 'POST',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/eval$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number; expression?: string; returnByValue?: boolean; awaitPromise?: boolean; timeoutMs?: number };
        if (typeof b.expression !== 'string' || !b.expression) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: 'Body must include { expression: string }.' } };
        }
        return wrap(await evalInTab(pickPort({}, b), req.params.id, {
          expression: b.expression,
          returnByValue: b.returnByValue,
          awaitPromise: b.awaitPromise,
          timeoutMs: b.timeoutMs,
        }));
      },
    },

    {
      method: 'GET',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/cookies$/,
      handler: async (req) => {
        const q = req.query || {};
        return wrap(await getCookies(pickPort(q, {}), req.params.id, {
          domain: typeof q.domain === 'string' ? q.domain : undefined,
        }));
      },
    },

    // ─── Tier 3: Page inspection ──────────────────────────────────────────

    {
      method: 'GET',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/text$/,
      handler: async (req) => {
        const q = req.query || {};
        const maxBytes = typeof q.maxBytes === 'string' ? parseInt(q.maxBytes, 10) : undefined;
        return wrap(await getPageText(pickPort(q, {}), req.params.id, { maxBytes }));
      },
    },

    {
      method: 'GET',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/html$/,
      handler: async (req) => {
        const q = req.query || {};
        const maxBytes = typeof q.maxBytes === 'string' ? parseInt(q.maxBytes, 10) : undefined;
        return wrap(await getPageHTML(pickPort(q, {}), req.params.id, { maxBytes }));
      },
    },

    // ─── Tier 3b: DOM interaction ────────────────────────────────────────

    {
      method: 'POST',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/click$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number; selector?: string; allMatches?: boolean };
        if (typeof b.selector !== 'string' || !b.selector) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: 'Body must include { selector: string }.' } };
        }
        return wrap(await clickElement(pickPort({}, b), req.params.id, { selector: b.selector, allMatches: b.allMatches }));
      },
    },

    {
      method: 'POST',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/type$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number; selector?: string; text?: string; clear?: boolean };
        if (typeof b.selector !== 'string' || typeof b.text !== 'string') {
          return { success: false, error: { code: 'INVALID_REQUEST', message: 'Body must include { selector: string, text: string }.' } };
        }
        return wrap(await typeIntoElement(pickPort({}, b), req.params.id, { selector: b.selector, text: b.text, clear: b.clear }));
      },
    },

    {
      method: 'POST',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/wait-for$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number; selector?: string; urlPattern?: string; timeoutMs?: number; intervalMs?: number };
        return wrap(await waitFor(pickPort({}, b), req.params.id, {
          selector: b.selector, urlPattern: b.urlPattern, timeoutMs: b.timeoutMs, intervalMs: b.intervalMs,
        }));
      },
    },

    // ─── Tier 3c: Storage + cookie writes ────────────────────────────────

    {
      method: 'GET',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/storage$/,
      handler: async (req) => {
        const q = req.query || {};
        const type = q.type === 'session' ? 'session' : 'local';
        return wrap(await getStorage(pickPort(q, {}), req.params.id, { type }));
      },
    },

    {
      method: 'POST',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/storage$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number; type?: 'local' | 'session'; key?: string; value?: string };
        if (typeof b.key !== 'string' || typeof b.value !== 'string') {
          return { success: false, error: { code: 'INVALID_REQUEST', message: 'Body must include { type, key, value }.' } };
        }
        return wrap(await setStorage(pickPort({}, b), req.params.id, { type: b.type ?? 'local', key: b.key, value: b.value }));
      },
    },

    {
      method: 'DELETE',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/storage$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number; type?: 'local' | 'session'; key?: string };
        return wrap(await deleteStorage(pickPort({}, b), req.params.id, { type: b.type ?? 'local', key: b.key }));
      },
    },

    {
      method: 'POST',
      pattern: /^\/browser\/cookies$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number; cookies?: unknown[] };
        if (!Array.isArray(b.cookies) || !b.cookies.length) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: 'Body must include { cookies: [...] }.' } };
        }
        return wrap(await setCookies(pickPort({}, b), { cookies: b.cookies as Parameters<typeof setCookies>[1]['cookies'] }));
      },
    },

    {
      method: 'DELETE',
      pattern: /^\/browser\/cookies$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number; name?: string; domain?: string; url?: string; clearAll?: boolean };
        return wrap(await deleteCookies(pickPort({}, b), { name: b.name, domain: b.domain, url: b.url, clearAll: b.clearAll }));
      },
    },

    // ─── Tier 3d: Viewport, keys, find-by-text ───────────────────────────

    {
      method: 'POST',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/viewport$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number; width?: number; height?: number; deviceScaleFactor?: number; mobile?: boolean };
        if (typeof b.width !== 'number' || typeof b.height !== 'number') {
          return { success: false, error: { code: 'INVALID_REQUEST', message: 'Body must include { width, height }.' } };
        }
        return wrap(await setViewport(pickPort({}, b), req.params.id, { width: b.width, height: b.height, deviceScaleFactor: b.deviceScaleFactor, mobile: b.mobile }));
      },
    },

    {
      method: 'POST',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/key$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number; key?: string; modifiers?: Array<'ctrl' | 'alt' | 'shift' | 'meta'> };
        if (typeof b.key !== 'string' || !b.key) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: 'Body must include { key: string }.' } };
        }
        return wrap(await pressKey(pickPort({}, b), req.params.id, { key: b.key, modifiers: b.modifiers }));
      },
    },

    {
      method: 'GET',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/find$/,
      handler: async (req) => {
        const q = req.query || {};
        const text = typeof q.text === 'string' ? q.text : '';
        if (!text) return { success: false, error: { code: 'INVALID_REQUEST', message: 'Query must include text=' } };
        const tag = typeof q.tag === 'string' ? q.tag : undefined;
        const limit = typeof q.limit === 'string' ? parseInt(q.limit, 10) : undefined;
        return wrap(await findByText(pickPort(q, {}), req.params.id, { text, tag, limit }));
      },
    },

    // ─── Tier 3e: Console + network taps ──────────────────────────────────

    {
      method: 'POST',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/console$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number };
        return wrap(await installConsoleTap(pickPort({}, b), req.params.id));
      },
    },

    {
      method: 'GET',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/console$/,
      handler: async (req) => {
        const q = req.query || {};
        const since = typeof q.since === 'string' ? parseInt(q.since, 10) : undefined;
        const limit = typeof q.limit === 'string' ? parseInt(q.limit, 10) : undefined;
        const clear = q.clear === 'true';
        return wrap(await readConsoleMessages(pickPort(q, {}), req.params.id, { since, limit, clear }));
      },
    },

    {
      method: 'POST',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/network$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number };
        return wrap(await installNetworkTap(pickPort({}, b), req.params.id));
      },
    },

    {
      method: 'GET',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/network$/,
      handler: async (req) => {
        const q = req.query || {};
        const since = typeof q.since === 'string' ? parseInt(q.since, 10) : undefined;
        const limit = typeof q.limit === 'string' ? parseInt(q.limit, 10) : undefined;
        const urlPattern = typeof q.urlPattern === 'string' ? q.urlPattern : undefined;
        const clear = q.clear === 'true';
        return wrap(await readNetworkRequests(pickPort(q, {}), req.params.id, { since, limit, urlPattern, clear }));
      },
    },

    // ─── Tier 4: Screenshot ──────────────────────────────────────────────

    {
      method: 'POST',
      pattern: /^\/browser\/tabs\/(?<id>[^/?]+)\/screenshot$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number; format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean };
        return wrap(await screenshot(pickPort({}, b), req.params.id, { format: b.format, quality: b.quality, fullPage: b.fullPage }));
      },
    },
  ];
}
