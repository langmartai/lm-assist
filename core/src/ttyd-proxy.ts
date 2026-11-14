/**
 * ttyd Proxy - Proxies ttyd connections through the main server
 *
 * This solves cross-origin issues by serving ttyd through the same origin,
 * allowing the frontend to control xterm.js (e.g., scroll to bottom).
 *
 * Authentication: ttyd itself has no credential and every terminal is writable, so
 * this proxy is the gate (rest-server dispatches it BEFORE the api-token gate because
 * it authenticates itself — an iframe cannot send a header). A request passes with
 * EITHER a valid `x-api-key` header (the hub relay, ConsoleRelayHandler, scripts) OR a
 * valid path capability `/ttyd-proxy/<port>/c/<cap>/…` (terminal iframes; see
 * auth/ttyd-cap.ts). It then reaches ONLY ports held by an active Core-managed ttyd
 * instance (TtydInstanceStore): the proxy used to dial ANY local port, which made it an
 * open relay to every loopback service on the host. Unauthenticated requests always get
 * 401 — before the managed check — so they learn nothing about which ports exist.
 */

import * as http from 'http';
import httpProxy from 'http-proxy';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Socket } from 'net';
import type { Duplex } from 'stream';
import { apiAuthEnabled, isValidToken, resolveProvidedApiKey } from './auth/api-token';
import { verifyTtydCap } from './auth/ttyd-cap';

// Create proxy server
const proxy = httpProxy.createProxyServer({
  ws: true,
  changeOrigin: true,
});

// Handle proxy errors
proxy.on('error', (err: Error, req: IncomingMessage, res: ServerResponse | Socket) => {
  console.error('[ttyd-proxy] Proxy error:', err.message);
  if ('writeHead' in res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('ttyd proxy error: ' + err.message);
  }
});

/**
 * Parse a proxy path.
 * Path formats:
 *   /ttyd-proxy/:port/c/:cap/...  — local iframe path carrying a capability
 *   /ttyd-proxy/:port/...         — local proxy path (header-authenticated callers)
 *   /ttyd/:port/...               — Hub relay path (used when accessed via langmart.ai)
 *
 * The Hub relay strips its prefix and forwards as /ttyd/:port/... which needs
 * the same proxy treatment as /ttyd-proxy/:port/... (e.g., /ttyd/7684/token
 * must reach the actual ttyd /token endpoint for WebSocket reconnection).
 * `rest` keeps any query string exactly as received.
 */
export function parseTtydProxyUrl(url: string): { port: number; cap: string | null; rest: string } | null {
  const match = url.match(/^\/ttyd(?:-proxy)?\/(\d+)(?:\/c\/([A-Za-z0-9_-]{43}))?(\/.*)?$/);
  if (!match) return null;

  const port = parseInt(match[1], 10);
  if (isNaN(port) || port < 1 || port > 65535) return null;

  return { port, cap: match[2] || null, rest: match[3] || '/' };
}

export type TtydAuthDecision = 'ok' | 'unauthorized' | 'not-managed';

export interface TtydProxyDeps {
  /** The active Core-managed ttyd instance on this port, if any. */
  activeInstanceForPort(port: number): { id: string } | undefined;
}

// Lazy: importing the proxy must never construct the instance store (ttyd-manager
// computes INSTANCE_STORE_PATH from the data dir at import time).
const defaultDeps: TtydProxyDeps = {
  activeInstanceForPort: (p) =>
    (require('./ttyd-manager') as typeof import('./ttyd-manager')).getTtydManager().activeInstanceForPort(p),
};

/** Authenticate FIRST (no port oracle), then require a Core-managed instance. */
export function authorizeTtydRequest(
  input: { port: number; cap: string | null; apiKey: string | null; serverApiKey?: string },
  deps: TtydProxyDeps = defaultDeps,
): TtydAuthDecision {
  const inst = deps.activeInstanceForPort(input.port);
  if (apiAuthEnabled()) {
    const headerOk = isValidToken(input.apiKey) || (!!input.serverApiKey && input.apiKey === input.serverApiKey);
    const capOk = !!(input.cap && inst && verifyTtydCap(input.cap, input.port, inst.id));
    if (!headerOk && !capOk) return 'unauthorized';
  }
  if (!inst) return 'not-managed';
  return 'ok';
}

export interface TtydProxyOptions {
  /** The server's static --api-key, accepted like the ring token (as the main gate does). */
  serverApiKey?: string;
  deps?: TtydProxyDeps;
}

