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
