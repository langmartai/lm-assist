import { test } from 'node:test';
import assert from 'node:assert';
import { decideCloudResume, decideNativeResume, resumeWorker } from '../mission/mission-resume';
import type { ResumeWorkerDeps } from '../mission/mission-resume';

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

// ── resumeWorker (orchestrator with injected deps) ────────────────────────────

function makeDeps(over: Partial<ResumeWorkerDeps> = {}): ResumeWorkerDeps {
  return {
    resolve: (sid) => ({ transport: sid.startsWith('session_') ? 'cloud' : 'native', missionId: null }),
    cloudStatus: async (sid) => ({ sid, status: 'active', raw: { worker_status: 'running' } }),
    cloudWake: async () => {},
    nativeVerdict: () => ({ connectStrategy: 'create-tmux', safeToCreateTmux: true, inTmux: false }),
    resumeNative: async (_mid, sid) => ({ sid, boundAt: 1000 }),
    ...over,
  };
}

test('resumeWorker: cloud running → alive (no wake)', async () => {
  let woke = false;
  const r = await resumeWorker('session_a', undefined, makeDeps({ cloudWake: async () => { woke = true; } }));
  assert.deepStrictEqual({ resumed: r.resumed, reason: r.reason, sid: r.sid }, { resumed: true, reason: 'alive', sid: 'session_a' });
  assert.strictEqual(woke, false);
});
test('resumeWorker: cloud idle → wakes via cloudWake, reason ok', async () => {
  let woke = false;
  const r = await resumeWorker('session_b', undefined, makeDeps({
    cloudStatus: async (sid) => ({ sid, status: 'active', raw: { worker_status: 'idle' } }),
    cloudWake: async () => { woke = true; },
  }));
  assert.strictEqual(r.reason, 'ok');
  assert.strictEqual(woke, true);
});
test('resumeWorker: cloud terminal → gone', async () => {
  const r = await resumeWorker('session_c', undefined, makeDeps({ cloudStatus: async (sid) => ({ sid, status: 'stopped', raw: {} }) }));
  assert.strictEqual(r.resumed, false);
  assert.strictEqual(r.reason, 'gone');
});
test('resumeWorker: cloud cloudStatus throws → status-unknown grace (resumed true)', async () => {
  const r = await resumeWorker('session_d', undefined, makeDeps({ cloudStatus: async () => { throw new Error('503'); } }));
  assert.strictEqual(r.resumed, true);
  assert.strictEqual(r.reason, 'status-unknown');
});
test('resumeWorker: native resume → same sid preserved, reason ok', async () => {
  const r = await resumeWorker('uuid-native', 'mission_x', makeDeps({ resumeNative: async (_m, sid) => ({ sid, boundAt: 2 }) }));
  assert.strictEqual(r.reason, 'ok');
  assert.strictEqual(r.sid, 'uuid-native'); // SAME sid — continuity
});
test('resumeWorker: native attach-existing → alive (no resumeNative call)', async () => {
  let called = false;
  const r = await resumeWorker('uuid-live', 'mission_x', makeDeps({
    nativeVerdict: () => ({ connectStrategy: 'attach-existing', safeToCreateTmux: false, inTmux: true }),
    resumeNative: async (_m, sid) => { called = true; return { sid, boundAt: 0 }; },
  }));
  assert.strictEqual(r.reason, 'alive');
  assert.strictEqual(called, false);
});
test('resumeWorker: native refuse → conflict (no resumeNative call)', async () => {
  const r = await resumeWorker('uuid-conflict', 'mission_x', makeDeps({
    nativeVerdict: () => ({ connectStrategy: 'refuse', safeToCreateTmux: false, inTmux: false }),
  }));
  assert.strictEqual(r.resumed, false);
  assert.strictEqual(r.reason, 'conflict');
});
test('resumeWorker: native none → gone', async () => {
  const r = await resumeWorker('uuid-gone', 'mission_x', makeDeps({
    nativeVerdict: () => ({ connectStrategy: 'none', safeToCreateTmux: false, inTmux: false }),
  }));
  assert.strictEqual(r.reason, 'gone');
});
