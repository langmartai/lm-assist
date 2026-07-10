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

test('portfwd: known peer → 101 + bidirectional pipe to local service', async () => {
  setPortfwdUpgradeDeps({ isKnownPeer: (n) => n === 'peerA' });
  // Echo service (uppercases) proves both directions of the pipe.
  const svc = net.createServer({ allowHalfOpen: true }, (s) => {
    s.on('data', (d) => { try { s.write(Buffer.from(d.toString().toUpperCase())); } catch { /* ignore */ } });
    s.on('end', () => s.end());
  });
  const svcPort = await listen(svc);
  const core = makeTargetCore();
  const corePort = await listen(core);

  const res = await openPortfwdChannel({ host: '127.0.0.1', port: corePort }, 'peerA', svcPort);
  assert.ok(res, 'expected a direct socket');
  res!.socket.on('error', () => { /* ignore */ });
  const got = await new Promise<string>((resolve) => {
    let acc = '';
    res!.socket.on('data', (d) => { acc += d.toString(); if (acc.length >= 5) resolve(acc); });
    res!.socket.write('hello');
  });
  assert.strictEqual(got, 'HELLO');
  res!.socket.destroy();
  await new Promise((r) => svc.close(r));
  await new Promise((r) => core.close(r));
});

test('portfwd: unknown peer → rejected (null), service never dialed', async () => {
  setPortfwdUpgradeDeps({ isKnownPeer: (n) => n === 'peerA' });
  let dialed = false;
  const svc = net.createServer(() => { dialed = true; });
  const svcPort = await listen(svc);
  const core = makeTargetCore();
  const corePort = await listen(core);

  const res = await openPortfwdChannel({ host: '127.0.0.1', port: corePort }, 'attacker', svcPort);
  assert.strictEqual(res, null, 'unknown peer must be rejected');
  assert.strictEqual(dialed, false, 'target service must not be dialed for a rejected peer');
  await new Promise((r) => svc.close(r));
  await new Promise((r) => core.close(r));
});

test('portfwd: target service down → 502 (null)', async () => {
  setPortfwdUpgradeDeps({ isKnownPeer: () => true });
  const core = makeTargetCore();
  const corePort = await listen(core);
  // Reserve then free a port so nothing is listening on it.
  const dead = net.createServer();
  const deadPort = await listen(dead);
  await new Promise((r) => dead.close(r));

  const res = await openPortfwdChannel({ host: '127.0.0.1', port: corePort }, 'peerA', deadPort);
  assert.strictEqual(res, null, 'a dead target port must fail the upgrade');
  await new Promise((r) => core.close(r));
});

test('portfwd: server-greets-first banner is delivered (leftover or first data)', async () => {
  setPortfwdUpgradeDeps({ isKnownPeer: () => true });
  const banner = 'SSH-2.0-lmtest\r\n';
  const svc = net.createServer({ allowHalfOpen: true }, (s) => { try { s.write(banner); } catch { /* ignore */ } });
  const svcPort = await listen(svc);
  const core = makeTargetCore();
  const corePort = await listen(core);

  const res = await openPortfwdChannel({ host: '127.0.0.1', port: corePort }, 'peerA', svcPort);
  assert.ok(res, 'expected a direct socket');
  res!.socket.on('error', () => { /* ignore */ });
  let acc = res!.leftover.toString();
  if (!acc.includes('SSH-2.0')) {
    acc += await new Promise<string>((resolve) => res!.socket.once('data', (d) => resolve(d.toString())));
  }
  assert.ok(acc.includes('SSH-2.0-lmtest'), `banner not delivered: ${JSON.stringify(acc)}`);
  res!.socket.destroy();
  await new Promise((r) => svc.close(r));
  await new Promise((r) => core.close(r));
});

test('portfwd: invalid target port header → rejected (null)', async () => {
  setPortfwdUpgradeDeps({ isKnownPeer: () => true });
  const core = makeTargetCore();
  const corePort = await listen(core);
  // 0 is out of the 1–65535 range the handler accepts.
  const res = await openPortfwdChannel({ host: '127.0.0.1', port: corePort }, 'peerA', 0);
  assert.strictEqual(res, null, 'targetPort 0 must be rejected');
  await new Promise((r) => core.close(r));
});
