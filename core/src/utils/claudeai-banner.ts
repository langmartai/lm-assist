/**
 * Generic on-page banner system for lm-assist-managed browsers.
 *
 * One CDP session per page target is kept alive per debug port — that's
 * what makes `Page.addScriptToEvaluateOnNewDocument` registrations survive
 * subsequent navigations (CDP clears registrations when the session
 * disconnects). A 3s poller per port also attaches to new tabs the user
 * opens after the banner is installed.
 *
 * Each banner is independent: its own DOM id (`__lm-assist-banner-<id>`),
 * its own doc-init script, its own URL match pattern + onMismatch action.
 * Multiple banners can coexist on a page (they stack via document order,
 * each with `position: fixed; top: 0;`). Pass distinct ids.
 *
 * Lifecycle:
 *   - installBanner(port, config) — add or replace a banner
 *   - removeBanner(port, id)      — drop a single banner
 *   - listBanners(port)           — read current config + match state
 *   - closeAllBanners(port)       — cleanup (used by switch-to-headless)
 */

import { CDPSession, httpGetJSON } from './browser-control';

export type BannerStatusKind = 'ok' | 'err' | 'default';
export type BannerTheme = 'dark' | 'warning' | 'info';
export type BannerMismatchAction = 'redirect' | 'hide' | 'warn';

export interface BannerMatch {
  /**
   * Host patterns that should SHOW the banner. Empty / undefined means
   * "show on every page" (no host gate). Pattern shapes:
   *   - "claude.ai"          → exact host
   *   - "*.claude.ai"        → host or any subdomain
   *   - "*"                  → wildcard (any host)
   * Path matching is not supported in this version — caller can do path
   * checks themselves inside `onMismatch.action: 'warn'` if needed.
   */
  include?: string[];
}

export interface BannerOnMismatch {
  /**
   * What to do when the page's URL doesn't match `match.include`:
   *   - 'redirect': render a brief warning banner explaining the mismatch,
   *                 then `location.replace(redirectTo)` after `redirectAfterMs`.
   *   - 'hide':     render nothing (no banner appears on mismatched hosts).
   *   - 'warn':     render the banner with `err` styling but don't redirect.
   * Default: 'hide'.
   */
  action?: BannerMismatchAction;
  /** Used when action='redirect'. Default 'https://claude.ai/'. */
  redirectTo?: string;
  /** Used when action='redirect'. Default 1800. */
  redirectAfterMs?: number;
}

export interface BannerConfig {
  /** Caller-supplied stable id. Used as the DOM id (`__lm-assist-banner-<id>`) and the handle for update/remove. */
  id: string;
  /** Bold title text shown first. */
  title: string;
  /** Status line under the title. */
  status: string;
  /** Tint for the status line — 'ok' = green, 'err' = red, default = neutral. */
  statusKind?: BannerStatusKind;
  /** Smaller explanation paragraph under the status. */
  note?: string;
  /** Color theme — 'dark' (default, claude-orange accent), 'warning' (red accent), 'info' (blue). */
  theme?: BannerTheme;
  /** Whether the user can click × to dismiss. Default true. */
  closable?: boolean;
  /** Host match rules. Omit to show on every host. */
  match?: BannerMatch;
  /** Behavior when URL doesn't match. Default { action: 'hide' }. */
  onMismatch?: BannerOnMismatch;
}

interface BannerSlot {
  config: BannerConfig;
  /** scriptId per targetId — needed to call `Page.removeScriptToEvaluateOnNewDocument` cleanly. */
  scriptIds: Map<string, string>;
}

interface PortBannerState {
  /** banner id → slot */
  banners: Map<string, BannerSlot>;
  /** targetId → live CDP session (kept alive for doc-init registrations). */
  sessions: Map<string, CDPSession>;
  /** poller that picks up new tabs the user opens after install. */
  poller: NodeJS.Timeout;
}

const portState: Map<number, PortBannerState> = new Map();

interface CDPTarget {
  id: string;
  type: string;
  url?: string;
  webSocketDebuggerUrl: string;
}

