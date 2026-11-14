/**
 * lm-tcp/1 receiver trust (tcp-upgrade.ts). The upgrade runs outside the api-token gate
 * and hands the socket to the file-transfer receiver, so a peer must be an online fleet
 * node AND connect from the address that node advertised over the fabric HELLO — the same
 * source-IP binding lm-portfwd/1 has. A gatewayId alone (an identifier, not a secret) used
 * to be enough. Real handshake over loopback; no fleet needed.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import * as http from 'http';
import * as net from 'net';
import { isTcpUpgrade, handleTcpUpgrade, setTcpUpgradeDeps } from '../tcp-upgrade';

const accepted = new Set<net.Socket>();

function makeCore(): http.Server {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  server.on('connection', (s: net.Socket) => { accepted.add(s); s.on('close', () => accepted.delete(s)); });
  server.on('upgrade', (req, socket, head) => {
    if (isTcpUpgrade(req)) handleTcpUpgrade(req, socket, head);
    else socket.destroy();
  });
  return server;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res((server.address() as net.AddressInfo).port)));
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    for (const s of accepted) { try { s.destroy(); } catch { /* ignore */ } }
    accepted.clear();
    server.close(() => resolve());
    const t = setTimeout(resolve, 2000);
    if (typeof t.unref === 'function') t.unref();
  });
}

/** Send an lm-tcp/1 upgrade and return the response status line ('' if closed first). */
function upgrade(port: number, node: string | null): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); resolve(buf.split('\r\n')[0] || ''); }, 3000);
    const done = () => { clearTimeout(timer); sock.destroy(); resolve(buf.split('\r\n')[0] || ''); };
    sock.on('connect', () => {
      sock.write(
        'GET /transport/tcp HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: lm-tcp/1\r\nConnection: Upgrade\r\n' +
        (node === null ? '' : `x-lm-node: ${node}\r\n`) + '\r\n',
      );
    });
    sock.on('data', (d) => { buf += d.toString('latin1'); if (buf.includes('\r\n\r\n')) done(); });
    sock.on('error', () => done());
    sock.on('close', () => done());
  });
}

afterEach(() => setTcpUpgradeDeps(null));

test('lm-tcp: online peer from its advertised address → 101 and the channel is handed over', async () => {
  let channels = 0;
  setTcpUpgradeDeps({
    isKnownPeer: (n) => n === 'peerA',
    peerHost: (n) => (n === 'peerA' ? '127.0.0.1' : null),
    onChannel: (ch) => { channels++; try { ch.close(); } catch { /* ignore */ } },
  });
  const core = makeCore();
  const port = await listen(core);
  const status = await upgrade(port, 'peerA');
  assert.match(status, /^HTTP\/1\.1 101 /);
  assert.strictEqual(channels, 1);
  await closeServer(core);
});

test('lm-tcp: an IPv4-mapped advertised address still matches (normalized)', async () => {
  let channels = 0;
  setTcpUpgradeDeps({
    isKnownPeer: () => true,
    peerHost: () => '::ffff:127.0.0.1',
    onChannel: (ch) => { channels++; try { ch.close(); } catch { /* ignore */ } },
  });
  const core = makeCore();
  const port = await listen(core);
  assert.match(await upgrade(port, 'peerA'), /^HTTP\/1\.1 101 /);
  assert.strictEqual(channels, 1);
  await closeServer(core);
});

test('lm-tcp: a known gatewayId from the WRONG address is refused (403, no channel)', async () => {
  let channels = 0;
  setTcpUpgradeDeps({
    isKnownPeer: () => true, // the attacker knows a real online id
    peerHost: () => '10.9.9.9', // …but that node advertised another address
    onChannel: () => { channels++; },
  });
  const core = makeCore();
  const port = await listen(core);
  assert.match(await upgrade(port, 'peerA'), /^HTTP\/1\.1 403 /);
  assert.strictEqual(channels, 0);
  await closeServer(core);
});

test('lm-tcp: a peer with no advertised endpoint is refused (fails closed)', async () => {
  let channels = 0;
  setTcpUpgradeDeps({ isKnownPeer: () => true, peerHost: () => null, onChannel: () => { channels++; } });
  const core = makeCore();
  const port = await listen(core);
  assert.match(await upgrade(port, 'peerA'), /^HTTP\/1\.1 403 /);
  assert.strictEqual(channels, 0);
  await closeServer(core);
});

test('lm-tcp: a peerHost lookup that throws is refused, not crashed', async () => {
  let channels = 0;
  setTcpUpgradeDeps({
    isKnownPeer: () => true,
    peerHost: () => { throw new Error('fabric down'); },
    onChannel: () => { channels++; },
  });
  const core = makeCore();
  const port = await listen(core);
  assert.match(await upgrade(port, 'peerA'), /^HTTP\/1\.1 403 /);
  assert.strictEqual(channels, 0);
  await closeServer(core);
});

test('lm-tcp: unknown node → 403; missing x-lm-node or unwired → socket closed, no 101', async () => {
  let channels = 0;
  setTcpUpgradeDeps({ isKnownPeer: () => false, peerHost: () => '127.0.0.1', onChannel: () => { channels++; } });
  const core = makeCore();
  const port = await listen(core);
  assert.match(await upgrade(port, 'stranger'), /^HTTP\/1\.1 403 /);
  assert.doesNotMatch(await upgrade(port, null), /101/);
  setTcpUpgradeDeps(null);
  assert.doesNotMatch(await upgrade(port, 'peerA'), /101/);
  assert.strictEqual(channels, 0);
  await closeServer(core);
});
