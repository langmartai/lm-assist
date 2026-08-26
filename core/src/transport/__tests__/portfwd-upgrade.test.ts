/**
 * Unit tests for the direct port-forward upgrade (lm-portfwd/1). Exercises the
 * real handshake end-to-end over loopback: openPortfwdChannel (listener side) ↔
 * handlePortfwdUpgrade (target side) ↔ a local "service" socket. No fleet needed.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import * as http from 'http';
import * as net from 'net';
import {
  isPortfwdUpgrade,
  handlePortfwdUpgrade,
  setPortfwdUpgradeDeps,
  openPortfwdChannel,
  type PortfwdOpenResult,
} from '../portfwd-upgrade';

/**
 * Every socket these test servers accept, so teardown can drop them.
 *
 * The portfwd pipe uses `allowHalfOpen` deliberately (test 2 depends on it), so a service
 * that greets and never ends leaves a half-open socket alive: readable=false, writable=true,
 * not destroyed. Three of those outlived the suite and kept the node process alive, so the
 * FILE timed out even though every test in it passed.
 */
const accepted = new Set<net.Socket>();

function listen(server: net.Server | http.Server): Promise<number> {
  server.on('connection', (s: net.Socket) => {
    accepted.add(s);
    s.on('close', () => accepted.delete(s));
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res((server.address() as net.AddressInfo).port)));
}

/** A "target Core" HTTP server that answers lm-portfwd upgrades. */
function makeTargetCore(): http.Server {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  server.on('upgrade', (req, socket, head) => {
    if (isPortfwdUpgrade(req)) handlePortfwdUpgrade(req, socket, head);
    else socket.destroy();
  });
  return server;
}


/**
 * Close a test server WITHOUT waiting on its live connections.
 *
 * `server.close()` stops accepting and then waits for every existing connection to end.
 * The portfwd tests leave a service connection open on purpose (a server-greets-first
 * banner is never ended by the service), so the callback never fired and the whole FILE
 * hung — costing the runner a 240s batch timeout plus a 25-file bisect on every run, and
 * leaving `npm test` unable to exit 0. Dropping the sockets first makes close() settle.
 */
function closeServer(server: net.Server | http.Server): Promise<void> {
  return new Promise((resolve) => {
    for (const s of accepted) { try { s.destroy(); } catch { /* ignore */ } }
    accepted.clear();
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close(() => resolve());
    // Belt and braces on runtimes without closeAllConnections: never block teardown.
    const t = setTimeout(resolve, 2000);
    if (typeof t.unref === 'function') t.unref();
  });
}

/** Narrow a result to its ready socket, or fail the test. */
function expectSocket(res: PortfwdOpenResult): { socket: net.Socket; leftover: Buffer } {
  assert.ok('socket' in res, `expected a ready socket, got ${JSON.stringify(res)}`);
  return res as { socket: net.Socket; leftover: Buffer };
}

test('portfwd: known peer + matching IP → 101 + bidirectional pipe to local service', async () => {
  setPortfwdUpgradeDeps({ isKnownPeer: (n) => n === 'peerA', peerHost: () => '127.0.0.1' });
  const svc = net.createServer({ allowHalfOpen: true }, (s) => {
    s.on('data', (d) => { try { s.write(Buffer.from(d.toString().toUpperCase())); } catch { /* ignore */ } });
    s.on('end', () => s.end());
  });
  const svcPort = await listen(svc);
  const core = makeTargetCore();
  const corePort = await listen(core);

  const res = await openPortfwdChannel({ host: '127.0.0.1', port: corePort }, 'peerA', svcPort);
  const { socket } = expectSocket(res);
  socket.on('error', () => { /* ignore */ });
  const got = await new Promise<string>((resolve) => {
    let acc = '';
    socket.on('data', (d) => { acc += d.toString(); if (acc.length >= 5) resolve(acc); });
    socket.write('hello');
  });
  assert.strictEqual(got, 'HELLO');
  socket.destroy();
  await closeServer(svc);
  await closeServer(core);
});