function decide(req: IncomingMessage, parsed: { port: number; cap: string | null }, opts?: TtydProxyOptions): TtydAuthDecision {
  return authorizeTtydRequest(
    {
      port: parsed.port,
      cap: parsed.cap,
      apiKey: resolveProvidedApiKey(req.headers['x-api-key']),
      serverApiKey: opts?.serverApiKey,
    },
    opts?.deps ?? defaultDeps,
  );
}

const UNAUTHORIZED_HTML =
  '<!doctype html><meta charset="utf-8"><title>Terminal not authorized</title>' +
  '<body style="font:14px system-ui,sans-serif;padding:1.5em;color:#bbb;background:#111">' +
  'This terminal link is not authorized (it may have expired after a token rotation). ' +
  'Reload the dashboard to get a fresh terminal link.</body>';

/**
 * CSS and JS injected into ttyd HTML pages.
 * Since ttyd iframes are cross-origin (port 3100 vs 3848),
 * we inject at the proxy level instead of via contentDocument.
 *
 * Problem: Claude Code's TUI renders at a minimum of ~53 rows. When the
 * browser viewport is shorter, xterm.js shows the middle of the buffer and
 * the input prompt at the bottom is off-screen.
 *
 * CSS: Scrollbar theming + overflow:hidden on body to prevent layout blowout.
 * JS:
 *   1. ResizeObserver — refit terminal on viewport change via window.term.fit()
 *   2. scrollToBottom() after every fit so the input prompt stays visible
 *   3. onRender / onLineFeed listeners — auto-scroll to bottom on new output
 *
 * ttyd 1.6.3 API (verified from bundle):
 *   - window.term           = xterm.js Terminal instance
 *   - window.term.fit()     = wrapper for fitAddon.fit() (fitAddon is NOT on term)
 *   - term.scrollToBottom()  = scroll viewport to bottom of buffer
 *   - term.onRender(cb)     = fires after terminal renders (batched)
 *   - term.onLineFeed(cb)   = fires on each new line
 *   - term.onData(cb)       = fires on user INPUT (keystrokes), NOT output
 */
