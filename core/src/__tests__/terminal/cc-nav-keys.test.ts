import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CC_NAV_KEYS, assertNavKeys } from '../../terminal/backend';

/**
 * Cross-platform navigation-key vocabulary for the cc-sessions prompt `keys`
 * array (windows_terminal_send / the sessionId-keyed prompt route).
 *
 * The invariant that matters: every entry must be honored on BOTH backends.
 * On Windows an UNKNOWN console-input token is silently typed as literal text
 * (measured: "S-Enter" became the string), so a key that only tmux understands
 * would look fine on Linux and corrupt input on Windows. This suite pins the
 * vocabulary so nothing half-supported can be added without the test noticing.
 */

test('every nav key maps to both a tmux name and a wt token', () => {
  for (const [name, m] of Object.entries(CC_NAV_KEYS)) {
    assert.equal(typeof m.tmux, 'string', `${name} has a tmux name`);
    assert.equal(typeof m.wt, 'string', `${name} has a wt token`);
    assert.ok(m.tmux.length > 0 && m.wt.length > 0);
  }
});

test('the vocabulary is exactly the both-platform navigation set', () => {
  assert.deepEqual(
    Object.keys(CC_NAV_KEYS).sort(),
    ['Down', 'Enter', 'Escape', 'Left', 'Right', 'Space', 'Tab', 'Up'],
  );
});

test('wt tokens are the SendConsoleKeys vocabulary (all-caps, no F-keys/PageUp)', () => {
  const allowed = new Set(['ENTER', 'ESC', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'TAB', 'SPACE']);
  for (const m of Object.values(CC_NAV_KEYS)) {
    assert.ok(allowed.has(m.wt), `${m.wt} is a real SendConsoleKeys token`);
  }
});

test('Ctrl-C is NOT in the vocabulary (interrupt has its own endpoint)', () => {
  assert.ok(!('C-c' in CC_NAV_KEYS) && !('CTRL_C' in CC_NAV_KEYS));
});

test('assertNavKeys accepts a valid array and returns it', () => {
  assert.deepEqual(assertNavKeys(['Escape']), ['Escape']);
  assert.deepEqual(assertNavKeys(['Down', 'Down', 'Enter']), ['Down', 'Down', 'Enter']);
});

test('assertNavKeys rejects unknown keys, Ctrl-C, non-arrays, empty, and oversized', () => {
  for (const bad of [
    ['NotAKey'],
    ['C-c'],
    ['PageUp'],   // real tmux key, but no wt token — must be refused here
    ['F5'],
    'Escape',     // not an array
    [],
    [42],
    Array.from({ length: 33 }, () => 'Enter'),
  ]) {
    assert.throws(() => assertNavKeys(bad), /key|array/i, `${JSON.stringify(bad)} must be rejected`);
  }
});
