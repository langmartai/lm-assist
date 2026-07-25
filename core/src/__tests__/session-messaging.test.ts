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
    // The refusal ECHOES what was sent — without it a caller retries the same
    // rejected value forever (the backlog "priority: medium" lesson).
    () => sendMessage({ toSession: 's', category: 'bogus' as MessageCategory, body: 'x' }, { transport: nullTransport }),
    /category "bogus" is not valid — must be one of/,
  );
  await assert.rejects(
    () => sendMessage({ toSession: 's', category: 'reference', body: '   ' }, { transport: nullTransport }),
    /body is required/,
  );
});

// ─── idempotency + typed delivery outcomes ───────────────────────
//
// Regression cover for the send_session_message intermittent-delivery bug
// (2026-07-26). Claude Code QUEUES input typed while it is busy; the submit
// verifier could not see that, so a DELIVERED message was reported failed. The
// caller then retried, a fresh id was minted, and the body was typed in a
// SECOND time — a duplicate delivery caused purely by an untyped, unretryable
// failure. These tests pin the three properties that make that impossible.

/** A driver that reports available and fails the way an unconfirmed submit
 *  does: the body IS typed into the composer, only the submit is unproven. */
function ambiguousDriver(name: InjectionDriver['name'], onDeliver?: () => void): InjectionDriver {
  return {
    name,
    async available() { return true; },
    async deliver() {
      onDeliver?.();
      const e = new Error(
        'typed prompt did not submit after 3 Enter attempts (text still in the composer of lmcc-x)',
      ) as Error & { code?: string };
      e.code = 'SUBMIT_UNVERIFIED';
      throw e;
    },
  };
}

test('failedAmbiguously separates "may have landed" from a definite failure', async () => {
  const { failedAmbiguously } = await import('../session-messaging/inject');
  const unverified = Object.assign(new Error('nope'), { code: 'SUBMIT_UNVERIFIED' });
  assert.equal(failedAmbiguously(unverified), true);
  // Recognised by message too — the code is lost across some relay hops.
  assert.equal(failedAmbiguously(new Error('typed prompt did not submit after 3 Enter attempts')), true);
  assert.equal(failedAmbiguously(new Error('no such session')), false);
  assert.equal(failedAmbiguously(new Error('ECONNREFUSED')), false);
});

test('THE REGRESSION: same messageId twice = exactly ONE delivery', async () => {
  store._clearAll();
  let delivered = 0;
  const drivers = [mockDriver('cc-session', { available: true, deliverOk: true, onDeliver: () => { delivered++; } })];
  const args = {
    toSession: 'target-idem', category: 'guided' as MessageCategory,
    body: 'strategy note', messageId: 'note-2026-07-26-a',
  };
  const first = await sendMessage(args, { drivers, transport: nullTransport, localNode: 'n1' });
  const second = await sendMessage(args, { drivers, transport: nullTransport, localNode: 'n1' });

  assert.equal(delivered, 1, 'the body must be injected exactly once');
  assert.equal(first.id, second.id, 'both resolve to the same message');
  assert.equal(first.id, 'note-2026-07-26-a', 'the client-supplied id IS the messageId');
  assert.equal(second.idempotent, true);
  assert.equal(store.list({ session: 'target-idem' }).length, 1, 'only one stored message');
});

test('concurrent retries of the same messageId: one delivery, and no stale "pending" report', async () => {
  store._clearAll();
  let delivered = 0;
  // A SLOW driver — the realistic case. Injection takes real time, so a
  // concurrent retry lands while the first send is still in flight.
  const slow: InjectionDriver = {
    name: 'cc-session',
    async available() { return true; },
    async deliver() { delivered++; await new Promise((r) => setTimeout(r, 40)); },
  };
  const args = {
    toSession: 'target-race', category: 'reference' as MessageCategory,
    body: 'racy', messageId: 'race-key-1',
  };
  const results = await Promise.all([1, 2, 3].map(() =>
    sendMessage(args, { drivers: [slow], transport: nullTransport, localNode: 'n1' })));

  assert.equal(delivered, 1, 'concurrent same-key sends must not stack deliveries');
  assert.equal(store.list({ session: 'target-race' }).length, 1);
  // The load-bearing part: the twins must report the SETTLED outcome. Without
  // the send lock they return the transient 'pending' written at insert time —
  // telling a retrying caller "not delivered" about a message being delivered.
  assert.deepEqual(results.map((r) => r.status), ['received', 'received', 'received']);
  assert.deepEqual(results.map((r) => !!r.idempotent), [false, true, true]);
});