const TTYD_INJECTED_CSS = `
<style id="ttyd-proxy-scrollbar-style">
  .xterm-viewport::-webkit-scrollbar { width: 6px; }
  .xterm-viewport::-webkit-scrollbar-track { background: transparent; }
  .xterm-viewport::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
  .xterm-viewport::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
  .xterm-viewport { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.12) transparent; }
  .xterm { min-width: 0; min-height: 0; overflow: hidden; }
  body, html { overflow: hidden; }
</style>
<script id="ttyd-proxy-resize-script">
(function(){
  // --- Fix: ttyd onSocketOpen crashes when fitAddon.proposeDimensions() returns undefined ---
  // This happens when the terminal container has no dimensions yet (hidden iframe, not laid out).
  // proposeDimensions() returns undefined → accessing .cols throws TypeError.
  // Without the auth message, the terminal stays blank forever.
  // Fix: track last WebSocket + global error handler to catch cols error and send auth defaults.
  // (Cannot use Object.defineProperty on ws.onopen — it shadows the native setter and breaks WS.)
  var _OrigWS = window.WebSocket;
  var _lastWs = null;
  window.WebSocket = function(url, protocols) {
    var ws = protocols !== undefined ? new _OrigWS(url, protocols) : new _OrigWS(url);
    _lastWs = ws;
    return ws;
  };
  window.WebSocket.prototype = _OrigWS.prototype;
  window.WebSocket.CONNECTING = _OrigWS.CONNECTING;
  window.WebSocket.OPEN = _OrigWS.OPEN;
  window.WebSocket.CLOSING = _OrigWS.CLOSING;
  window.WebSocket.CLOSED = _OrigWS.CLOSED;

  window.addEventListener('error', function(e) {
    if (e.error && String(e.error).indexOf('cols') >= 0 && _lastWs && _lastWs.readyState === 1) {
      e.preventDefault();
      console.warn('[ttyd-proxy] proposeDimensions() failed, sending auth with 80x24 defaults');
      var enc = new TextEncoder();
      var ws = _lastWs;
      try { ws.send(enc.encode(JSON.stringify({AuthToken:'',columns:80,rows:24}))); } catch(e2){}
      var rid = setInterval(function() {
        var t = window.term;
        if (t && t.cols && t.rows) {
          clearInterval(rid);
          try { ws.send(enc.encode('1'+JSON.stringify({columns:t.cols,rows:t.rows}))); } catch(e3){}
          try { t.focus(); } catch(e4){}
        }
      }, 200);
    }
  });

  var fitTimer, scrollTimer;

  /** Safely scroll xterm viewport to the very bottom */
  function scrollToBottom(term) {
    try { term.scrollToBottom(); } catch(e){}
  }

  /** Fit terminal to container then scroll to bottom */
  function fitAndScroll() {
    var term = window.term;
    if (!term) return;
    try { term.fit(); } catch(e){}
    scrollToBottom(term);
  }

  // --- ResizeObserver: refit on viewport size changes ---
  var ro = new ResizeObserver(function() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitAndScroll, 150);
  });
  ro.observe(document.documentElement);

  // --- Auto-scroll on new terminal output ---
  function attachOutputListeners() {
    var term = window.term;
    if (!term) return false;

    // onRender fires after xterm renders a batch of output (start, end row)
    if (typeof term.onRender === 'function') {
      term.onRender(function() {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(function() { scrollToBottom(term); }, 30);
      });
    }

    // onLineFeed fires on each new line — belt-and-suspenders with onRender
    if (typeof term.onLineFeed === 'function') {
      term.onLineFeed(function() {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(function() { scrollToBottom(term); }, 30);
      });
    }

    // Initial scroll to bottom once terminal is ready
    scrollToBottom(term);
    return true;
  }

  // Poll until window.term is ready (ttyd creates it async after WS connect)
  var pollCount = 0;
  var pollId = setInterval(function() {
    if (attachOutputListeners() || ++pollCount > 100) {
      clearInterval(pollId);
    }
  }, 100);

  // --- Propagate auth token to all sub-requests ---
  // When served via Hub (langmart.ai), the page URL contains ?token=<uuid>
  // for authentication. But subsequent requests from within the iframe
  // (like GET /token for WebSocket reconnection) don't include the token,
  // causing the hub auth middleware to return 401.
  // Fix: extract the token from the page URL and inject it into all
  // fetch(), XMLHttpRequest, and WebSocket requests.
  var pageParams = new URLSearchParams(window.location.search);
  var hubAuthToken = pageParams.get('token');

  if (hubAuthToken) {
    // Helper: append ?token= to a URL string
    function addTokenToUrl(url) {
      if (!url || typeof url !== 'string') return url;
      // Don't add to absolute URLs on different origins
      if (url.indexOf('://') !== -1 && url.indexOf(window.location.host) === -1) return url;
      var sep = url.indexOf('?') >= 0 ? '&' : '?';
      return url + sep + 'token=' + hubAuthToken;
    }

    // Patch fetch() to include token in requests
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function(input, init) {
        if (typeof input === 'string') {
          input = addTokenToUrl(input);
        } else if (input && typeof input.url === 'string') {
          input = new Request(addTokenToUrl(input.url), input);
        }
        return origFetch.call(window, input, init);
      };
    }

    // Patch XMLHttpRequest.open() to include token
    var origXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      if (typeof url === 'string') {
        arguments[1] = addTokenToUrl(url);
      }
      return origXhrOpen.apply(this, arguments);
    };
  }

  // --- Suppress DA (Device Attributes) responses ---
  // When tmux queries "what terminal are you?" (ESC[>c), xterm.js replies
  // ESC[>0;276;0c back through the WebSocket as input. Nobody needs this
  // answer — it just leaks into Claude's stdin as garbage.
  // Patch WebSocket.prototype.send to drop DA responses from ttyd input messages.
  var daRe = /\\x1b\\[[\\?>]\\d+(?:;\\d+)*c|\\[>\\d+(?:;\\d+)*c/g;
  var origSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
      var buf = data instanceof Uint8Array ? data : new Uint8Array(data);
      // ttyd input messages: first byte 0x00 = keystrokes
      if (buf.length > 1 && buf[0] === 0) {
        var txt = '';
        for (var i = 1; i < buf.length; i++) txt += String.fromCharCode(buf[i]);
        var cleaned = txt.replace(daRe, '');
        if (cleaned.length === 0) return; // entire message was DA junk
        if (cleaned.length !== txt.length) {
          var out = new Uint8Array(1 + cleaned.length);
          out[0] = 0;
          for (var j = 0; j < cleaned.length; j++) out[j+1] = cleaned.charCodeAt(j);
          return origSend.call(this, out.buffer);
        }
      }
    }
    return origSend.call(this, data);
  };
})();
</script>
`;

/**
 * Fetch ttyd root page and inject custom CSS into the HTML.
 */