/**
 * Build the per-banner doc-init script. Embeds the config via
 * `JSON.stringify` so caller-controlled text/URLs are safely escaped.
 */
function buildBannerScript(config: BannerConfig): string {
  const cfgJSON = JSON.stringify(config);
  return `(function() {
  var CFG = ${cfgJSON};
  var DOM_ID = '__lm-assist-banner-' + CFG.id;

  function hostMatches(host, pattern) {
    if (!pattern || pattern === '*') return true;
    if (pattern.charAt(0) === '*' && pattern.charAt(1) === '.') {
      var d = pattern.slice(2).toLowerCase();
      var h = (host || '').toLowerCase();
      return h === d || h.endsWith('.' + d);
    }
    return (host || '').toLowerCase() === pattern.toLowerCase();
  }
  function urlMatches() {
    var inc = (CFG.match && CFG.match.include) || [];
    if (!inc.length) return true;
    return inc.some(function(p) { return hostMatches(location.hostname, p); });
  }

  var THEMES = {
    'dark':    { bg: '#1a1d29', fg: '#f8f9fb', accent: '#d97757', small: '#b8bcc7' },
    'warning': { bg: '#3a1010', fg: '#fff5f5', accent: '#f87171', small: '#fca5a5' },
    'info':    { bg: '#0c2840', fg: '#e0f2fe', accent: '#60a5fa', small: '#bfdbfe' }
  };

  function build(themeKey, statusText, statusKind) {
    var prev = document.getElementById(DOM_ID);
    if (prev) prev.remove();
    var T = THEMES[themeKey] || THEMES['dark'];
    var el = document.createElement('div');
    el.id = DOM_ID;
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;'
      + 'background:' + T.bg + ';color:' + T.fg + ';padding:10px 44px 10px 18px;'
      + 'font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;font-size:13px;'
      + 'line-height:1.5;border-bottom:2px solid ' + T.accent + ';'
      + 'box-shadow:0 4px 14px rgba(0,0,0,.35);';

    if (CFG.closable !== false) {
      var btn = document.createElement('button');
      btn.style.cssText = 'position:absolute;top:6px;right:12px;background:none;border:none;'
        + 'color:' + T.fg + ';cursor:pointer;font-size:18px;opacity:.7;';
      btn.textContent = '\\u00d7';
      btn.title = 'Dismiss banner';
      btn.addEventListener('click', function() {
        var n = document.getElementById(DOM_ID);
        if (n) n.remove();
        if (window.__lmAssistBanners) delete window.__lmAssistBanners[CFG.id];
      });
      el.appendChild(btn);
    }

    var title = document.createElement('strong');
    title.style.cssText = 'color:' + T.accent + ';font-size:14px;';
    title.textContent = CFG.title || '';
    el.appendChild(title);

    var statusP = document.createElement('p');
    statusP.className = 'lm-banner-status';
    var statusColor = statusKind === 'ok' ? '#4ade80'
                    : statusKind === 'err' ? '#f87171'
                    : T.fg;
    statusP.style.cssText = 'margin:2px 0;color:' + statusColor + ';';
    statusP.textContent = statusText || '';
    el.appendChild(statusP);

    if (CFG.note) {
      var noteP = document.createElement('p');
      noteP.style.cssText = 'margin:2px 0;color:' + T.small + ';font-size:11.5px;';
      noteP.textContent = CFG.note;
      el.appendChild(noteP);
    }

    (document.body || document.documentElement).appendChild(el);
  }

  function install() {
    if (urlMatches()) {
      build(CFG.theme || 'dark', CFG.status || '', CFG.statusKind || 'default');
      return;
    }
    var act = (CFG.onMismatch && CFG.onMismatch.action) || 'hide';
    if (act === 'redirect') {
      var target = (CFG.onMismatch && CFG.onMismatch.redirectTo) || 'https://claude.ai/';
      var delay = (CFG.onMismatch && CFG.onMismatch.redirectAfterMs) || 1800;
      build('warning', 'You navigated to ' + location.hostname + ' — this browser is reserved. Returning…', 'err');
      setTimeout(function() { try { location.replace(target); } catch (_e) {} }, delay);
    } else if (act === 'warn') {
      build('warning', 'Off-target host: ' + location.hostname, 'err');
    }
    // 'hide' → render nothing
  }

  function setStatus(text, kind) {
    var p = document.querySelector('#' + DOM_ID + ' .lm-banner-status');
    if (!p) return;
    p.textContent = text;
    var T = THEMES[CFG.theme || 'dark'];
    p.style.color = kind === 'ok' ? '#4ade80'
                  : kind === 'err' ? '#f87171'
                  : T.fg;
  }

  window.__lmAssistBanners = window.__lmAssistBanners || {};
  window.__lmAssistBanners[CFG.id] = {
    config: CFG,
    setStatus: setStatus,
    remove: function() {
      var n = document.getElementById(DOM_ID);
      if (n) n.remove();
      delete window.__lmAssistBanners[CFG.id];
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }

  // Re-install if claude.ai's SPA wipes our node during a route change.
  var mo = new MutationObserver(function() {
    if (urlMatches() && !document.getElementById(DOM_ID)) install();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();`;
}

