import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { recordControl, readControlJournal } from '../mission/control-journal';
import { runSupervisorTick, _resetNotMonitorStreak, _resetJournalState, type SupervisorDeps } from '../mission/mission-controller';
import type { ControllerSession } from '../mission/mission-store';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-journal-'));

test('recordControl/readControlJournal round-trip, bounded, junk-tolerant', () => {
  const dir = tmp();
  recordControl(dir, { at: 1, kind: 'boot', record: null });
  fs.appendFileSync(path.join(dir, 'control-journal.jsonl'), 'garbage\n');
  recordControl(dir, { at: 2, kind: 'drive', sid: 'x', transport: 'tmux', ok: true });
  const j = readControlJournal(dir);
  assert.deepEqual(j.map((e) => e.kind), ['boot', 'drive']);
  for (let i = 0; i < 1010; i++) recordControl(dir, { at: i, kind: 'tick', action: 'idle' });
  const lines = fs.readFileSync(path.join(dir, 'control-journal.jsonl'), 'utf-8').split('\n').filter(Boolean);
  assert.ok(lines.length <= 1000, `bounded, got ${lines.length}`);
});

test('supervisor journals boot once + non-idle decisions with FULL inputs; idle stays silent', async () => {
  _resetNotMonitorStreak(); _resetJournalState();
  const cs: ControllerSession = { node: 'gw1', sessionId: 'sid-1', cse: null, tmux: 'lmcc-x', startedAt: 1 };
  const entries: Array<Record<string, unknown>> = [];
  const deps: SupervisorDeps = {
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'gw1' }),
    getControllerSession: async () => cs,
    putControllerSession: async () => {},
    isLive: () => true,
    journal: (e) => entries.push(e),
    launch: async () => cs,
    drive: async () => {},
    teardown: async () => {},
    driveIntervalMin: 5,
    now: 10 * 60_000, // lastDriveAt absent → driveDue → action=drive
  };
  await runSupervisorTick(deps);
  const kinds = entries.map((e) => e.kind);
  assert.deepEqual(kinds, ['boot', 'tick']);
  const tick = entries[1];
  assert.equal(tick.action, 'drive');
  assert.equal(tick.isMonitor, true);
  assert.equal(tick.record, 'sid-1');
  assert.ok('notMonitorStreak' in tick && 'live' in tick && 'driveDue' in tick, 'full inputs journaled');

  // A subsequent idle tick journals NOTHING new (boot already recorded, no state change).
  entries.length = 0;
  const freshCs = { ...cs, lastDriveAt: 10 * 60_000 };
  await runSupervisorTick({ ...deps, getControllerSession: async () => freshCs });
  assert.deepEqual(entries, []);
  _resetNotMonitorStreak(); _resetJournalState();
});

test('driveFailureStreak: counts trailing failures for the sid, resets on success, ignores other sids', async () => {
  const { driveFailureStreak } = await import('../mission/control-journal');
  const j = [
    { at: 1, kind: 'drive', sid: 'a', ok: false },
    { at: 2, kind: 'drive', sid: 'a', ok: true },
    { at: 3, kind: 'drive', sid: 'b', ok: false }, // other sid — ignored
    { at: 4, kind: 'drive', sid: 'a', ok: false },
    { at: 5, kind: 'tick', action: 'idle' },
    { at: 6, kind: 'drive', sid: 'a', ok: false },
  ] as never;
  assert.equal(driveFailureStreak(j, 'a'), 2);
  assert.equal(driveFailureStreak(j, 'b'), 1);
  assert.equal(driveFailureStreak([] as never, 'a'), 0);
});

test('recentLaunchCount: only lifecycle launches/resumes inside the window', async () => {
  const { recentLaunchCount } = await import('../mission/control-journal');
  const now = 1_000_000;
  const j = [
    { at: now - 11 * 60_000, kind: 'lifecycle', event: 'launched' }, // outside window
    { at: now - 5 * 60_000, kind: 'lifecycle', event: 'resumed' },
    { at: now - 2 * 60_000, kind: 'lifecycle', event: 'teardown' },  // not a launch
    { at: now - 1 * 60_000, kind: 'lifecycle', event: 'launched' },
  ] as never;
  assert.equal(recentLaunchCount(j, now), 2);
});

test('the LOOP consumes traces: 3 failed drives → relaunch; launch churn → back-off idle', async () => {
  _resetNotMonitorStreak(); _resetJournalState();
  const cs: ControllerSession = { node: 'gw1', sessionId: 'sid-w', cse: null, tmux: 'lmcc-w', startedAt: 1 };
  const failures = [
    { at: 1, kind: 'drive', sid: 'sid-w', ok: false },
    { at: 2, kind: 'drive', sid: 'sid-w', ok: false },
    { at: 3, kind: 'drive', sid: 'sid-w', ok: false },
  ];
  let launched = false;
  const base: SupervisorDeps = {
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'gw1' }),
    getControllerSession: async () => cs,
    putControllerSession: async () => {},
    isLive: () => true, // tmux LOOKS alive…
    recentJournal: () => failures as never,
    launch: async () => { launched = true; return cs; },
    drive: async () => {},
    teardown: async () => {},
    driveIntervalMin: 5,
    now: 20 * 60_000,
  };
  const r = await runSupervisorTick(base);
  assert.equal(r.action, 'launch', 'wedged controller (3 failed drives) must relaunch');
  assert.ok(launched);

  // churn: the same relaunch decision is HELD when the journal shows 3 recent launches
  _resetNotMonitorStreak(); _resetJournalState();
  launched = false;
  const churnJournal = [
    ...failures,
    { at: 19 * 60_000, kind: 'lifecycle', event: 'launched' },
    { at: 19.5 * 60_000, kind: 'lifecycle', event: 'resumed' },
    { at: 19.8 * 60_000, kind: 'lifecycle', event: 'launched' },
  ];
  const r2 = await runSupervisorTick({ ...base, recentJournal: () => churnJournal as never });
  assert.equal(r2.action, 'idle', 'churning loop must back off, not feed the cycle');
  assert.equal(launched, false);
  _resetNotMonitorStreak(); _resetJournalState();
});
