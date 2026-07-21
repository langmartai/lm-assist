/**
 * Controller context-health compaction (2026-07-21 "progress seems stuck" fix #2).
 *
 * A Mission Controller near its context limit wedges: it goes idle, stops surfacing
 * finished executor work, and its next drive risks failing — but the existing
 * wedge-recovery only fires on a drive-FAILURE streak, which an idle controller
 * never accrues. The supervisor now reads the controller's context% and sends a
 * native /compact when it crosses a threshold (sheds context, keeps the session).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runSupervisorTick, shouldCompactController, _resetControllerCompactState, type SupervisorDeps } from '../mission/mission-controller';

function baseDeps(overrides: Partial<SupervisorDeps>): SupervisorDeps {
  const cs = { node: 'n1', sessionId: 'uuid-1', cse: null, tmux: 't', startedAt: 1, lastDriveAt: undefined } as any;
  return {
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'n1' }),
    getControllerSession: async () => cs,
    putControllerSession: async () => {},
    isLive: () => true,
    launch: async () => cs,
    drive: async () => {},
    teardown: async () => {},
    driveIntervalMin: 5,
    now: 10 * 60_000,
    ...overrides,
  } as SupervisorDeps;
}

beforeEach(() => _resetControllerCompactState());

// ── pure decision ──
test('shouldCompactController: at/above threshold fires, below does not, null never', () => {
  const base = { threshold: 85, lastCompactAt: null, now: 1_000_000, cooldownMs: 600_000 };
  assert.equal(shouldCompactController({ ...base, contextPct: 90 }), true);
  assert.equal(shouldCompactController({ ...base, contextPct: 85 }), true, 'boundary is inclusive');
  assert.equal(shouldCompactController({ ...base, contextPct: 84 }), false);
  assert.equal(shouldCompactController({ ...base, contextPct: null }), false, 'unknown context never compacts');
});

test('shouldCompactController: respects the cooldown since the last compact', () => {
  const base = { threshold: 85, contextPct: 95, now: 1_000_000, cooldownMs: 600_000 };
  assert.equal(shouldCompactController({ ...base, lastCompactAt: 1_000_000 - 100 }), false, 'within cooldown → skip');
  assert.equal(shouldCompactController({ ...base, lastCompactAt: 1_000_000 - 700_000 }), true, 'past cooldown → fire');
});

// ── tick integration ──
test('runSupervisorTick: a near-full controller is compacted (not driven)', async () => {
  let compacted = false;
  const deps = baseDeps({
    controllerContextPct: async () => 94,
    compactController: async () => { compacted = true; return true; },
    drive: async () => { assert.fail('must NOT drive a controller we are compacting'); },
  });
  const r = await runSupervisorTick(deps);
  assert.match(r.action, /^compact-controller\(ctx=94%\)/);
  assert.equal(compacted, true);
});

test('runSupervisorTick: low context → normal path, no compact', async () => {
  let compacted = false;
  const deps = baseDeps({
    controllerContextPct: async () => 40,
    compactController: async () => { compacted = true; return true; },
  });
  const r = await runSupervisorTick(deps);
  assert.equal(compacted, false);
  assert.doesNotMatch(r.action, /compact-controller/);
});

test('runSupervisorTick: controller busy (compact returns false) → falls through to the drive gate', async () => {
  const deps = baseDeps({
    controllerContextPct: async () => 94,
    compactController: async () => false, // busy — could not compact this tick
  });
  const r = await runSupervisorTick(deps);
  assert.doesNotMatch(r.action, /compact-controller/, 'a busy controller is not reported as compacted');
});

test('runSupervisorTick: a context-read error never sinks the tick', async () => {
  const deps = baseDeps({
    controllerContextPct: async () => { throw new Error('tmux capture failed'); },
    compactController: async () => true,
  });
  const r = await runSupervisorTick(deps); // must not throw
  assert.doesNotMatch(r.action, /compact-controller/);
});

test('runSupervisorTick: no context-health deps → behaviour unchanged (regression)', async () => {
  const r = await runSupervisorTick(baseDeps({}));
  assert.doesNotMatch(r.action, /compact-controller/);
});