async function attachSessionToTarget(target: CDPTarget): Promise<CDPSession | null> {
  try {
    const sess = new CDPSession(target.webSocketDebuggerUrl);
    await sess.ready();
    await sess.send('Page.enable');
    return sess;
  } catch {
    return null;
  }
}

async function ensurePortState(port: number): Promise<PortBannerState> {
  let st = portState.get(port);
  if (st) return st;

  const sessions = new Map<string, CDPSession>();
  const targets = await httpGetJSON<CDPTarget[]>(`http://127.0.0.1:${port}/json/list`);
  const pages = (Array.isArray(targets) ? targets : []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  for (const t of pages) {
    const sess = await attachSessionToTarget(t);
    if (sess) sessions.set(t.id, sess);
  }

  // Poll for newly-opened tabs every 3s. Re-attaches if Chrome opens new
  // page targets after install. Silently ignores fetch errors so a brief
  // Chrome restart doesn't leave the poller in a bad state.
  const poller = setInterval(async () => {
    try {
      const ts = await httpGetJSON<CDPTarget[]>(`http://127.0.0.1:${port}/json/list`);
      const livePages = (Array.isArray(ts) ? ts : []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      const st2 = portState.get(port);
      if (!st2) return;
      const liveIds = new Set(livePages.map((t) => t.id));
      // Attach to new targets + register all known banners on them.
      for (const t of livePages) {
        if (st2.sessions.has(t.id)) continue;
        const s = await attachSessionToTarget(t);
        if (!s) continue;
        st2.sessions.set(t.id, s);
        for (const [bid, slot] of st2.banners) {
          try {
            const reg = await s.send<{ identifier: string }>(
              'Page.addScriptToEvaluateOnNewDocument',
              { source: buildBannerScript(slot.config) },
            );
            await s.send('Runtime.evaluate', { expression: buildBannerScript(slot.config), awaitPromise: false });
            slot.scriptIds.set(t.id, reg?.identifier || '');
          } catch { /* skip — target may have closed mid-attach */ }
        }
      }
      // Drop sessions whose targets are gone.
      for (const [tid, sess] of st2.sessions) {
        if (liveIds.has(tid)) continue;
        try { sess.close(); } catch { /* ignore */ }
        st2.sessions.delete(tid);
        for (const slot of st2.banners.values()) slot.scriptIds.delete(tid);
      }
    } catch { /* network blip — try next interval */ }
  }, 3000);

  st = { banners: new Map(), sessions, poller };
  portState.set(port, st);
  return st;
}

/**
 * Add or replace a banner on every page target of the debug-port browser.
 * If a banner with the same `id` already exists for this port, its prior
 * `Page.addScriptToEvaluateOnNewDocument` registration is removed first
 * so the new one is the only one active.
 */
export async function installBanner(port: number, config: BannerConfig): Promise<{
  ok: boolean;
  port: number;
  bannerId: string;
  installs: Array<{ targetId: string; url?: string; ok: boolean; error?: string }>;
  targetsTotal: number;
}> {
  if (!config || typeof config.id !== 'string' || !config.id) {
    throw new Error('installBanner: config.id (non-empty string) is required');
  }
  if (typeof config.title !== 'string') {
    throw new Error('installBanner: config.title (string) is required');
  }
  if (typeof config.status !== 'string') {
    throw new Error('installBanner: config.status (string) is required');
  }
  const st = await ensurePortState(port);

  // If this banner already exists, drop its prior CDP registrations first.
  const prior = st.banners.get(config.id);
  if (prior) {
    for (const [tid, sess] of st.sessions) {
      const sid = prior.scriptIds.get(tid);
      if (!sid) continue;
      try { await sess.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: sid }); } catch { /* ignore */ }
    }
  }

  const slot: BannerSlot = { config, scriptIds: new Map() };
  const source = buildBannerScript(config);
  const installs: Array<{ targetId: string; url?: string; ok: boolean; error?: string }> = [];

  // Fetch target metadata once for the per-install URL field.
  let targetMeta = new Map<string, CDPTarget>();
  try {
    const ts = await httpGetJSON<CDPTarget[]>(`http://127.0.0.1:${port}/json/list`);
    targetMeta = new Map((Array.isArray(ts) ? ts : []).map((t) => [t.id, t]));
  } catch { /* fall back to no URL in installs */ }

  for (const [tid, sess] of st.sessions) {
    try {
      const reg = await sess.send<{ identifier: string }>('Page.addScriptToEvaluateOnNewDocument', { source });
      await sess.send('Runtime.evaluate', { expression: source, awaitPromise: false });
      slot.scriptIds.set(tid, reg?.identifier || '');
      installs.push({ targetId: tid, url: targetMeta.get(tid)?.url, ok: true });
    } catch (e) {
      installs.push({ targetId: tid, url: targetMeta.get(tid)?.url, ok: false, error: (e as Error).message });
    }
  }
  st.banners.set(config.id, slot);
  return { ok: true, port, bannerId: config.id, installs, targetsTotal: st.sessions.size };
}