test('unconfirmed submit is DELIVERY_UNVERIFIED — and retrying it cannot double-deliver', async () => {
  store._clearAll();
  let typed = 0;
  const drivers = [ambiguousDriver('cc-session', () => { typed++; })];
  const args = {
    toSession: 'target-amb', category: 'guided' as MessageCategory,
    body: 'the note that blocked delivery', messageId: 'amb-key-1',
  };
  const r = await sendMessage(args, { drivers, transport: nullTransport, localNode: 'n1' });

  // It must NOT claim success, and must NOT claim clean failure either.
  assert.equal(r.status, 'unverified');
  assert.equal(r.code, 'DELIVERY_UNVERIFIED');
  assert.equal(r.ambiguous, true);
  assert.equal(typed, 1);

  // The caller retries with the SAME id (what the error tells it to do).
  const retry = await sendMessage(args, { drivers, transport: nullTransport, localNode: 'n1' });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.id, r.id);
  assert.equal(typed, 1, 'a retry after an unverified ack must NOT type the body again');
});

test('an unverified message is never swept — the sweeper cannot duplicate it', async () => {
  store._clearAll();
  await sendMessage(
    { toSession: 'target-nosweep', category: 'guided', body: 'x', messageId: 'nosweep-1' },
    { drivers: [ambiguousDriver('cc-session')], transport: nullTransport, localNode: 'n1' },
  );
  assert.equal(getStatus('nosweep-1')!.status, 'unverified');
  assert.equal(store.listPending().length, 0, 'unverified is not pending, so sweep skips it');

  let sweptDeliveries = 0;
  const okDrivers = [mockDriver('tmux-send-keys', {
    available: true, deliverOk: true, onDeliver: () => { sweptDeliveries++; },
  })];
  const swept = await sweepPending({ drivers: okDrivers, transport: nullTransport });
  assert.equal(swept.length, 0);
  assert.equal(sweptDeliveries, 0, 'a may-have-landed message must never be auto-redelivered');
});

test('unreachable target is TARGET_UNREACHABLE — typed, and safe to retry', async () => {
  store._clearAll();
  const r = await sendMessage(
    { toSession: 'target-gone', category: 'guided', body: 'x' },
    { drivers: [mockDriver('cc-session', { available: false, deliverOk: true })], transport: nullTransport, localNode: 'n1' },
  );
  assert.equal(r.status, 'pending');
  assert.equal(r.code, 'TARGET_UNREACHABLE');
  assert.notEqual(r.ambiguous, true);
  // Nothing was typed in, so it stays sweepable.
  assert.equal(store.listPending().length, 1);
});

test('failures carry a typed code, not a bare string', async () => {
  store._clearAll();
  const { SendMessageError, validateMessageId } = await import('../session-messaging');
  await assert.rejects(
    () => sendMessage(
      { toSession: 's', category: 'guided', body: 'x', messageId: 'bad id!' },
      { transport: nullTransport },
    ),
    (e: unknown) => {
      assert.ok(e instanceof SendMessageError, 'must be a typed error, not a bare Error');
      assert.equal((e as InstanceType<typeof SendMessageError>).code, 'INVALID_INPUT');
      assert.match((e as Error).message, /bad id!/, 'the rejected value must be echoed back');
      return true;
    },
  );
  assert.equal(validateMessageId('ok.key:1-2_3').ok, true);
  assert.equal(validateMessageId('x'.repeat(129)).ok, false);
  assert.equal(validateMessageId(undefined).ok, false);
});

test('injectViaChain reports WHERE it failed, per driver', async () => {
  const res = await injectViaChain('s1', 'wrapped', [
    mockDriver('remote-control', { available: false, deliverOk: true }),
    ambiguousDriver('cc-session'),
  ], nullTransport);
  assert.equal(res.delivered, false);
  assert.equal(res.ambiguous, true, 'a driver typed the body in — the outcome is ambiguous');
  assert.deepEqual(res.attempts?.map((a) => [a.driver, a.outcome]), [
    ['remote-control', 'unavailable'],
    ['cc-session', 'unverified'],
  ]);
  assert.equal(res.attempts?.[1].code, 'SUBMIT_UNVERIFIED');
});

test('cleanup test data dir', () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  assert.ok(true);
});
