/**
 * A mission worker could not start on a Windows node (bl_ee6b080c).
 *
 * Measured on stage 2026-07-28: the leader relayed a spawn to 107 (Windows); 107 ran
 * `handleMissionSpawn` and refused with `CC control requires a POSIX host`
 * (`terminal/cc.ts:24`).
 *
 * 🔴 The cause was NOT a missing implementation. `wtCcController` (`terminal/wt-backend.ts`)
 * is a complete CcController over Windows Terminal, and `getCcController()` is the selector
 * built so callers never write `if (IS_WINDOWS)`. The MISSION layer is the only subsystem
 * that never adopted it — `mission-controller.ts` and `mission.routes.ts` asked for
 * `tmuxCcController` BY NAME, so `assertPosix()` threw before Windows Terminal was consulted.
 *
 * The two backends also describe a launched terminal differently — tmux by session NAME,
 * Windows Terminal by tab RuntimeId (or pid) — so the mission layer needs one neutral handle
 * rather than a field called `tmuxSession` that only one platform can fill.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeLaunchResult } from '../terminal/backend';
import { startNativeExecutor } from '../mission/mission-controller';
import type { Mission } from '../mission/mission-model';

// ── the neutral handle ─────────────────────────────────────────────────────

test('a tmux launch is identified by its session name', () => {
  const r = normalizeLaunchResult({ sessionId: 'uuid-1', tmuxSession: 'lmx-abc123' });
  assert.deepStrictEqual(r, { sessionId: 'uuid-1', terminal: 'lmx-abc123' });
});

test('a Windows Terminal launch is identified by its tab RuntimeId', () => {
  const r = normalizeLaunchResult({ launched: true, sessionId: 'uuid-2', pid: 4242, tabRid: 'rid-77', mode: 'tab' });
  assert.deepStrictEqual(r, { sessionId: 'uuid-2', terminal: 'rid-77' },
    'the RuntimeId is title-independent — the pid is only the fallback');
});

test('a Windows launch whose tab could not be disambiguated falls back to the pid', () => {
  const r = normalizeLaunchResult({ sessionId: 'uuid-3', pid: 4242, tabRid: null });
  assert.deepStrictEqual(r, { sessionId: 'uuid-3', terminal: '4242' });
});

test('a launch that registered no session reports it rather than inventing a handle', () => {
  const r = normalizeLaunchResult({ launched: false, sessionId: null, note: 'windows-only' });
  assert.deepStrictEqual(r, { sessionId: null, terminal: '' });
});

// ── the mission layer accepts a NON-tmux launch ────────────────────────────

function sharedMission(): Mission {
  return {
    id: 'mission_win', title: 't', objective: 'o', dependsOn: [], projects: [], tags: {}, parentId: null,
    env: { isolation: 'shared', resources: [], host: 'gw4-win' }, status: 'waiting', binding: null,
    progress: null, control: { nudgeCount: 0, backoffStep: 0 }, results: [], adjustments: [],
    rev: 1, history: [], ownerNode: 'gw4-win', createdAt: 1, updatedAt: 1,
  } as unknown as Mission;
}

test('🔴 THE REGRESSION: a Windows-shaped launch produces a real binding, not a throw', async () => {
  const binding = await startNativeExecutor(
    sharedMission(),
    { go: true, env: 'shared', host: 'gw4-win', repo: 'C:\\ws\\mission_win' },
    {
      ensureWorktree: async () => { throw new Error('shared placement must not need a worktree'); },
      // exactly what wtCcController.launch resolves to — no tmuxSession anywhere
      launch: async () => normalizeLaunchResult({ launched: true, sessionId: 'uuid-win', pid: 900, tabRid: 'rid-9' }),
      listAccount: async () => [],
      baseline: [],
      drive: async () => {},
    },
  );

  assert.strictEqual(binding.sessionId, 'uuid-win');
  assert.strictEqual(binding.node, 'gw4-win', 'the binding must name the machine it actually runs on');
  assert.strictEqual(binding.kind, 'worker');
});

// ── the CONTROLLER's own launch (bl_ee6b080c, second call site) ─────────────
//
// The worker spawn was fixed first; the supervisor that launches the Mission
// CONTROLLER still asked for `tmuxCcController` BY NAME, so a Windows node could
// never host a controller — same cause, different call site. These pin the two
// things that made it POSIX-only: which backend is asked, and which field the
// resulting terminal handle is read from.

test('🔴 the controller records a NEUTRAL terminal handle, not launched.tmuxSession', () => {
  // wtCcController.launch resolves to this shape. Reading `.tmuxSession` yields
  // '' on Windows, which is what erased the controller's terminal handle.
  const winLaunch = { launched: true, sessionId: 'ctl-win', pid: 700, tabRid: 'rid-ctl' };
  assert.strictEqual((winLaunch as Record<string, unknown>).tmuxSession, undefined,
    'a Windows launch has no tmuxSession — reading it is the bug');
  assert.strictEqual(normalizeLaunchResult(winLaunch).terminal, 'rid-ctl');
});

test('the controller handle still resolves to the tmux NAME on POSIX', () => {
  const posixLaunch = { sessionId: 'ctl-posix', tmuxSession: 'lmcc-ms44i3o6' };
  assert.strictEqual(normalizeLaunchResult(posixLaunch).terminal, 'lmcc-ms44i3o6',
    'POSIX behaviour must be unchanged by the neutral read');
});

test('a controller launch that registered nothing yields an empty handle, not a fake one', () => {
  assert.strictEqual(normalizeLaunchResult({ sessionId: null }).terminal, '');
});
