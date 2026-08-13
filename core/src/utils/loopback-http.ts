/**
 * Request options for talking to a service on 127.0.0.1 — the ONE place the socket-pooling
 * policy for loopback proxying is decided.
 *
 * 🔴 `agent: false` — a fresh socket per request, never the pool. This is not a style choice.
 *
 * Measured 2026-08-13 (117): a pane's "run now" button returned 502 after exactly 30 s while the
 * identical call made directly against Core answered in 1.5 ms, and an immediate retry through
 * the pane succeeded in 4 ms. During the 30 s hang Core answered five direct /health probes in
 * 1–4 ms, so Core was never blocked — the request never reached it.
 *
 * Every loopback proxy here called http.request() with no agent, i.e. http.globalAgent, whose
 * default flipped to `keepAlive: true` in Node 19. Its idle timeout is 5000 ms; http.Server's
 * default keepAliveTimeout is ALSO 5000 ms. Equal timeouts on both ends is the classic race:
 * after an idle gap — a human reading a pane before clicking a button — the pool can hand out a
 * socket the server is closing at that very moment. The request goes into it, no response comes
 * back, and the caller's own timeout turns a working endpoint into a 502. Reads mostly survived
 * because a pane fires several on load and keeps the pool warm; a deliberate click after a pause
 * is exactly the shape that loses.
 *
 * This code was written when globalAgent.keepAlive was false, so `agent: false` restores the
 * behaviour it was written against rather than inventing one. Pooling buys nothing over loopback
 * — connection setup is microseconds — while costing a class of silent 30 s hangs.
 *
 * Use this for EVERY 127.0.0.1 http.request in this codebase (the hub relay's call into Core and
 * the local serving tier's asset/data/document proxies all share the failure).
 */
import type { RequestOptions } from 'http';

export function loopbackOptions(opts: RequestOptions = {}): RequestOptions {
  // `agent` last: a caller cannot re-enable pooling, by accident or by copy-paste.
  return { ...opts, agent: false };
}
