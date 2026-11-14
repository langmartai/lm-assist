/**
 * Turn provenance on injected session messages.
 *
 * Claude Code's inbound-event schema is explicit about this: `origin` is
 * "Provenance of a user-role message (peer session, team lead, channel). A host
 * wrapping keyboard input must stamp {kind:'human'} explicitly — absent origin
 * is treated as unattributed and FAILS CLOSED at strict isHuman() trust gates."
 *
 * lm-assist is that host. When it delivered a turn over the remote-control
 * driver with no `origin`, the ingress demoted it to `{kind:"peer",from:"unknown"}`
 * and the receiving session was told "Another Claude session sent a message —
 * not typed by your user". Measured on two real deliveries (2026-08-15): the
 * operator's own `/model opus`, and a mission worker's own mission brief. Under
 * that framing a message never establishes user intent, so the worker is
 * instructed to discount its own assignment.
 *
 * The stamp must be per-message, because the SAME route also carries genuine
 * session-to-session relays — those really ARE peer traffic and must keep the
 * warning, with a real sender name instead of "unknown".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { originForInjection, parseOrigin } from '../session-messaging/origin';
import {
  injectViaChain,
  remoteControlDriver,
  type DriverTransport,
  type InjectionDriver,
} from '../session-messaging/inject';
import { buildDriveEvent } from '../terminal/ccr-cloud';

test('originForInjection: an operator/mission turn with no sending session is stamped human', () => {
  assert.deepEqual(originForInjection({ fromSession: '', fromNode: 'node-117' }), { kind: 'human' });
});

test('originForInjection: whitespace-only fromSession is still an operator turn', () => {
  assert.deepEqual(originForInjection({ fromSession: '   ', fromNode: '' }), { kind: 'human' });
});

test('originForInjection: a real session-to-session relay stays peer, named', () => {
  assert.deepEqual(
    originForInjection({ fromSession: 'ecd95743-e59d', fromNode: 'node-117' }),
    { kind: 'peer', from: 'ecd95743-e59d' },
  );
});

test('remoteControlDriver.deliver forwards the origin to the relay route', async () => {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const t: DriverTransport = {
    async get() { return { success: true, data: { driveable: true } }; },
    async post(path, body) { posts.push({ path, body }); return { success: true, data: {} }; },
  };

  await remoteControlDriver.deliver('sess-1', 'hello', t, { kind: 'human' });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/terminal/remote-control/sess-1/send');
  assert.deepEqual(posts[0].body, { text: 'hello', origin: { kind: 'human' } });
});

test('injectViaChain threads the origin down to the driver that delivers', async () => {
  const seen: unknown[] = [];
  const driver: InjectionDriver = {
    name: 'remote-control',
    async available() { return true; },
    async deliver(_s, _w, _t, origin) { seen.push(origin); },
  };
  const nullTransport: DriverTransport = {
    async get() { return { success: true, data: {} }; },
    async post() { return { success: true, data: {} }; },
  };

  const r = await injectViaChain('sess-1', 'body', [driver], nullTransport, { kind: 'peer', from: 'other-sess' });

  assert.equal(r.delivered, true);
  assert.deepEqual(seen, [{ kind: 'peer', from: 'other-sess' }]);
});

test('buildDriveEvent carries the origin when one is supplied', () => {
  const e = buildDriveEvent('session_x', 'next', 'fixed', { kind: 'human' });
  assert.deepEqual((e as { origin?: unknown }).origin, { kind: 'human' });
});

test('buildDriveEvent omits origin entirely when none is supplied', () => {
  const e = buildDriveEvent('session_x', 'next', 'fixed');
  assert.equal('origin' in e, false);
});

// ── parseOrigin: what the relay routes accept off the wire ──────────────────
// A malformed stamp forwarded to the ingress is worse than none, and an unnamed
// peer stamp reproduces the exact `from:"unknown"` state this fix exists to
// remove — so both are dropped rather than passed through.

test('parseOrigin accepts a human stamp', () => {
  assert.deepEqual(parseOrigin({ kind: 'human' }), { kind: 'human' });
});

test('parseOrigin accepts a named peer stamp', () => {
  assert.deepEqual(parseOrigin({ kind: 'peer', from: 'sess-9' }), { kind: 'peer', from: 'sess-9' });
});

test('parseOrigin drops a peer stamp with no sender name', () => {
  assert.equal(parseOrigin({ kind: 'peer' }), undefined);
  assert.equal(parseOrigin({ kind: 'peer', from: '   ' }), undefined);
});

test('parseOrigin drops unknown kinds and non-objects', () => {
  assert.equal(parseOrigin({ kind: 'coordinator' }), undefined);
  assert.equal(parseOrigin('human'), undefined);
  assert.equal(parseOrigin(null), undefined);
  assert.equal(parseOrigin(undefined), undefined);
});

test('parseOrigin never forwards extra caller-supplied fields to the ingress', () => {
  assert.deepEqual(
    parseOrigin({ kind: 'human', senderTaskId: 'x', inbound_origin: 'spoofed', hopChain: ['a'] }),
    { kind: 'human' },
  );
});
