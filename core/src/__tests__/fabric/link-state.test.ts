import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { reduceLink, backoffMs, type LinkCore } from '../../fabric/link-state';

const at = (state: LinkCore['state'], attempts = 0): LinkCore =>
  ({ state, since: 1000, attempts, lastError: null });

test('happy path: discovered → connecting → connected', () => {
  let c = at('discovered');
  c = reduceLink(c, { type: 'open-requested' }, 2000);
  assert.equal(c.state, 'connecting');
  c = reduceLink(c, { type: 'hello-ok' }, 3000);
  assert.equal(c.state, 'connected');
  assert.equal(c.attempts, 0); // reset on success
  assert.equal(c.since, 3000);
});

test('hello-timeout marks legacy; open-failed marks failed with attempts++', () => {
  assert.equal(reduceLink(at('connecting'), { type: 'hello-timeout' }, 2000).state, 'legacy');
  const f = reduceLink(at('connecting', 1), { type: 'open-failed', error: 'boom' }, 2000);
  assert.equal(f.state, 'failed');
  assert.equal(f.attempts, 2);
  assert.equal(f.lastError, 'boom');
});

test('connected channel-closed → failed; retry-due from failed → connecting; peer-offline → idle', () => {
  assert.equal(reduceLink(at('connected'), { type: 'channel-closed', error: 'ws down' }, 2000).state, 'failed');
  assert.equal(reduceLink(at('failed', 2), { type: 'retry-due' }, 2000).state, 'connecting');
  assert.equal(reduceLink(at('connected'), { type: 'peer-offline' }, 2000).state, 'idle');
});

test('backoff doubles from 30s and caps at 600s', () => {
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(2), 60_000);
  assert.equal(backoffMs(6), 600_000);
  assert.equal(backoffMs(10), 600_000);
});
