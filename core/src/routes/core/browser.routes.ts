/**
 * Generic browser control routes.
 *
 * Targets any Chrome started with `--remote-debugging-port`. lm-assist's
 * full browser surface lives here — discovery (installed/profiles),
 * lifecycle (launch/close/switch-to-headless), tab primitives (CRUD,
 * navigate, eval, cookies, click, type, etc.), and the in-page banner
 * system. Claude.ai-specific composites (`/claude-ai/browser/capture-session`,
 * `/claude-ai/browser/launch-and-capture`, `/claude-ai/browser/install-idle-banner`,
 * `/claude-ai/browser/via-chrome/identify`) build on top of these
 * primitives and live in `claude-ai.routes.ts`.
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
import {
  launchChrome,
  closeChrome,
  findInstalledBrowsers,
  type BrowserKind,
} from '../../utils/claudeai-browser-launch';
import { listChromeProfiles } from '../../utils/claudeai-browser-profile';
import {
  installBanner,
  removeBanner,
  listBanners,
  closeAllBanners,
  type BannerConfig,
} from '../../utils/claudeai-banner';

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

    // ─── Browser discovery + lifecycle ──────────────────────────────────

    // GET /browser/installed
    //   Enumerate CDP-capable + Firefox browsers on this host.
    {
      method: 'GET',
      pattern: /^\/browser\/installed$/,
      handler: async () => ({ success: true, data: { browsers: findInstalledBrowsers() } }),
    },

    // GET /browser/profiles
    //   List Chrome profiles on this host with their per-profile session
    //   file paths. Read-only; doesn't spawn anything.
    {
      method: 'GET',
      pattern: /^\/browser\/profiles$/,
      handler: async () => {
        const result = listChromeProfiles();
        return { success: true, data: result };
      },
    },

    // POST /browser/launch
    //   Body: { profile?: 'isolated' | <profile-id>, port?, headless?, browser? }
    //   Spawns a browser with --remote-debugging-port. Returns
    //   { pid, port, userDataDir, profileDirectory, browser, browserFamily,
    //     devtoolsUrl }. Refuses if Chrome is already running against the
    //   requested profile dir (per-dir SingletonLock); use 'isolated' or
    //   close other Chrome windows. `browser` defaults to 'any-chromium'.
    {
      method: 'POST',
      pattern: /^\/browser\/launch$/,
      handler: async (req) => {
        const b = (req.body || {}) as { profile?: string; port?: number; headless?: boolean; browser?: BrowserKind | 'any-chromium' };
        const result = await launchChrome({
          profile: typeof b.profile === 'string' ? b.profile : undefined,
          port: typeof b.port === 'number' ? b.port : undefined,
          headless: typeof b.headless === 'boolean' ? b.headless : undefined,
          browser: typeof b.browser === 'string' ? b.browser : undefined,
        });
        if (!result.ok) {
          return { success: false, error: { code: result.code.toUpperCase(), message: result.message, hint: result.hint } };
        }
        return { success: true, data: result };
      },
    },

    // POST /browser/close
    //   Body: { pid: number }
    //   Tree-kills the spawned browser. Only kill the pid you launched —
    //   passing the wrong pid can take down the user's real Chrome windows.
    {
      method: 'POST',
      pattern: /^\/browser\/close$/,
      handler: async (req) => {
        const b = (req.body || {}) as { pid?: number };
        if (typeof b.pid !== 'number' || b.pid <= 0) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: 'Body must include numeric { pid }.' } };
        }
        const result = await closeChrome(b.pid);
        return result.ok
          ? { success: true, data: result }
          : { success: false, error: { code: 'CLOSE_FAILED', message: result.message } };
      },
    },

    // POST /browser/switch-to-headless
    //   Body: { pid: number, profile?: string, port?: number, browser?, oldPort? }
    //   Closes the currently-running visible Chrome (pass its pid) and
    //   re-launches it against the SAME profile directory in headless
    //   mode. Cookies + login state survive because Chrome's profile
    //   storage lives on disk in the profile dir, not in the process.
    //   The new launch forces `--user-agent=` to a normal Chrome UA
    //   because Cloudflare gates the default `HeadlessChrome/...` UA with
    //   a challenge that 403s most API calls regardless of cookies.
    //   `oldPort` (optional): the debug port of the closed Chrome — used
    //   to tear down any banners that were installed there.
    {
      method: 'POST',
      pattern: /^\/browser\/switch-to-headless$/,
      handler: async (req) => {
        const b = (req.body || {}) as {
          pid?: number; profile?: string; port?: number;
          browser?: BrowserKind | 'any-chromium'; oldPort?: number;
        };
        if (typeof b.pid !== 'number' || b.pid <= 0) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: 'Body must include numeric { pid } of the visible Chrome to close.' } };
        }
        try {
          if (typeof b.oldPort === 'number') {
            await closeAllBanners(b.oldPort);
          }
          const closeResult = await closeChrome(b.pid);
          await new Promise((r) => setTimeout(r, 1000));
          const headlessChromeUA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
          const launch = await launchChrome({
            profile: typeof b.profile === 'string' ? b.profile : 'isolated',
            port: typeof b.port === 'number' ? b.port : 9333,
            headless: true,
            browser: typeof b.browser === 'string' ? b.browser : undefined,
            extraArgs: [`--user-agent=${headlessChromeUA}`],
          });
          if (!launch.ok) {
            return {
              success: false,
              error: { code: launch.code.toUpperCase(), message: 'Re-launch in headless failed: ' + launch.message, hint: launch.hint },
              data: { closeResult },
            };
          }
          return { success: true, data: { ok: true, closeResult, launch } };
        } catch (e) {
          return { success: false, error: { code: 'INTERNAL_ERROR', message: (e as Error).message } };
        }
      },
    },

    // ─── Banner endpoints ───────────────────────────────────────────────

    // POST /browser/banners
    //   Body: BannerConfig + { port: number }
    //     id, title, status, statusKind?, note?, theme?, closable?,
    //     match: { include: [<hostPattern>, …] },
    //     onMismatch: { action: 'redirect'|'hide'|'warn', redirectTo?, redirectAfterMs? }
    //   Adds (or replaces, by `id`) a banner on every page target of the
    //   debug-port browser. Banner persists across navigations (registered
    //   as a `Page.addScriptToEvaluateOnNewDocument` doc-init script with
    //   the CDP session kept alive). New tabs picked up via a 3s poller.
    //   Host pattern shapes: "claude.ai" exact, "*.claude.ai" host or
    //   subdomain, "*" any host. `onMismatch.action`: 'redirect' (warning
    //   banner then location.replace), 'hide' (default), or 'warn' (err
    //   styling, no redirect).
    {
      method: 'POST',
      pattern: /^\/browser\/banners$/,
      handler: async (req) => {
        const b = (req.body || {}) as Partial<BannerConfig> & { port?: number };
        const port = typeof b.port === 'number' && b.port > 0 ? b.port : 9222;
        if (typeof b.id !== 'string' || !b.id) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: 'Body must include a string `id`.' } };
        }
        if (typeof b.title !== 'string' || typeof b.status !== 'string') {
          return { success: false, error: { code: 'INVALID_REQUEST', message: 'Body must include string `title` and `status`.' } };
        }
        try {
          const result = await installBanner(port, b as BannerConfig);
          return { success: true, data: result };
        } catch (e) {
          return { success: false, error: { code: 'INTERNAL_ERROR', message: (e as Error).message } };
        }
      },
    },

    // GET /browser/banners?port=N
    //   List banner configs currently registered for this port (state
    //   only — does not query the page DOM).
    {
      method: 'GET',
      pattern: /^\/browser\/banners$/,
      handler: async (req) => {
        const q = (req.query || {}) as { port?: string };
        const port = q.port ? parseInt(q.port, 10) : 9222;
        const result = listBanners(port);
        return { success: true, data: result };
      },
    },

    // DELETE /browser/banners/:id?port=N
    //   Drop a single banner (by id). Removes the doc-init script
    //   registration on every CDP session + the banner's DOM node from
    //   each loaded doc.
    {
      method: 'DELETE',
      pattern: /^\/browser\/banners\/(?<id>[^/?]+)$/,
      handler: async (req) => {
        const id = req.params.id;
        const q = (req.query || {}) as { port?: string };
        const port = q.port ? parseInt(q.port, 10) : 9222;
        try {
          const result = await removeBanner(port, id);
          return { success: true, data: result };
        } catch (e) {
          return { success: false, error: { code: 'INTERNAL_ERROR', message: (e as Error).message } };
        }
      },
    },
  ];
}
