/**
 * HTTPS terminator — the opt-in (LM_HTTPS=1) secure origin that makes the browser
 * mic work off-localhost. ONE https port serves the whole app so a single
 * self-signed-cert accept unlocks everything (acceptance is per host:port origin):
 *
 *   https://<host>:<webPort+1>
 *     /_coreapi[/*]            → prefix stripped, dispatched IN-PROCESS to Core's
 *                                request handler (REST + SSE stream natively; the
 *                                client socket stays the real remote, so loopback-only
 *                                route guards keep denying LAN callers)
 *     /voice/stt/ws            → Core's upgrade router (voice STT relay, ?token= auth)
 *     /voice/claude/ws         → Core's upgrade router (claude.ai voice v2 user bridge)
 *     /ttyd-proxy/*, /ttyd/*   → Core's request/upgrade handling (terminal proxy)
 *     everything else          → proxied to the local Next web server (ws:true so
 *                                dev-mode HMR upgrades pass through)
 *
 * Additive by design: plain-HTTP serving is untouched; this listener only exists
 * when LM_HTTPS is on, and a failure to start it never takes down the HTTP server.
 */

import * as https from 'https';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Duplex } from 'stream';
import httpProxy from 'http-proxy';

/** Same-origin prefix the web client uses for Core API calls on an https page. */
export const CORE_PROXY_PREFIX = '/_coreapi';

/** Exact core WS endpoints reachable on the secure origin without the prefix. */
const CORE_UPGRADE_PATHS = ['/voice/stt/ws', '/voice/claude/ws'];

/** Core path prefixes passed through as-is (terminal proxy family). */
const CORE_PASSTHROUGH_PREFIXES = ['/ttyd-proxy/', '/ttyd/'];

export type TerminatorRoute = { target: 'core'; url: string } | { target: 'web' };

/** Pure routing decision for a terminator request/upgrade URL. */
export function classifyTerminatorRequest(url: string): TerminatorRoute {
  if (
    url === CORE_PROXY_PREFIX ||
    url.startsWith(CORE_PROXY_PREFIX + '/') ||
    url.startsWith(CORE_PROXY_PREFIX + '?')
  ) {
    let rest = url.slice(CORE_PROXY_PREFIX.length);
    if (rest === '') rest = '/';
    else if (rest.startsWith('?')) rest = '/' + rest;
    return { target: 'core', url: rest };
  }
  const pathOnly = url.split('?')[0];
  if (CORE_UPGRADE_PATHS.includes(pathOnly)) return { target: 'core', url };
  if (CORE_PASSTHROUGH_PREFIXES.some((p) => pathOnly.startsWith(p))) return { target: 'core', url };
  return { target: 'web' };
}

export interface HttpsTerminatorOptions {
  port: number;
  host: string;
  key: string;
  cert: string;
  /** Local Next web server port this terminator fronts. */
  webPort: number;
  /** Core's plain-HTTP request handler (called in-process, no TCP hop). */
  coreRequest: (req: IncomingMessage, res: ServerResponse) => void;
  /** Core's upgrade router (voice / ttyd / tcp transports). */
  coreUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  log?: (msg: string) => void;
}

/** Start the terminator. Resolves once listening; rejects on listen errors (EADDRINUSE). */
export function startHttpsTerminator(opts: HttpsTerminatorOptions): Promise<https.Server> {
  const log = opts.log || (() => {});
  const proxy = httpProxy.createProxyServer({
    target: { host: '127.0.0.1', port: opts.webPort },
    ws: true,
    xfwd: true,
  });
  proxy.on('error', (err, _req, resOrSocket) => {
    log(`[HTTPS] web proxy error: ${err.message}`);
    const res = resOrSocket as ServerResponse | Duplex | undefined;
    if (res && 'writeHead' in res && typeof res.writeHead === 'function') {
      try {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'web upstream unavailable', detail: err.message }));
      } catch { /* response already gone */ }
    } else if (res && 'destroy' in res && typeof res.destroy === 'function') {
      try { res.destroy(); } catch { /* already destroyed */ }
    }
  });

  const server = https.createServer({ key: opts.key, cert: opts.cert }, (req, res) => {
    const route = classifyTerminatorRequest(req.url || '/');
    if (route.target === 'core') {
      req.url = route.url;
      // In-process dispatch: overwrite (never trust client-sent) forwarding headers.
      req.headers['x-forwarded-proto'] = 'https';
      opts.coreRequest(req, res);
      return;
    }
    proxy.web(req, res);
  });

  server.on('upgrade', (req, socket, head) => {
    const route = classifyTerminatorRequest(req.url || '/');
    if (route.target === 'core') {
      req.url = route.url;
      req.headers['x-forwarded-proto'] = 'https';
      opts.coreUpgrade(req, socket, head);
      return;
    }
    proxy.ws(req, socket, head);
  });

  // Browsers probe TLS and abandon handshakes routinely (and every device that has
  // not yet accepted the self-signed cert aborts here) — not worth log noise.
  server.on('tlsClientError', () => { /* expected churn */ });

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(opts.port, opts.host, () => {
      server.removeListener('error', onError);
      resolve(server);
    });
  });
}
