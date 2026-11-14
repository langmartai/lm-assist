/**
 * The hub relay re-issues requests from loopback, so a client-supplied relay marker or
 * proxy-hop header must never survive into Core: the relay markers would forge trust,
 * and forwarding headers would make relay-accepting loopback guards refuse the relay.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeRelayHeaders } from '../hub-client/api-relay-handler';

test('strips every relay-trust and proxy-hop header, case-insensitively', () => {
  const out = sanitizeRelayHeaders({
    'X-Relay-Source': 'hub',
    'x-lm-user-id': 'u1',
    'X-Forwarded-For': '1.2.3.4',
    'x-forwarded-host': '',
    'X-Forwarded-Proto': 'https',
    'x-forwarded-port': '443',
    Forwarded: 'for=1.2.3.4',
    'X-Real-IP': '1.2.3.4',
    'Content-Type': 'application/json',
    accept: 'text/html',
    'x-api-key': 'client-sent',
  });
  assert.deepEqual(out, { 'Content-Type': 'application/json', accept: 'text/html', 'x-api-key': 'client-sent' });
});

test('keeps the rest untouched and tolerates missing input', () => {
  assert.deepEqual(sanitizeRelayHeaders(undefined), {});
  assert.deepEqual(sanitizeRelayHeaders(null), {});
  const h = { cookie: 'a=b', 'x-custom': ['1', '2'] };
  assert.deepEqual(sanitizeRelayHeaders(h), h);
  assert.notEqual(sanitizeRelayHeaders(h), h, 'returns a copy');
});
