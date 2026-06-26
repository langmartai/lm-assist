import { test } from 'node:test';
import assert from 'node:assert';
import { ensureRemoteControlled, type EnsureDeps, type CloudSession } from '../terminal/live-rc-connect';

const LIVE_TMUX = { live: true, inTmux: true, connectStrategy: 'attach-existing', tmuxTarget: 'sess:0.0', pid: 100, updatedAt: undefined };
const LIVE_HEADLESS = { live: true, inTmux: false, connectStrategy: 'refuse', tmuxTarget: null, pid: 100, updatedAt: undefined };
const DEAD = { live: false, inTmux: false, connectStrategy: 'create-tmux', tmuxTarget: null, pid: null, updatedAt: undefined };

function deps(over: Partial<EnsureDeps> & { verdict: EnsureDeps['verdict'] }): EnsureDeps {
  return {
    now: () => 1_000_000,
    isWindows: false,
    windowsDriveable: async () => false,
    isConnected: async () => false,
    listCloud: async () => [],
    inject: async () => ({ ok: true }),
    clearInput: async () => {},
    pollConnection: async () => ({ connected: false }),
    killOwner: async () => ({ killed: true }),
    resumeDead: async () => ({ ok: true, cse: 'cse_dead' }),
    verifyDriveable: async () => true,
    bindCse: async () => {},
    ...over,
  };
}

test('gone: no transcript / no process', async () => {
  const r = await ensureRemoteControlled('s', {}, deps({ verdict: () => ({ ...DEAD, connectStrategy: 'none' }) }));
  assert.strictEqual(r.state, 'gone');
  assert.strictEqual(r.ok, false);
});

test('dead → resume-dead + connected', async () => {
  const r = await ensureRemoteControlled('s', {}, deps({ verdict: () => DEAD }));
  assert.strictEqual(r.state, 'connected');
  assert.strictEqual(r.via, 'resume-dead');
  assert.strictEqual(r.cse, 'cse_dead');
});

test('already-connected (verified driveable) → no inject', async () => {
  let injected = false;
  const r = await ensureRemoteControlled('s', {}, deps({
    verdict: () => LIVE_TMUX, isConnected: async () => true,
    inject: async () => { injected = true; return { ok: true }; },
  }));
  assert.strictEqual(r.state, 'already-connected');
  assert.strictEqual(injected, false);
});

test('inject tmux success on attempt 1', async () => {
  let n = 0;
  const r = await ensureRemoteControlled('s', { title: 'M' }, deps({
    verdict: () => LIVE_TMUX,
    inject: async () => { n++; return { ok: true }; },
    pollConnection: async () => ({ connected: true, sid: 'cse_new' }),
  }));
  assert.strictEqual(r.state, 'connected');
  assert.strictEqual(r.via, 'inject');
  assert.strictEqual(r.cse, 'cse_new');
  assert.strictEqual(r.attempts, 1);
  assert.strictEqual(n, 1);
});

test('stale-RC toggle: attempt 1 no connection, attempt 2 connects', async () => {
  let n = 0;
  const r = await ensureRemoteControlled('s', {}, deps({
    verdict: () => LIVE_TMUX,
    inject: async () => { n++; return { ok: true }; },
    pollConnection: async () => ({ connected: n >= 2, sid: n >= 2 ? 'cse_2' : undefined }),
  }));
  assert.strictEqual(r.state, 'connected');
  assert.strictEqual(r.attempts, 2);
  assert.strictEqual(n, 2);
});

test('inject fails twice + idle → kill-resume', async () => {
  const idleVerdict = { ...LIVE_TMUX, updatedAt: '2026-06-26T00:00:00.000Z' };
  const now = Date.parse(idleVerdict.updatedAt) + 60 * 60 * 1000; // 60 min idle
  let killed = false;
  const r = await ensureRemoteControlled('s', { idleThresholdMs: 30 * 60 * 1000 }, deps({
    now: () => now,
    verdict: () => (killed ? { ...idleVerdict, live: false } : idleVerdict),
    pollConnection: async () => ({ connected: false }),
    killOwner: async () => { killed = true; return { killed: true }; },
  }));
  assert.strictEqual(killed, true);
  assert.strictEqual(r.state, 'connected');
  assert.strictEqual(r.via, 'kill-resume');
});

test('inject fails + busy + no force → needs-force, clears input, no kill', async () => {
  let killed = false; let cleared = false;
  const r = await ensureRemoteControlled('s', {}, deps({
    verdict: () => LIVE_TMUX, // updatedAt undefined → idle 0 = busy
    pollConnection: async () => ({ connected: false }),
    clearInput: async () => { cleared = true; },
    killOwner: async () => { killed = true; return { killed: true }; },
  }));
  assert.strictEqual(r.state, 'needs-force');
  assert.strictEqual(killed, false);
  assert.strictEqual(cleared, true);
});

test('unreachable (headless) + busy + no force → needs-force, no inject', async () => {
  let injected = false;
  const r = await ensureRemoteControlled('s', {}, deps({
    verdict: () => LIVE_HEADLESS,
    inject: async () => { injected = true; return { ok: true }; },
  }));
  assert.strictEqual(r.state, 'needs-force');
  assert.strictEqual(injected, false);
});

test('unreachable + force → kill-resume', async () => {
  let killed = false;
  const r = await ensureRemoteControlled('s', { force: true }, deps({
    verdict: () => (killed ? { ...LIVE_HEADLESS, live: false } : LIVE_HEADLESS),
    killOwner: async () => { killed = true; return { killed: true }; },
  }));
  assert.strictEqual(r.state, 'connected');
  assert.strictEqual(r.via, 'kill-resume');
});

test('kill fails → kill-failed, NEVER resumes', async () => {
  let resumed = false;
  const r = await ensureRemoteControlled('s', { force: true }, deps({
    verdict: () => LIVE_HEADLESS,
    killOwner: async () => ({ killed: false }),
    resumeDead: async () => { resumed = true; return { ok: true }; },
  }));
  assert.strictEqual(r.state, 'kill-failed');
  assert.strictEqual(resumed, false);
});

test('resume after kill but not driveable → error', async () => {
  let killed = false;
  const r = await ensureRemoteControlled('s', { force: true }, deps({
    verdict: () => (killed ? { ...LIVE_HEADLESS, live: false } : LIVE_HEADLESS),
    killOwner: async () => { killed = true; return { killed: true }; },
    verifyDriveable: async () => false,
  }));
  assert.strictEqual(r.state, 'error');
});

test('killOwner reports killed but verdict still live → kill-failed, never resumes', async () => {
  let resumed = false;
  const r = await ensureRemoteControlled('s', { force: true }, deps({
    verdict: () => LIVE_HEADLESS,            // stays live even after the "kill"
    killOwner: async () => ({ killed: true }),
    resumeDead: async () => { resumed = true; return { ok: true }; },
  }));
  assert.strictEqual(r.state, 'kill-failed');
  assert.strictEqual(resumed, false);
});

test('verdict throws → error (no throw out)', async () => {
  const r = await ensureRemoteControlled('s', {}, deps({ verdict: () => { throw new Error('boom'); } }));
  assert.strictEqual(r.state, 'error');
  assert.strictEqual(r.ok, false);
});
