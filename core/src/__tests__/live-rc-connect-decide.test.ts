import { test } from 'node:test';
import assert from 'node:assert';
import {
  classifyReachability, idleMs, killEligibility, decideLiveAction,
} from '../terminal/live-rc-connect';

// ── classifyReachability ──────────────────────────────────────────────────────
test('classifyReachability: not live → none', () => {
  assert.strictEqual(classifyReachability({ live: false, inTmux: true }, { isWindows: false }), 'none');
});
test('classifyReachability: linux + inTmux → tmux', () => {
  assert.strictEqual(classifyReachability({ live: true, inTmux: true }, { isWindows: false }), 'tmux');
});
test('classifyReachability: linux + not tmux → none', () => {
  assert.strictEqual(classifyReachability({ live: true, inTmux: false }, { isWindows: false }), 'none');
});
test('classifyReachability: windows driveable → windows', () => {
  assert.strictEqual(classifyReachability({ live: true, inTmux: false }, { isWindows: true, windowsDriveable: true }), 'windows');
});
test('classifyReachability: windows NOT driveable → none', () => {
  assert.strictEqual(classifyReachability({ live: true, inTmux: false }, { isWindows: true, windowsDriveable: false }), 'none');
});

// ── idleMs ────────────────────────────────────────────────────────────────────
test('idleMs: missing/invalid → 0 (treat as just-active)', () => {
  assert.strictEqual(idleMs(undefined, 1_000_000), 0);
  assert.strictEqual(idleMs('not-a-date', 1_000_000), 0);
});
test('idleMs: computes now - updatedAt, floored at 0', () => {
  const updated = '2026-06-26T00:00:00.000Z';
  const now = Date.parse(updated) + 60_000;
  assert.strictEqual(idleMs(updated, now), 60_000);
  assert.strictEqual(idleMs(updated, Date.parse(updated) - 5_000), 0);
});

// ── killEligibility ───────────────────────────────────────────────────────────
test('killEligibility: force always → kill', () => {
  assert.strictEqual(killEligibility({ idleMs: 0, idleThresholdMs: 1000, force: true }), 'kill');
});
test('killEligibility: idle >= threshold → kill', () => {
  assert.strictEqual(killEligibility({ idleMs: 1000, idleThresholdMs: 1000, force: false }), 'kill');
});
test('killEligibility: idle < threshold, no force → needs-force', () => {
  assert.strictEqual(killEligibility({ idleMs: 999, idleThresholdMs: 1000, force: false }), 'needs-force');
});

// ── decideLiveAction ──────────────────────────────────────────────────────────
const base = { live: true, alreadyConnected: false, reachable: 'none' as const, idleMs: 0, idleThresholdMs: 1000, force: false };
test('decideLiveAction: not live → resume-dead', () => {
  assert.strictEqual(decideLiveAction({ ...base, live: false }), 'resume-dead');
});
test('decideLiveAction: alreadyConnected → already-connected (never inject)', () => {
  assert.strictEqual(decideLiveAction({ ...base, alreadyConnected: true, reachable: 'tmux' }), 'already-connected');
});
test('decideLiveAction: reachable tmux → inject-tmux', () => {
  assert.strictEqual(decideLiveAction({ ...base, reachable: 'tmux' }), 'inject-tmux');
});
test('decideLiveAction: reachable windows → inject-windows', () => {
  assert.strictEqual(decideLiveAction({ ...base, reachable: 'windows' }), 'inject-windows');
});
test('decideLiveAction: unreachable + idle → kill', () => {
  assert.strictEqual(decideLiveAction({ ...base, reachable: 'none', idleMs: 2000 }), 'kill');
});
test('decideLiveAction: unreachable + busy, no force → needs-force', () => {
  assert.strictEqual(decideLiveAction({ ...base, reachable: 'none', idleMs: 0 }), 'needs-force');
});
test('decideLiveAction: unreachable + busy + force → kill', () => {
  assert.strictEqual(decideLiveAction({ ...base, reachable: 'none', idleMs: 0, force: true }), 'kill');
});
