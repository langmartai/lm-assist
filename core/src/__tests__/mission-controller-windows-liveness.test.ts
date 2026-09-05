// Controller liveness must be BACKEND-NEUTRAL.
//
// Incident 2026-09-05 (107, Windows): the supervisor's real `isLive` asked tmux whether the
// recorded controller handle exists. On Windows the handle is a Windows Terminal tab RuntimeId,
// `tmux.exists()` throws (assertPosix) and the fallback `sessionVerdict(...).inTmux` is false by
// construction — so the controller could NEVER read as live. Every tick tore down the healthy
// controller and resumed it: 175 teardown+resume pairs in one day, the operator watching their
// terminal close and reopen every ~3 minutes.
import { test } from 'node:test';
import assert from 'node:assert';
import { controllerIsLive } from '../mission/mission-controller';

const tmuxUnavailable = (): boolean => { throw new Error('tmux is not available on win32'); };

test('wt backend: a session whose owner process is registered live IS live, even though no tmux exists', () => {
  const live = controllerIsLive(
    { sessionId: '9691301e-5107-4441-aaa3-7de9d10e68c8', tmux: '42.7933118.4.10118' },
    { backend: 'wt', tmuxExists: tmuxUnavailable, verdict: () => ({ live: true, inTmux: false }) },
  );
  assert.equal(live, true);
});

test('wt backend: a session with no live owner process is NOT live', () => {
  const live = controllerIsLive(
    { sessionId: '9691301e-5107-4441-aaa3-7de9d10e68c8', tmux: '42.7933118.4.10118' },
    { backend: 'wt', tmuxExists: tmuxUnavailable, verdict: () => ({ live: false, inTmux: false }) },
  );
  assert.equal(live, false);
});

test('wt backend: a record with no native session id is never live (nothing to ask)', () => {
  let asked = 0;
  const live = controllerIsLive(
    { sessionId: '', tmux: '42.7933118.4.10118' },
    { backend: 'wt', tmuxExists: tmuxUnavailable, verdict: () => { asked += 1; return { live: true, inTmux: false }; } },
  );
  assert.equal(live, false);
  assert.equal(asked, 0);
});

test('tmux backend: the recorded tmux session name decides, the verdict is not consulted', () => {
  let asked = 0;
  const probes = (exists: boolean) => ({
    backend: 'tmux' as const,
    tmuxExists: (name: string) => { assert.equal(name, 'lmcc-orig'); return exists; },
    verdict: () => { asked += 1; return { live: true, inTmux: true }; },
  });
  assert.equal(controllerIsLive({ sessionId: 'uuid-1', tmux: 'lmcc-orig' }, probes(true)), true);
  assert.equal(controllerIsLive({ sessionId: 'uuid-1', tmux: 'lmcc-orig' }, probes(false)), false);
  assert.equal(asked, 0);
});

test('tmux backend: a throwing tmux probe (or no handle) falls back to the verdict inTmux', () => {
  const thrower = { backend: 'tmux' as const, tmuxExists: tmuxUnavailable, verdict: () => ({ live: true, inTmux: true }) };
  assert.equal(controllerIsLive({ sessionId: 'uuid-1', tmux: 'lmcc-orig' }, thrower), true);
  const noHandle = { backend: 'tmux' as const, tmuxExists: () => true, verdict: () => ({ live: true, inTmux: false }) };
  assert.equal(controllerIsLive({ sessionId: 'uuid-1', tmux: '' }, noHandle), false);
});
