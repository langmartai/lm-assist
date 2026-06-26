import { test } from 'node:test';
import assert from 'node:assert';
import { resumeWorker, type ResumeWorkerDeps } from '../mission/mission-resume';

function nativeDeps(over: Partial<ResumeWorkerDeps>): ResumeWorkerDeps {
  return {
    resolve: () => ({ transport: 'native', missionId: 'm1' }),
    cloudStatus: async () => ({ sid: 's', status: 'active', raw: {} }),
    cloudWake: async () => {},
    nativeVerdict: () => ({ connectStrategy: 'attach-existing', safeToCreateTmux: false, inTmux: true }),
    resumeNative: async (_m, sid) => ({ sid, boundAt: 1 }),
    ...over,
  };
}

test('live native (attach-existing) routes through ensureLive → ok', async () => {
  let forced: boolean | undefined;
  const r = await resumeWorker('s', 'm1', nativeDeps({
    ensureLive: async (_sid, o) => { forced = o.force; return { ok: true, state: 'connected', sid: 's', reason: 'x' }; },
  }), { force: true });
  assert.strictEqual(r.resumed, true);
  assert.strictEqual(r.reason, 'ok');
  assert.strictEqual(forced, true);
});

test('live native needs-force maps to reason needs-force (not resumed)', async () => {
  const r = await resumeWorker('s', 'm1', nativeDeps({
    nativeVerdict: () => ({ connectStrategy: 'refuse', safeToCreateTmux: false, inTmux: false }),
    ensureLive: async () => ({ ok: false, state: 'needs-force', sid: 's', reason: 'busy' }),
  }));
  assert.strictEqual(r.resumed, false);
  assert.strictEqual(r.reason, 'needs-force');
});

test('dead native (create-tmux) still uses resumeNative, not ensureLive', async () => {
  let usedEnsure = false;
  const r = await resumeWorker('s', 'm1', nativeDeps({
    nativeVerdict: () => ({ connectStrategy: 'create-tmux', safeToCreateTmux: true, inTmux: false }),
    ensureLive: async () => { usedEnsure = true; return { ok: true, state: 'connected', sid: 's', reason: '' }; },
    resumeNative: async (_m, sid) => ({ sid, boundAt: 2 }),
  }));
  assert.strictEqual(usedEnsure, false);
  assert.strictEqual(r.reason, 'ok');
});

test('kill-failed maps to conflict (cannot resume)', async () => {
  const r = await resumeWorker('s', 'm1', nativeDeps({
    ensureLive: async () => ({ ok: false, state: 'kill-failed', sid: 's', reason: 'stuck' }),
  }));
  assert.strictEqual(r.resumed, false);
  assert.strictEqual(r.reason, 'kill-failed');
});
