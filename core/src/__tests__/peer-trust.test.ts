/**
 * peer-trust: a loopback socket is trusted only when nothing stood between it and
 * Core. Next's /_coreapi rewrite ALWAYS adds x-forwarded-host — possibly with an
 * EMPTY value (`req.headers.host || ''`) — so presence, not value, is the signal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORWARDING_HEADERS,
  RELAY_HEADER,
  hasForwardingHeaders,
  isRelayed,
  isDirectLoopbackPeer,
  isDirectLocalPeer,
} from '../auth/peer-trust';

test('forwarding-header list is the proxy-hop set; x-forwarded-proto is NOT in it', () => {
  assert.deepEqual([...FORWARDING_HEADERS], ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip']);
  assert.equal(RELAY_HEADER, 'x-relay-source');
  assert.ok(!(FORWARDING_HEADERS as readonly string[]).includes('x-forwarded-proto'));
});

test('presence counts — an EMPTY value is still a forwarding header', () => {
  assert.equal(hasForwardingHeaders({ 'x-forwarded-host': '' }), true);
  assert.equal(hasForwardingHeaders({ 'x-forwarded-for': '10.0.0.9' }), true);
  assert.equal(hasForwardingHeaders({ forwarded: 'for=10.0.0.9' }), true);
  assert.equal(hasForwardingHeaders({ 'x-real-ip': '10.0.0.9' }), true);
  assert.equal(hasForwardingHeaders({ 'X-Forwarded-Host': 'h' }), true, 'case-insensitive for hand-built maps');
});

test('no headers / unrelated headers / x-forwarded-proto alone → not forwarded', () => {
  assert.equal(hasForwardingHeaders(undefined), false);
  assert.equal(hasForwardingHeaders(null), false);
  assert.equal(hasForwardingHeaders({}), false);
  assert.equal(hasForwardingHeaders({ host: '127.0.0.1:3200', 'x-api-key': 'k' }), false);
  // The HTTPS terminator sets this on its in-process dispatch; that socket IS the peer.
  assert.equal(hasForwardingHeaders({ 'x-forwarded-proto': 'https' }), false);
  // An explicit undefined value is absence.
  assert.equal(hasForwardingHeaders({ 'x-forwarded-host': undefined }), false);
});

test('isRelayed: presence of x-relay-source, any value', () => {
  assert.equal(isRelayed({ 'x-relay-source': 'hub' }), true);
  assert.equal(isRelayed({ 'x-relay-source': '' }), true);
  assert.equal(isRelayed({ 'x-relay-source': 'peer' }), true);
  assert.equal(isRelayed({}), false);
});

test('isDirectLoopbackPeer: strict loopback forms, including ::ffff:127.0.0.1', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isDirectLoopbackPeer(ip, {}), true, ip);
  }
  for (const ip of ['10.0.0.5', '192.0.2.1', '', undefined, null]) {
    assert.equal(isDirectLoopbackPeer(ip as string, {}), false, String(ip));
  }
});

test('isDirectLoopbackPeer: forwarding headers always refuse; relay only with allowRelay', () => {
  assert.equal(isDirectLoopbackPeer('127.0.0.1', { 'x-forwarded-host': '' }), false);
  assert.equal(isDirectLoopbackPeer('127.0.0.1', { 'x-forwarded-host': '' }, { allowRelay: true }), false);
  assert.equal(isDirectLoopbackPeer('127.0.0.1', { 'x-relay-source': 'hub' }), false);
  assert.equal(isDirectLoopbackPeer('127.0.0.1', { 'x-relay-source': 'hub' }, { allowRelay: true }), true);
  assert.equal(
    isDirectLoopbackPeer('127.0.0.1', { 'x-relay-source': 'hub', 'x-forwarded-for': '1.2.3.4' }, { allowRelay: true }),
    false,
  );
  assert.equal(isDirectLoopbackPeer('127.0.0.1', { 'x-forwarded-proto': 'https' }), true);
});

test('isDirectLocalPeer: loopback is local; foreign IP is not; forwarding refuses', () => {
  assert.equal(isDirectLocalPeer('127.0.0.1', {}), true);
  assert.equal(isDirectLocalPeer('::ffff:127.0.0.1', {}), true);
  assert.equal(isDirectLocalPeer('198.51.100.77', {}), false);
  assert.equal(isDirectLocalPeer('127.0.0.1', { forwarded: 'for=1.2.3.4' }), false);
  assert.equal(isDirectLocalPeer('127.0.0.1', { 'x-relay-source': 'hub' }), false);
  assert.equal(isDirectLocalPeer('127.0.0.1', { 'x-relay-source': 'hub' }, { allowRelay: true }), true);
});
