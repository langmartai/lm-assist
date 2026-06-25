import { test } from 'node:test';
import assert from 'node:assert';
import { decideCloudResume, decideNativeResume } from '../mission/mission-resume';

// ── decideCloudResume ─────────────────────────────────────────────────────────
test('decideCloudResume: terminal status → gone', () => {
  for (const status of ['stopped', 'completed', 'failed', 'error', 'archived']) {
    assert.strictEqual(decideCloudResume({ status }), 'gone', status);
  }
});
test('decideCloudResume: alive + worker_status running → noop', () => {
  assert.strictEqual(decideCloudResume({ status: 'active', workerStatus: 'running' }), 'noop');
});
test('decideCloudResume: alive but idle/disconnected (not running) → wake', () => {
  assert.strictEqual(decideCloudResume({ status: 'active', workerStatus: 'idle' }), 'wake');
  assert.strictEqual(decideCloudResume({ status: 'active' }), 'wake');
});

// ── decideNativeResume ────────────────────────────────────────────────────────
test('decideNativeResume: attach-existing (alive in tmux) → attach', () => {
  assert.strictEqual(decideNativeResume({ connectStrategy: 'attach-existing', safeToCreateTmux: false, inTmux: true }), 'attach');
});
test('decideNativeResume: create-tmux + safeToCreateTmux (dead, jsonl present) → resume', () => {
  assert.strictEqual(decideNativeResume({ connectStrategy: 'create-tmux', safeToCreateTmux: true, inTmux: false }), 'resume');
});
test('decideNativeResume: refuse (live but not in tmux) → conflict', () => {
  assert.strictEqual(decideNativeResume({ connectStrategy: 'refuse', safeToCreateTmux: false, inTmux: false }), 'conflict');
});
test('decideNativeResume: none (no jsonl) → gone', () => {
  assert.strictEqual(decideNativeResume({ connectStrategy: 'none', safeToCreateTmux: false, inTmux: false }), 'gone');
});
