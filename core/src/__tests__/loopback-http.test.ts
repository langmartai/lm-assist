// Loopback proxying must not reuse a pooled socket.
//
// Incident 2026-08-13 (117): a pane's "run now" / "reindex" button returned 502 after exactly
// 30 s, while the SAME call made directly against Core answered in 1.5 ms — and a retry through
// the pane succeeded instantly. Measured while the proxied request hung: Core answered five
// direct /health probes in 1–4 ms, so Core was never blocked. The request died in the proxy's
// socket.
//
// Cause: every loopback proxy here calls http.request() WITHOUT an agent, so it uses
// http.globalAgent — and Node 19 flipped that agent's default to keepAlive:true. Its idle
// timeout is 5000 ms and http.Server's default keepAliveTimeout is ALSO 5000 ms (asserted
// below). Identical timeouts on both ends is the classic race: after an idle gap — a human
// reading the pane before clicking — the pool can hand out a socket the server is closing at
// that instant. The request is written into it, no response ever comes, and the caller's own
// timeout (30 s in the local tier) turns it into a 502.
//
// This code was written when globalAgent.keepAlive defaulted to false; agent:false restores
// exactly that. A fresh loopback socket costs microseconds, which is why no pooling is wanted
// here in the first place.
import { test } from 'node:test';
import assert from 'node:assert';
import * as http from 'http';
import { loopbackOptions } from '../utils/loopback-http';

/** Listen on an ephemeral port. */
function listen(s: http.Server): Promise<number> {
  return new Promise((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));
}

/** One request through `opts`, resolving 'ok' | 'timeout' | an error code. */
function hit(port: number, opts: http.RequestOptions, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/x', method: 'GET', ...opts }, (r) => {
      r.resume();
      r.on('end', () => resolve('ok'));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve('timeout'); });
    req.on('error', (e) => resolve((e as NodeJS.ErrnoException).code || 'error'));
    req.end();
  });
}

test('the Node defaults that make this bite are still what we think they are', () => {
  // If any of these changes, re-read the reasoning above before touching the fix. The equal
  // 5000/5000 pair is the whole hazard: both ends expire at the same instant.
  const agent = http.globalAgent as unknown as { keepAlive: boolean; options: { timeout?: number } };
  assert.equal(agent.keepAlive, true, 'globalAgent pools sockets since Node 19');
  assert.equal(agent.options.timeout, 5000, 'client idle timeout');
  const s = http.createServer(() => {});
  assert.equal(s.keepAliveTimeout, 5000, 'server idle timeout — identical, hence the race');
  s.close();
});

test('the default agent REUSES a socket; loopbackOptions never does', async () => {
  // Counting connections is the deterministic half of the bug. The race that turns a reused
  // socket into a 30 s hang needs both ends to expire together and cannot be pinned in a test —
  // but "is this request even capable of landing on a socket the server may already be closing?"
  // can be, and that is precisely what the fix removes.
  let connections = 0;
  const srv = http.createServer((_rq, rs) => { rs.writeHead(200); rs.end('hi'); });
  srv.on('connection', () => { connections++; });
  const port = await listen(srv);
  try {
    assert.equal(await hit(port, {}, 1500), 'ok');
    assert.equal(await hit(port, {}, 1500), 'ok');
    assert.equal(connections, 1, 'default agent: the second request rode the pooled socket');

    connections = 0;
    assert.equal(await hit(port, loopbackOptions(), 1500), 'ok');
    assert.equal(await hit(port, loopbackOptions(), 1500), 'ok');
    assert.equal(connections, 2, 'loopbackOptions: a fresh socket each time, nothing to inherit');
  } finally {
    srv.close();
  }
});

test('loopbackOptions carries agent:false and preserves whatever the caller passed', () => {
  const o = loopbackOptions({ method: 'POST', headers: { 'x-api-key': 'k' } });
  assert.equal(o.agent, false);
  assert.equal(o.method, 'POST');
  assert.deepEqual(o.headers, { 'x-api-key': 'k' });
  // A caller must not be able to re-enable pooling by accident.
  assert.equal(loopbackOptions({ agent: http.globalAgent } as http.RequestOptions).agent, false);
});
