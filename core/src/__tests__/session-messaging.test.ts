import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Point the store at an isolated data dir BEFORE importing the modules that
// read getDataDir() at module-eval time.
const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `sm-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.LM_ASSIST_DATA_DIR = TEST_DATA_DIR;

import { wrapForInjection, categoryLabel } from '../session-messaging/preamble';
import {
  injectViaChain,
  type InjectionDriver,
  type DriverTransport,
} from '../session-messaging/inject';
import * as store from '../session-messaging/store';
import { sendMessage, getStatus, sweepPending } from '../session-messaging';
import type { MessageCategory } from '../session-messaging/types';

// A transport that should never be touched (drivers are mocked).
const nullTransport: DriverTransport = {
  async get() { throw new Error('transport.get should not be called'); },
  async post() { throw new Error('transport.post should not be called'); },
};

function mockDriver(
  name: InjectionDriver['name'],
  opts: { available: boolean; deliverOk: boolean; onDeliver?: () => void },
): InjectionDriver {
  return {
    name,
    async available() { return opts.available; },
    async deliver() {
      opts.onDeliver?.();
      if (!opts.deliverOk) throw new Error(`${name} deliver failed`);
    },
  };
}

// ─── preamble wrapping ───────────────────────────────────────────

test('categoryLabel distinguishes the three categories', () => {
  for (const c of ['reference', 'guided', 'overwrite'] as MessageCategory[]) {
    assert.ok(categoryLabel(c).length > 0);
  }
  assert.notEqual(categoryLabel('reference'), categoryLabel('guided'));
  assert.notEqual(categoryLabel('guided'), categoryLabel('overwrite'));
});

test('wrapForInjection labels each category + embeds id and body', () => {
  const base = { id: 'msg-abc', body: 'do the thing', fromNode: 'nodeA', fromSession: 'sessX' };

  const ref = wrapForInjection({ ...base, category: 'reference' });
  assert.match(ref, /REFERENCE/);
  assert.match(ref, /NOT an instruction/i);

  const guided = wrapForInjection({ ...base, category: 'guided' });
  assert.match(guided, /GUIDED/);
  assert.match(guided, /review/i);

  const over = wrapForInjection({ ...base, category: 'overwrite' });
  assert.match(over, /OVERWRITE/);
  assert.match(over, /override/i);

  // common: id + body + provenance present in all
  for (const w of [ref, guided, over]) {
    assert.match(w, /msg-abc/);
    assert.match(w, /do the thing/);
    assert.match(w, /sessX/);
  }
});

// ─── driver-fallback selection ───────────────────────────────────

test('injectViaChain picks the first available+ok driver', async () => {
  let secondCalled = false;
  const drivers = [
    mockDriver('cc-session', { available: true, deliverOk: true }),
    mockDriver('tmux-send-keys', { available: true, deliverOk: true, onDeliver: () => { secondCalled = true; } }),
  ];
  const res = await injectViaChain('s1', 'wrapped', drivers, nullTransport);
  assert.equal(res.delivered, true);
  assert.equal(res.driver, 'cc-session');
  assert.equal(secondCalled, false, 'second driver must not run once first succeeds');
});

test('injectViaChain falls back when first driver is unavailable', async () => {
  const drivers = [
    mockDriver('cc-session', { available: false, deliverOk: true }),
    mockDriver('tmux-send-keys', { available: true, deliverOk: true }),
  ];
  const res = await injectViaChain('s1', 'wrapped', drivers, nullTransport);
  assert.equal(res.delivered, true);
  assert.equal(res.driver, 'tmux-send-keys');
});

test('injectViaChain falls back when first driver is available but throws', async () => {
  const drivers = [
    mockDriver('cc-session', { available: true, deliverOk: false }),
    mockDriver('tmux-send-keys', { available: true, deliverOk: true }),
  ];
  const res = await injectViaChain('s1', 'wrapped', drivers, nullTransport);
  assert.equal(res.delivered, true);
  assert.equal(res.driver, 'tmux-send-keys');
});

test('injectViaChain reports none when no driver delivers', async () => {
  const drivers = [
    mockDriver('cc-session', { available: false, deliverOk: true }),
    mockDriver('tmux-send-keys', { available: true, deliverOk: false }),
  ];
  const res = await injectViaChain('s1', 'wrapped', drivers, nullTransport);
  assert.equal(res.delivered, false);
  assert.equal(res.driver, 'none');
  assert.match(res.detail || '', /tmux-send-keys/);
});

// ─── store + sendMessage end-to-end (mock drivers) ───────────────

test('sendMessage stores, injects, and acks received on success', async () => {
  store._clearAll();
  const drivers = [mockDriver('cc-session', { available: true, deliverOk: true })];
  const r = await sendMessage(
    { toSession: 'target1', category: 'guided', body: 'hello', fromSession: 'me' },
    { drivers, transport: nullTransport, localNode: 'thisNode' },
  );
  assert.equal(r.status, 'received');
  assert.equal(r.driver, 'cc-session');

  const stored = getStatus(r.id);
  assert.ok(stored);
  assert.equal(stored!.toSession, 'target1');
  assert.equal(stored!.category, 'guided');
  assert.equal(stored!.toNode, 'thisNode');
  assert.equal(stored!.status, 'received');
  // ack trail: pending(stored) → received
  assert.deepEqual(stored!.acks.map((a) => a.state), ['pending', 'received']);
});

test('sendMessage leaves message pending when no driver delivers, sweep retries', async () => {
  store._clearAll();
  // First attempt: nothing available.
  const noDrivers = [mockDriver('cc-session', { available: false, deliverOk: true })];
  const r = await sendMessage(
    { toSession: 'target2', category: 'overwrite', body: 'urgent' },
    { drivers: noDrivers, transport: nullTransport, localNode: 'thisNode' },
  );
  assert.equal(r.status, 'pending');
  assert.equal(getStatus(r.id)!.status, 'pending');
  assert.equal(store.listPending().length, 1);

  // Driver becomes available → sweep delivers it.
  const okDrivers = [mockDriver('tmux-send-keys', { available: true, deliverOk: true })];
  const swept = await sweepPending({ drivers: okDrivers, transport: nullTransport });
  assert.equal(swept.length, 1);
  assert.equal(swept[0].delivered, true);
  assert.equal(getStatus(r.id)!.status, 'received');
  assert.equal(store.listPending().length, 0);
});

test('sendMessage validates category and required fields', async () => {
  store._clearAll();
  await assert.rejects(
    () => sendMessage({ toSession: '', category: 'guided', body: 'x' }, { transport: nullTransport }),
    /toSession is required/,
  );
  await assert.rejects(
    () => sendMessage({ toSession: 's', category: 'bogus' as MessageCategory, body: 'x' }, { transport: nullTransport }),
    /category must be one of/,
  );
  await assert.rejects(
    () => sendMessage({ toSession: 's', category: 'reference', body: '   ' }, { transport: nullTransport }),
    /body is required/,
  );
});

test('cleanup test data dir', () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  assert.ok(true);
});
