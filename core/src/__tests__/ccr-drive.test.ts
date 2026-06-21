import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cseFromWebUrl,
  chooseDrivePath,
  buildUserEventPayload,
} from '../terminal/ccr-manager';

test('cseFromWebUrl: derives cse_<id> from a bridge webUrl', () => {
  assert.equal(
    cseFromWebUrl('https://claude.ai/code/session_01DhmjudU3bZYx1BCL82kbUE'),
    'cse_01DhmjudU3bZYx1BCL82kbUE',
  );
});

test('cseFromWebUrl: tolerates trailing path/query', () => {
  assert.equal(
    cseFromWebUrl('https://claude.ai/code/session_ABC123?foo=bar'),
    'cse_ABC123',
  );
});

test('cseFromWebUrl: null/empty/garbage → null', () => {
  assert.equal(cseFromWebUrl(null), null);
  assert.equal(cseFromWebUrl(undefined), null);
  assert.equal(cseFromWebUrl(''), null);
  assert.equal(cseFromWebUrl('https://claude.ai/code/'), null);
  assert.equal(cseFromWebUrl('not a url'), null);
});

test('chooseDrivePath: cloud is primary when a cse exists', () => {
  assert.equal(chooseDrivePath({ cse: 'cse_x', tmux: null }), 'cloud');
  assert.equal(chooseDrivePath({ cse: 'cse_x', tmux: 'ccr-abc' }), 'cloud');
});

test('chooseDrivePath: tmux is the fallback when no cse', () => {
  assert.equal(chooseDrivePath({ cse: null, tmux: 'ccr-abc' }), 'tmux');
});

test('chooseDrivePath: preferTmux forces tmux when one exists', () => {
  assert.equal(chooseDrivePath({ cse: 'cse_x', tmux: 'ccr-abc', preferTmux: true }), 'tmux');
});

test('chooseDrivePath: preferTmux with no tmux still uses cloud', () => {
  assert.equal(chooseDrivePath({ cse: 'cse_x', tmux: null, preferTmux: true }), 'cloud');
});

test('chooseDrivePath: nothing to drive → none', () => {
  assert.equal(chooseDrivePath({ cse: null, tmux: null }), 'none');
  assert.equal(chooseDrivePath({ cse: null, tmux: null, preferTmux: true }), 'none');
});

test('buildUserEventPayload: shape matches the claude.ai client event', () => {
  const p = buildUserEventPayload('cse_x', 'echo hi', 'fixed-uuid');
  assert.deepEqual(p, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'echo hi' }] },
    uuid: 'fixed-uuid',
    session_id: 'cse_x',
  });
});

test('buildUserEventPayload: generates a uuid when none provided', () => {
  const p = buildUserEventPayload('cse_x', 'hi');
  assert.equal(typeof p.uuid, 'string');
  assert.ok(p.uuid.length >= 8);
});
