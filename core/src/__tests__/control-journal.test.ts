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

test('command contract: wrap → extract → pending/ack lifecycle', async () => {
  const { newCmdId, wrapControllerCommand, extractResultBlock } = await import('../mission/mission-controller');
  const { pendingCommandIds, ackMissingWarned } = await import('../mission/control-journal');
  const id = newCmdId();
  assert.match(id, /^cmd-[0-9a-f]{6}$/);
  const wrapped = wrapControllerCommand('Do task A and task B', id);
  assert.ok(wrapped.includes('Do task A and task B'));
  assert.ok(wrapped.includes(`⟦RESULT ${id}⟧`), 'contract names the exact result marker');

  const reply = `I did the work.\n\n⟦RESULT ${id}⟧\n- task A: done — commit abc123\n- task B: blocked — waiting on review\n\nAnything else?`;
  const res = extractResultBlock(reply, id);
  assert.equal(res.found, true);
  assert.deepEqual(res.tasks, ['task A: done — commit abc123', 'task B: blocked — waiting on review']);
  assert.equal(extractResultBlock('no marker here', id).found, false);

  const now = 1_000_000_000;
  const j = [
    { at: now - 60_000, kind: 'drive', cmdId: 'cmd-aaa', ok: true },
    { at: now - 50_000, kind: 'drive', cmdId: 'cmd-bbb', ok: true },
    { at: now - 40_000, kind: 'ack', cmdId: 'cmd-aaa' },
    { at: now - 30_000, kind: 'drive', cmdId: 'cmd-fail', ok: false }, // failed sends aren't pending
  ] as never;
  assert.deepEqual(pendingCommandIds(j, { now }), ['cmd-bbb']);
  assert.equal(ackMissingWarned(j, 'cmd-bbb'), false);
  const j2 = [...(j as unknown as object[]), { at: now - 10_000, kind: 'ack-missing', cmdId: 'cmd-bbb' }] as never;
  assert.equal(ackMissingWarned(j2, 'cmd-bbb'), true);
});

test('tick ack scan journals ack (found) and ack-missing (aged, once)', async () => {
  _resetNotMonitorStreak(); _resetJournalState();
  const cs: ControllerSession = { node: 'gw1', sessionId: 'sid-ack', cse: null, tmux: 'lmcc-a', startedAt: 1 };
  const now = Date.now();
  const journalEntries: Array<Record<string, unknown>> = [];
  const priorJournal = [
    { at: now - 20 * 60_000, kind: 'drive', cmdId: 'cmd-old', ok: true },  // aged, no result → ack-missing
    { at: now - 60_000, kind: 'drive', cmdId: 'cmd-new', ok: true },       // has a RESULT in the tail → ack
  ];
  const deps: SupervisorDeps = {
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'gw1' }),
    getControllerSession: async () => ({ ...cs, lastDriveAt: now }),
    putControllerSession: async () => {},
    isLive: () => true,
    journal: (e) => journalEntries.push(e),
    recentJournal: () => priorJournal as never,
    readControllerTail: async () => '⟦RESULT cmd-new⟧\n- reviewed missions: done — 3 checked',
    launch: async () => cs,
    drive: async () => {},
    teardown: async () => {},
    driveIntervalMin: 5,
    now,
  };
  await runSupervisorTick(deps);
  const acks = journalEntries.filter((e) => e.kind === 'ack');
  const missing = journalEntries.filter((e) => e.kind === 'ack-missing');
  assert.equal(acks.length, 1);
  assert.equal(acks[0].cmdId, 'cmd-new');
  assert.deepEqual(acks[0].tasks, ['reviewed missions: done — 3 checked']);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].cmdId, 'cmd-old');
  _resetNotMonitorStreak(); _resetJournalState();
});

test('extractBridgeSid: reads the transcript-declared bridge URL, newest wins, tolerates noise', async () => {
  const { extractBridgeSid } = await import('../mission/mission-controller');
  const lines = [
    '{"type":"user","message":{"content":"hi"}}',
    '{"type":"system","subtype":"bridge_status","content":"/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_OLD111"}',
    'garbage line',
    '{"type":"system","subtype":"bridge_status","content":"/remote-control is active · Continue at https://claude.ai/code/session_01TPEqNEW222"}',
  ];
  assert.equal(extractBridgeSid(lines), 'session_01TPEqNEW222'); // newest declaration wins
  assert.equal(extractBridgeSid(['no bridge lines here']), null);
});

test('tick backfills record.cse from the transcript bridge sid and journals it', async () => {
  _resetNotMonitorStreak(); _resetJournalState();
  const cs: ControllerSession = { node: 'gw1', sessionId: 'sid-b', cse: null, tmux: 'lmcc-b', startedAt: 1, lastDriveAt: Date.now() };
  let persisted: ControllerSession | null = null;
  const entries: Array<Record<string, unknown>> = [];
  const deps: SupervisorDeps = {
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'gw1' }),
    getControllerSession: async () => cs,
    putControllerSession: async (x) => { persisted = x; },
    isLive: () => true,
    journal: (e) => entries.push(e),
    readBridgeSid: async () => 'session_01Bridge123',
    launch: async () => cs,
    drive: async () => {},
    teardown: async () => {},
    driveIntervalMin: 5,
    now: Date.now(),
  };
  await runSupervisorTick(deps);
  assert.equal((persisted as ControllerSession | null)?.cse, 'session_01Bridge123');
  assert.ok(entries.some((e) => e.kind === 'lifecycle' && e.event === 'cse-discovered'));
  _resetNotMonitorStreak(); _resetJournalState();
});

test('tick fast-tracks a drive when a handoff-onboarded session is blocked on a TUI dialog', async () => {
  _resetNotMonitorStreak(); _resetJournalState();
  const now = Date.now();
  const cs: ControllerSession = { node: 'gw1', sessionId: 'sid-c', cse: null, tmux: 'lmcc-c', startedAt: 1, lastDriveAt: now };
  const entries: Array<Record<string, unknown>> = [];
  let drove = false;
  const deps: SupervisorDeps = {
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'gw1' }),
    getControllerSession: async () => cs,
    putControllerSession: async () => {},
    isLive: () => true,
    journal: (e) => entries.push(e),
    onboardedDialogPending: async () => 'mission_dlg1',
    launch: async () => cs,
    drive: async () => { drove = true; },
    teardown: async () => {},
    driveIntervalMin: 60, // cadence NOT due — only the dialog fast-track can drive
    now,
  };
  const r = await runSupervisorTick(deps);
  assert.equal(r.action, 'drive', 'dialog fast-track must force a drive');
  assert.ok(drove);
  assert.ok(entries.some((e) => e.action === 'dialog-fasttrack' && e.missionId === 'mission_dlg1'));
  _resetNotMonitorStreak(); _resetJournalState();
});