test('portfwd: half-close — response after the client FIN is NOT truncated', async () => {
  // The service replies only AFTER it sees the client's FIN (read-all-then-respond,
  // like nc -N). Without allowHalfOpen on the tunnel sockets this truncates.
  setPortfwdUpgradeDeps({ isKnownPeer: () => true, peerHost: () => '127.0.0.1' });
  const svc = net.createServer({ allowHalfOpen: true }, (s) => {
    let got = '';
    s.on('data', (d) => { got += d.toString(); });
    s.on('end', () => { try { s.end('REPLY:' + got); } catch { /* ignore */ } });
  });
  const svcPort = await listen(svc);
  const core = makeTargetCore();
  const corePort = await listen(core);

  const res = await openPortfwdChannel({ host: '127.0.0.1', port: corePort }, 'peerA', svcPort);
  const { socket, leftover } = expectSocket(res);
  socket.on('error', () => { /* ignore */ });
  const reply = await new Promise<string>((resolve) => {
    let acc = leftover.toString();
    socket.on('data', (d) => { acc += d.toString(); });
    socket.on('end', () => resolve(acc));
    socket.on('close', () => resolve(acc));
    socket.end('QUERY'); // write then half-close (FIN)
  });
  assert.strictEqual(reply, 'REPLY:QUERY', 'response after client half-close must survive');
  await closeServer(svc);
  await closeServer(core);
});

test('portfwd: server-greets-first banner delivered (leftover or first data)', async () => {
  setPortfwdUpgradeDeps({ isKnownPeer: () => true, peerHost: () => '127.0.0.1' });
  const banner = 'SSH-2.0-lmtest\r\n';
  const svc = net.createServer({ allowHalfOpen: true }, (s) => { try { s.write(banner); } catch { /* ignore */ } });
  const svcPort = await listen(svc);
  const core = makeTargetCore();
  const corePort = await listen(core);

  const res = await openPortfwdChannel({ host: '127.0.0.1', port: corePort }, 'peerA', svcPort);
  const { socket, leftover } = expectSocket(res);
  socket.on('error', () => { /* ignore */ });
  let acc = leftover.toString();
  if (!acc.includes('SSH-2.0')) {
    // Bounded, and it also settles on close. Awaiting a bare `once('data')` meant that if
    // the banner never arrived — the socket closed first, or the bytes landed in
    // `leftover` and no further data ever came — the promise never settled and the whole
    // FILE hung, costing the runner a 240s batch timeout plus a 25-file bisect on every
    // run and making `npm test` unable to exit 0. A test may pass or fail; it may not hang.
    acc += await new Promise<string>((resolve) => {
      const settle = (v: string) => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('close', onClose);
        socket.off('end', onClose);
        resolve(v);
      };
      const onData = (d: Buffer) => settle(d.toString());
      const onClose = () => settle('');
      const timer = setTimeout(() => settle(''), 5000);
      socket.on('data', onData);
      socket.on('close', onClose);
      socket.on('end', onClose);
    });
  }
  assert.ok(acc.includes('SSH-2.0-lmtest'), `banner not delivered: ${JSON.stringify(acc)}`);
  socket.destroy();
  await closeServer(svc);
  await closeServer(core);
});

test('portfwd: unknown peer → answered(403), service never dialed', async () => {
  setPortfwdUpgradeDeps({ isKnownPeer: (n) => n === 'peerA', peerHost: () => '127.0.0.1' });
  let dialed = false;
  const svc = net.createServer(() => { dialed = true; });
  const svcPort = await listen(svc);
  const core = makeTargetCore();
  const corePort = await listen(core);

  const res = await openPortfwdChannel({ host: '127.0.0.1', port: corePort }, 'attacker', svcPort);
  assert.deepStrictEqual(res, { error: 'answered' }, 'a 403 must be reported as answered (peer replied)');
  assert.strictEqual(dialed, false, 'target service must not be dialed for a rejected peer');
  await closeServer(svc);
  await closeServer(core);
});

