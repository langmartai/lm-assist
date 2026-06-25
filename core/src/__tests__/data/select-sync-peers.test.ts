// core/src/__tests__/data/select-sync-peers.test.ts
// Unit tests for the selectSyncPeers() pure helper in peer-client.ts.
// Verifies that only ONLINE peers (excluding self) are returned for sync.
// No network calls, no hub dependency — pure function over raw machines data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSyncPeers } from '../../data/peer-client';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function machine(overrides: {
  id?: string;
  gatewayId?: string;
  machineId?: string;
  status?: string;
  hostname?: string;
  platform?: string;
}) {
  return {
    gatewayId: overrides.gatewayId ?? overrides.id ?? 'gw-test',
    machineId: overrides.machineId,
    status: overrides.status ?? 'online',
    hostname: overrides.hostname ?? 'host.example.com',
    platform: overrides.platform ?? 'linux',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('selectSyncPeers: includes online peers (excluding self)', () => {
  const machines = [
    machine({ id: 'gw-117', status: 'online', hostname: 'host117' }),
    machine({ id: 'gw-123', status: 'online', hostname: 'host123' }),
    machine({ id: 'gw-107', status: 'online', hostname: 'host107' }),
  ];

  const peers = selectSyncPeers(machines, 'gw-117');

  assert.equal(peers.length, 2, 'should return 2 online peers (not self)');
  const ids = peers.map((p) => p.node);
  assert.ok(ids.includes('gw-123'), 'gw-123 should be included');
  assert.ok(ids.includes('gw-107'), 'gw-107 should be included');
  assert.ok(!ids.includes('gw-117'), 'self (gw-117) must be excluded');
});

test('selectSyncPeers: excludes offline/stale peers', () => {
  const machines = [
    machine({ id: 'gw-117', status: 'online' }),                   // live
    machine({ id: 'gw-123', status: 'online' }),                   // live
    machine({ id: 'gw-stale1', status: 'offline' }),               // dead
    machine({ id: 'gw-stale2', status: 'stale' }),                 // dead
    machine({ id: 'gw-stale3', status: 'disconnected' }),          // dead
    machine({ id: 'gw-stale4', status: '' }),                      // no status → excluded
  ];

  const peers = selectSyncPeers(machines, 'gw-self');

  assert.equal(peers.length, 2, 'only 2 online peers should appear');
  const ids = peers.map((p) => p.node);
  assert.ok(ids.includes('gw-117'), 'gw-117 online included');
  assert.ok(ids.includes('gw-123'), 'gw-123 online included');
  assert.ok(!ids.includes('gw-stale1'), 'offline excluded');
  assert.ok(!ids.includes('gw-stale2'), 'stale excluded');
  assert.ok(!ids.includes('gw-stale3'), 'disconnected excluded');
  assert.ok(!ids.includes('gw-stale4'), 'empty-status excluded');
});

test('selectSyncPeers: excludes self even when self is online', () => {
  const machines = [
    machine({ id: 'gw-self', status: 'online' }),
    machine({ id: 'gw-peer', status: 'online' }),
  ];

  const peers = selectSyncPeers(machines, 'gw-self');

  assert.equal(peers.length, 1);
  assert.equal(peers[0].node, 'gw-peer');
});

test('selectSyncPeers: returns empty list when no online peers', () => {
  const machines = [
    machine({ id: 'gw-stale1', status: 'offline' }),
    machine({ id: 'gw-stale2', status: 'stale' }),
  ];

  const peers = selectSyncPeers(machines, 'gw-self');
  assert.equal(peers.length, 0, 'no peers when all are offline');
});

test('selectSyncPeers: returns empty list for empty machines array', () => {
  const peers = selectSyncPeers([], 'gw-self');
  assert.equal(peers.length, 0);
});

test('selectSyncPeers: status comparison is case-insensitive (Online, ONLINE)', () => {
  const machines = [
    machine({ id: 'gw-a', status: 'Online' }),
    machine({ id: 'gw-b', status: 'ONLINE' }),
    machine({ id: 'gw-c', status: 'Offline' }),
  ];

  const peers = selectSyncPeers(machines, 'gw-self');
  assert.equal(peers.length, 2, 'case-insensitive match: Online and ONLINE both qualify');
  const ids = peers.map((p) => p.node);
  assert.ok(ids.includes('gw-a'));
  assert.ok(ids.includes('gw-b'));
  assert.ok(!ids.includes('gw-c'));
});

test('selectSyncPeers: maps machineId/id fallback fields correctly', () => {
  // Some hub responses use machineId or plain id instead of gatewayId
  const machines = [
    { machineId: 'mc-peer', status: 'online', hostname: 'h1', platform: 'darwin' },
    { id: 'id-peer', status: 'online', hostname: 'h2', platform: 'win32' },
  ];

  const peers = selectSyncPeers(machines, 'gw-self');
  assert.equal(peers.length, 2);
  const ids = peers.map((p) => p.node);
  assert.ok(ids.includes('mc-peer'), 'machineId fallback works');
  assert.ok(ids.includes('id-peer'), 'id fallback works');
});

test('selectSyncPeers: maps hostname and platform fields correctly', () => {
  const machines = [
    { gatewayId: 'gw-a', status: 'online', hostname: 'myhost', machineHostname: 'fallback', platform: 'linux' },
    { gatewayId: 'gw-b', status: 'online', machineHostname: 'mh', machineOS: 'win32' },
  ];

  const peers = selectSyncPeers(machines, 'gw-self');
  assert.equal(peers.length, 2);

  const a = peers.find((p) => p.node === 'gw-a')!;
  assert.equal(a.hostname, 'myhost', 'hostname preferred over machineHostname');
  assert.equal(a.platform, 'linux');

  const b = peers.find((p) => p.node === 'gw-b')!;
  assert.equal(b.hostname, 'mh', 'machineHostname fallback works');
  assert.equal(b.platform, 'win32', 'machineOS fallback works');
});

test('selectSyncPeers: skips entries with no resolvable node id', () => {
  const machines = [
    { status: 'online', hostname: 'h1' },          // no id at all → must skip
    { gatewayId: '', status: 'online' },            // empty id → must skip
    { gatewayId: 'gw-ok', status: 'online' },      // valid
  ];

  const peers = selectSyncPeers(machines, 'gw-self');
  assert.equal(peers.length, 1);
  assert.equal(peers[0].node, 'gw-ok');
});