function fetchAndInjectCss(port: number, res: ServerResponse): void {
  const proxyReq = http.request(
    // 127.0.0.1, not localhost: ttyd binds loopback IPv4 only (ttydLoopbackArgs), and
    // `localhost` may resolve to ::1 first.
    { hostname: '127.0.0.1', port, path: '/', method: 'GET' },
    (proxyRes) => {
      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
      proxyRes.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf-8');

        // Inject CSS before </head> (or before </body> as fallback)
        if (html.includes('</head>')) {
          html = html.replace('</head>', TTYD_INJECTED_CSS + '</head>');
        } else if (html.includes('</body>')) {
          html = html.replace('</body>', TTYD_INJECTED_CSS + '</body>');
        } else {
          html = TTYD_INJECTED_CSS + html;
        }

        // Forward status and relevant headers, update content-length.
        // The page URL carries the terminal capability, so: never cache it, and never
        // leak it in a Referer (xterm's link handler opens terminal URLs in new tabs).
        const headers: Record<string, string> = {
          'Content-Type': proxyRes.headers['content-type'] || 'text/html',
          'Content-Length': String(Buffer.byteLength(html)),
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        };
        res.writeHead(proxyRes.statusCode || 200, headers);
        res.end(html);
      });
    }
  );

  proxyReq.on('error', (err: Error) => {
    console.error('[ttyd-proxy] CSS injection fetch error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('ttyd connection failed: ' + err.message);
    }
  });

  proxyReq.end();
}

/**
 * Handle HTTP requests to ttyd. Returns false when the URL is not a proxy path (the
 * caller falls through to the normal gate + routes).
 */
export function handleTtydProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: TtydProxyOptions,
): boolean {
  const parsed = parseTtydProxyUrl(req.url || '');
  if (!parsed) return false;

  const verdict = decide(req, parsed, opts);
  if (verdict === 'unauthorized') {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(UNAUTHORIZED_HTML);
    return true;
  }
  if (verdict === 'not-managed') {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('Not a managed terminal');
    return true;
  }

  // Never forward the ring token to ttyd (or to whatever happens to own the port).
  delete req.headers['x-api-key'];
  const { port, rest } = parsed;

  // For root page requests, inject CSS + scroll-to-bottom JS into the HTML
  if (rest === '/') {
    fetchAndInjectCss(port, res);
    return true;
  }

  const target = `http://127.0.0.1:${port}`;

  // Rewrite the URL to remove the proxy prefix (and the capability segment)
  req.url = rest;

  proxy.web(req, res, { target }, (err: Error) => {
    console.error('[ttyd-proxy] HTTP proxy error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('ttyd connection failed: ' + err.message);
    }
  });

  return true;
}

/**
 * Handle WebSocket upgrade requests to ttyd — same decision as the HTTP path.
 */
export function handleTtydProxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  opts?: TtydProxyOptions,
): boolean {
  const parsed = parseTtydProxyUrl(req.url || '');
  if (!parsed) return false;

  const verdict = decide(req, parsed, opts);
  if (verdict !== 'ok') {
    const line = verdict === 'unauthorized' ? 'HTTP/1.1 401 Unauthorized' : 'HTTP/1.1 404 Not Found';
    try { socket.write(`${line}\r\nConnection: close\r\n\r\n`); } catch { /* socket gone */ }
    try { socket.destroy(); } catch { /* already destroyed */ }
    return true;
  }

  delete req.headers['x-api-key'];
  const target = `http://127.0.0.1:${parsed.port}`;

  // Rewrite the URL to remove the proxy prefix (and the capability segment)
  req.url = parsed.rest;

  proxy.ws(req, socket, head, { target }, (err: Error) => {
    console.error('[ttyd-proxy] WebSocket proxy error:', err.message);
    socket.destroy();
  });

  return true;
}

/**
 * Check if a URL path is a ttyd proxy path (either /ttyd-proxy/:port or /ttyd/:port).
 * Used by rest-server.ts to guard proxy handling before route matching.
 */
export function isTtydProxyPath(url: string): boolean {
  return /^\/ttyd(?:-proxy)?\/\d+/.test(url);
}

/**
 * Get the proxied URL for a ttyd instance. With a capability (TtydManager.proxyUrlForPort
 * mints one) the URL works in an iframe; without one it needs an x-api-key header.
 */
export function getTtydProxyUrl(
  port: number,
  baseUrl: string = `http://localhost:${__dirname.includes('node_modules') ? 3100 : 3200}`,
  cap?: string,
): string {
  return cap ? `${baseUrl}/ttyd-proxy/${port}/c/${cap}/` : `${baseUrl}/ttyd-proxy/${port}/`;
}