/**
 * Remove a single banner by id. Drops the `Page.addScript…` registration
 * on every target + removes the DOM node from the currently-loaded doc.
 */
export async function removeBanner(port: number, id: string): Promise<{ ok: boolean; removedTargets: number }> {
  const st = portState.get(port);
  if (!st) return { ok: true, removedTargets: 0 };
  const slot = st.banners.get(id);
  if (!slot) return { ok: true, removedTargets: 0 };

  let removed = 0;
  for (const [tid, sess] of st.sessions) {
    const sid = slot.scriptIds.get(tid);
    if (sid) {
      try { await sess.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: sid }); } catch { /* ignore */ }
    }
    try {
      await sess.send('Runtime.evaluate', {
        expression: `(function(){var n=document.getElementById('__lm-assist-banner-' + ${JSON.stringify(id)}); if(n) n.remove(); if(window.__lmAssistBanners) delete window.__lmAssistBanners[${JSON.stringify(id)}];})()`,
        awaitPromise: false,
      });
      removed++;
    } catch { /* ignore */ }
  }
  st.banners.delete(id);
  return { ok: true, removedTargets: removed };
}

/**
 * Synchronous list of banner configs registered on this port.
 * (State only — does not query the page DOMs.)
 */
export function listBanners(port: number): { ok: boolean; port: number; banners: BannerConfig[] } {
  const st = portState.get(port);
  return { ok: true, port, banners: st ? Array.from(st.banners.values()).map((s) => s.config) : [] };
}

/**
 * Tear down ALL banners + the CDP sessions + the poller for this port.
 * Use this when the Chrome process is being killed (e.g. switch-to-headless)
 * — leftover state would otherwise reference dead sockets.
 */
export async function closeAllBanners(port: number): Promise<void> {
  const st = portState.get(port);
  if (!st) return;
  try { clearInterval(st.poller); } catch { /* ignore */ }
  for (const sess of st.sessions.values()) {
    try { sess.close(); } catch { /* ignore */ }
  }
  portState.delete(port);
}
