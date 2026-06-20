import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchTestConversations, withAutoDeleteMarker, parseAutoDeleteMs, stripAutoDeleteMarker } from '../utils/claudeai-session';

// Pure core of the test-conversation sweeper. Selection only — deletion happens in the lib wrapper,
// which is SAFE BY DEFAULT (dryRun). These guard that it sweeps the right things and never blindly.
const NOW = Date.parse('2026-06-21T12:00:00Z');
const CONVS = [
  { uuid: 'a', name: 'lm-assist-approval-probe', updated_at: '2026-06-21T00:00:00Z' }, // 12h ago
  { uuid: 'b', name: 'My real project', updated_at: '2026-06-21T11:00:00Z' },
  { uuid: 'c', name: 'hash-probe', updated_at: '2026-06-20T00:00:00Z' },
  { uuid: 'd', name: 'lm-assist-approval-probe', updated_at: '2026-06-21T11:59:00Z' }, // 1 min ago
];

test('matches the default probe name; leaves unrelated conversations alone', () => {
  const m = matchTestConversations(CONVS, { patterns: [/^lm-assist-approval-probe$/i], nowMs: NOW });
  assert.deepEqual(m.map((x) => x.uuid).sort(), ['a', 'd']);
});

test('ids match unconditionally (regardless of name or age)', () => {
  const m = matchTestConversations(CONVS, { ids: ['b'], patterns: [], nowMs: NOW });
  assert.deepEqual(m.map((x) => x.uuid), ['b']);
});

test('age guard keeps too-recent conversations', () => {
  const m = matchTestConversations(CONVS, { patterns: [/^lm-assist-approval-probe$/i], olderThanMs: 3600_000, nowMs: NOW });
  assert.deepEqual(m.map((x) => x.uuid), ['a']); // 'd' (1 min ago) excluded; 'a' (12h) kept
});

test('extra patterns sweep ad-hoc test names too', () => {
  const m = matchTestConversations(CONVS, { patterns: [/^hash-probe$/i], nowMs: NOW });
  assert.deepEqual(m.map((x) => x.uuid), ['c']);
});

test('no patterns + no ids → matches NOTHING (never sweeps blindly)', () => {
  assert.deepEqual(matchTestConversations(CONVS, { patterns: [], nowMs: NOW }), []);
});

test('skips entries without a uuid', () => {
  const m = matchTestConversations([{ name: 'lm-assist-approval-probe' }], { patterns: [/^lm-assist-approval-probe$/i], nowMs: NOW });
  assert.deepEqual(m, []);
});

// ── create-time auto-delete TTL (the `autoDeleteHours` create param) ────────
test('withAutoDeleteMarker appends a parseable TTL marker; parseAutoDeleteMs round-trips it', () => {
  const N = 1_750_000_000_000;
  const named = withAutoDeleteMarker('my chat', 24, N);
  assert.match(named, /^my chat \[lm-autodel:\d+\]$/);
  assert.equal(parseAutoDeleteMs(named), N + 24 * 3600_000);
  assert.equal(withAutoDeleteMarker('x', 0, N), 'x');          // hours<=0 → unchanged
  assert.equal(withAutoDeleteMarker('x', undefined, N), 'x');
  assert.match(withAutoDeleteMarker('', 1, N), /^\[lm-autodel:\d+\]$/); // empty name → just the marker
  assert.equal(parseAutoDeleteMs('no marker here'), null);
});

test('matchTestConversations sweeps EXPIRED auto-delete markers (even with no patterns), keeps unexpired', () => {
  const convs = [
    { uuid: 'x', name: 'probe [lm-autodel:' + (NOW - 1000) + ']' },        // expired 1s ago
    { uuid: 'y', name: 'keep [lm-autodel:' + (NOW + 3600_000) + ']' },     // 1h left
    { uuid: 'z', name: 'unrelated' },
  ];
  assert.deepEqual(matchTestConversations(convs, { patterns: [], nowMs: NOW }).map((c) => c.uuid), ['x']);
});

test('empty / zero / invalid / absent TTL is NEVER swept (the safety rule)', () => {
  // parse rejects them → null
  assert.equal(parseAutoDeleteMs('x [lm-autodel:]'), null);            // empty
  assert.equal(parseAutoDeleteMs('x [lm-autodel:0]'), null);          // too short
  assert.equal(parseAutoDeleteMs('x [lm-autodel:0000000000]'), null); // 10 zeros = 0 < floor
  assert.equal(parseAutoDeleteMs('x [lm-autodel:123]'), null);        // implausibly small
  assert.equal(parseAutoDeleteMs('no marker'), null);
  assert.equal(parseAutoDeleteMs('x [lm-autodel:' + NOW + ']'), NOW); // a real timestamp parses
  // and the sweep (no patterns) matches NONE of them
  const convs = [
    { uuid: 'zero', name: 'p [lm-autodel:0000000000]' },
    { uuid: 'empty', name: 'p [lm-autodel:]' },
    { uuid: 'none', name: 'real conversation' },
  ];
  assert.deepEqual(matchTestConversations(convs, { patterns: [], nowMs: NOW }), []);
});

test('stripAutoDeleteMarker removes the marker (valid or malformed), keeping a clean name', () => {
  assert.equal(stripAutoDeleteMarker('my chat [lm-autodel:' + NOW + ']'), 'my chat');
  assert.equal(stripAutoDeleteMarker('my chat [lm-autodel:]'), 'my chat');
  assert.equal(stripAutoDeleteMarker('[lm-autodel:' + NOW + ']'), '');
  assert.equal(stripAutoDeleteMarker('plain'), 'plain');
});