test('portfwd: target service down → answered(502), NOT unreachable (must not poison peer cache)', async () => {
  setPortfwdUpgradeDeps({ isKnownPeer: () => true, peerHost: () => '127.0.0.1' });
  const core = makeTargetCore();
  const corePort = await listen(core);
  const dead = net.createServer();
  const deadPort = await listen(dead);
  await closeServer(dead); // free the port so the dial is refused

  const res = await openPortfwdChannel({ host: '127.0.0.1', port: corePort }, 'peerA', deadPort);
  assert.deepStrictEqual(res, { error: 'answered' }, 'a dead target PORT is answered(502), not a dead PATH');
  await closeServer(core);
});

test('portfwd: source IP not matching the peer HELLO address → answered(403)', async () => {
  setPortfwdUpgradeDeps({ isKnownPeer: () => true, peerHost: () => '10.9.9.9' });
  let dialed = false;
  const svc = net.createServer(() => { dialed = true; });
  const svcPort = await listen(svc);
  const core = makeTargetCore();
  const corePort = await listen(core);

  const res = await openPortfwdChannel({ host: '127.0.0.1', port: corePort }, 'peerA', svcPort);
  assert.deepStrictEqual(res, { error: 'answered' }, 'source-IP mismatch must be rejected');
  assert.strictEqual(dialed, false, 'target service must not be dialed on an address mismatch');
  await closeServer(svc);
  await closeServer(core);
});

test('portfwd: unknown peer HELLO address (null) → answered(403)', async () => {
  setPortfwdUpgradeDeps({ isKnownPeer: () => true, peerHost: () => null });
  const core = makeTargetCore();
  const corePort = await listen(core);
  const res = await openPortfwdChannel({ host: '127.0.0.1', port: corePort }, 'peerA', 5555);
  assert.deepStrictEqual(res, { error: 'answered' }, 'unknown peer address must be rejected');
  await closeServer(core);
});

test('portfwd: peer that closes without answering (old code) → unreachable (caches)', async () => {
  // A Core with no lm-portfwd support destroys the upgrade socket → no HTTP status.
  const server = http.createServer((_q, r) => { r.writeHead(200); r.end(); });
  server.on('upgrade', (_req, socket) => { socket.destroy(); }); // old-code behavior
  const port = await listen(server);
  const res = await openPortfwdChannel({ host: '127.0.0.1', port }, 'peerA', 22);
  assert.deepStrictEqual(res, { error: 'unreachable' }, 'a peer that never answers is unreachable → cacheable');
  await new Promise((r) => server.close(r));
});

test('portfwd: connect refused (nothing listening) → unreachable', async () => {
  const probe = net.createServer();
  const deadPort = await listen(probe);
  await new Promise((r) => probe.close(r));
  const res = await openPortfwdChannel({ host: '127.0.0.1', port: deadPort }, 'peerA', 22);
  assert.deepStrictEqual(res, { error: 'unreachable' }, 'a refused connect is unreachable');
});

test('portfwd: IPv4-mapped-IPv6 peerHost normalizes and matches', async () => {
  setPortfwdUpgradeDeps({ isKnownPeer: () => true, peerHost: () => '::ffff:127.0.0.1' });
  const svc = net.createServer({ allowHalfOpen: true }, (s) => s.on('data', (d) => { try { s.write(d); } catch { /* ignore */ } }));
  const svcPort = await listen(svc);
  const core = makeTargetCore();
  const corePort = await listen(core);
  const res = await openPortfwdChannel({ host: '127.0.0.1', port: corePort }, 'peerA', svcPort);
  const { socket } = expectSocket(res);
  socket.destroy();
  await closeServer(svc);
  await closeServer(core);
});
