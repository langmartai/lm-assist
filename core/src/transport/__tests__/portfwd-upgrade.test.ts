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

function listen(server: net.Server | http.Server): Promise<number> {
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
  await new Promise((r) => svc.close(r));
  await new Promise((r) => core.close(r));
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
  await new Promise((r) => svc.close(r));
  await new Promise((r) => core.close(r));
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
    acc += await new Promise<string>((resolve) => socket.once('data', (d) => resolve(d.toString())));
  }
  assert.ok(acc.includes('SSH-2.0-lmtest'), `banner not delivered: ${JSON.stringify(acc)}`);
  socket.destroy();
  await new Promise((r) => svc.close(r));
  await new Promise((r) => core.close(r));
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
  await new Promise((r) => svc.close(r));
  await new Promise((r) => core.close(r));
});

test('portfwd: target service down → answered(502), NOT unreachable (must not poison peer cache)', async () => {
  setPortfwdUpgradeDeps({ isKnownPeer: () => true, peerHost: () => '127.0.0.1' });
  const core = makeTargetCore();
  const corePort = await listen(core);
  const dead = net.createServer();
  const deadPort = await listen(dead);
  await new Promise((r) => dead.close(r)); // free the port so the dial is refused

  const res = await openPortfwdChannel({ host: '127.0.0.1', port: corePort }, 'peerA', deadPort);
  assert.deepStrictEqual(res, { error: 'answered' }, 'a dead target PORT is answered(502), not a dead PATH');
  await new Promise((r) => core.close(r));
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
  await new Promise((r) => svc.close(r));
  await new Promise((r) => core.close(r));
});

test('portfwd: unknown peer HELLO address (null) → answered(403)', async () => {
  setPortfwdUpgradeDeps({ isKnownPeer: () => true, peerHost: () => null });
  const core = makeTargetCore();
  const corePort = await listen(core);
  const res = await openPortfwdChannel({ host: '127.0.0.1', port: corePort }, 'peerA', 5555);
  assert.deepStrictEqual(res, { error: 'answered' }, 'unknown peer address must be rejected');
  await new Promise((r) => core.close(r));
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
  await new Promise((r) => svc.close(r));
  await new Promise((r) => core.close(r));
});
