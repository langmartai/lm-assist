/**
 * ttyd Proxy - Proxies ttyd connections through the main server
 *
 * This solves cross-origin issues by serving ttyd through the same origin,
 * allowing the frontend to control xterm.js (e.g., scroll to bottom).
 */

import * as http from 'http';
import httpProxy from 'http-proxy';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Socket } from 'net';
import type { Duplex } from 'stream';

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
 * Extract port from proxy path
 * Path formats:
 *   /ttyd-proxy/:port/...  — local proxy path (used by admin-web iframes)
 *   /ttyd/:port/...        — Hub relay path (used when accessed via langmart.ai)
 *
 * The Hub relay strips its prefix and forwards as /ttyd/:port/... which needs
 * the same proxy treatment as /ttyd-proxy/:port/... (e.g., /ttyd/7684/token
 * must reach the actual ttyd /token endpoint for WebSocket reconnection).
 */
function extractPort(url: string): { port: number; path: string } | null {
  const match = url.match(/^\/ttyd(?:-proxy)?\/(\d+)(\/.*)?$/);
  if (!match) return null;

  const port = parseInt(match[1], 10);
  const path = match[2] || '/';

  if (isNaN(port) || port < 1 || port > 65535) return null;

  return { port, path };
}

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
      if (url.match(/^https?:\/\//i) && url.indexOf(window.location.host) === -1) return url;
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
  var daRe = /\x1b\[[\?>]\d+(?:;\d+)*c|\[>\d+(?:;\d+)*c/g;
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
    { hostname: 'localhost', port, path: '/', method: 'GET' },
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

        // Forward status and relevant headers, update content-length
        const headers: Record<string, string> = {
          'Content-Type': proxyRes.headers['content-type'] || 'text/html',
          'Content-Length': String(Buffer.byteLength(html)),
        };
        if (proxyRes.headers['cache-control']) {
          headers['Cache-Control'] = proxyRes.headers['cache-control'] as string;
        }
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
 * Handle HTTP requests to ttyd
 */
export function handleTtydProxyRequest(
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  const parsed = extractPort(req.url || '');
  if (!parsed) return false;

  const { port, path } = parsed;

  // For root page requests, inject CSS + scroll-to-bottom JS into the HTML
  if (path === '/') {
    fetchAndInjectCss(port, res);
    return true;
  }

  const target = `http://localhost:${port}`;

  // Rewrite the URL to remove the proxy prefix
  req.url = path;

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
 * Handle WebSocket upgrade requests to ttyd
 */
export function handleTtydProxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): boolean {
  const parsed = extractPort(req.url || '');
  if (!parsed) return false;

  const { port, path } = parsed;
  const target = `http://localhost:${port}`;

  // Rewrite the URL to remove the proxy prefix
  req.url = path;

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
 * Get the proxied URL for a ttyd instance
 */
export function getTtydProxyUrl(port: number, baseUrl: string = 'http://localhost:3100'): string {
  return `${baseUrl}/ttyd-proxy/${port}/`;
}
