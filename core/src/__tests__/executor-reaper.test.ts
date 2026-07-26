import test from 'node:test';
import assert from 'node:assert';
import {
  isPaneBusy,
  parseCtxPctLast,
  reapGate,
  buildHarvestEntry,
  runExecutorReaper,
  ReaperMission,
  ExecutorReaperDeps,
} from '../scheduler/executor-reaper';

const CFG = { ctxExhaustedPct: 95, idleMinutes: 120, graceMinutes: 30 };

// A REAL busy screen: the modern TUI paints the ❯ composer AND the ctx: footer
// while working, so `derivePhase` reports 'idle' here. This is the trap the
// reaper must not fall into.
//
// The ONLY busy signal here is the running spinner — deliberately no
// `↓ N tokens` and no `esc to interrupt`, so this screen exercises the spinner
// rule in isolation. (An earlier version carried a token counter too, which made
// this test pass even with the spinner rule deleted — caught by mutation.)
const BUSY_SCREEN_THAT_LOOKS_IDLE = [
  '⏺ Reading the mission store…',
  '✽ Infusing… (37s)',
  '',
  '❯                                                            ',
  '  ⏵⏵ bypass permissions on · ctx:64% · sid: 6e2a62df-4798-4661-b2a4-a76ea584cc79 Opus 5',
].join('\n');

/** Every busy rule, each isolated so no single rule can mask another. */
const BUSY_CASES: Array<[string, string]> = [
  ['queued messages', 'ctx:100%\n❯ Press up to edit queued messages'],
  ['esc to interrupt', 'ctx:50%\n  (esc to interrupt)'],
  ['spinner, no counter', 'ctx:64%\n✽ Infusing… (37s)\n❯ '],
  ['spinner, alt glyph', 'ctx:64%\n· Percolating… (4s)\n❯ '],
  ['streaming counter', 'ctx:50%\n⏺ thinking\n  ↓ 1234 tokens'],
];

const IDLE_SCREEN = [
  '✻ Cogitated for 25s',
  '⏺ Done — merged to main.',
  '',
  '❯                                                            ',
  '  ⏵⏵ bypass permissions on · ctx:100% · sid: 6e2a62df-4798-4661-b2a4-a76ea584cc79 Opus 5',
].join('\n');

// ── isPaneBusy ───────────────────────────────────────────

test('isPaneBusy: a busy screen that derivePhase would call idle is BUSY', () => {
  // Both markers derivePhase keys on are present…
  assert.ok(BUSY_SCREEN_THAT_LOOKS_IDLE.includes('❯'));
  assert.ok(BUSY_SCREEN_THAT_LOOKS_IDLE.includes('ctx:'));
  // …and the reaper still refuses to call it idle.
  assert.equal(isPaneBusy(BUSY_SCREEN_THAT_LOOKS_IDLE, null), true);
});

test('isPaneBusy: every busy rule fires on its own, none masked by another', () => {
  // Each case carries exactly ONE busy signal, so deleting any single rule
  // must break exactly one of these.
  for (const [name, screen] of BUSY_CASES) {
    assert.equal(isPaneBusy(screen, null), true, `${name} must read busy`);
  }
});

test('isPaneBusy: a FINISHED turn ("✻ Cogitated for 25s") is not busy', () => {
  // The spinner regex requires "… (Ns" — a finished turn has no paren, so the
  // glyph alone must not false-match, or nothing would ever be reaped.
  assert.equal(isPaneBusy(IDLE_SCREEN, null), false);
});

test('isPaneBusy: queued messages are busy — a kill would destroy them', () => {
  const s = IDLE_SCREEN + '\n  ❯ Press up to edit queued messages';
  assert.equal(isPaneBusy(s, null), true);
});

test('isPaneBusy: "esc to interrupt" is busy', () => {
  assert.equal(isPaneBusy('working (esc to interrupt)\nctx:50%', null), true);
});

test('isPaneBusy: streaming token counter is busy', () => {
  assert.equal(isPaneBusy('⏺ thinking\n  ↓ 1234 tokens\nctx:50%', null), true);
});

test('isPaneBusy: transcript flushed <12s ago is busy even on a quiet screen', () => {
  assert.equal(isPaneBusy(IDLE_SCREEN, 5_000), true);
  assert.equal(isPaneBusy(IDLE_SCREEN, 30_000), false);
});

test('isPaneBusy: unknown transcript age does not manufacture busy', () => {
  assert.equal(isPaneBusy(IDLE_SCREEN, null), false);
});

// ── parseCtxPctLast ──────────────────────────────────────

test('parseCtxPctLast: takes the LAST ctx:, not the first', () => {
  // An agent reading a capture has older ctx: lines scrolled up its own pane.
  const s = 'pasted capture: ctx:12%\nmore text\n ctx:100% sid: x Opus 5';
  assert.equal(parseCtxPctLast(s), 100);
});

test('parseCtxPctLast: absent / malformed → null', () => {
  assert.equal(parseCtxPctLast('no footer here'), null);
  assert.equal(parseCtxPctLast('ctx:999%'), null);
});

// ── reapGate ─────────────────────────────────────────────

const NOW = 100 * 3_600_000; // the fake clock used by mkDeps()
const done = (o: Partial<ReaperMission> = {}): ReaperMission => ({
  // updatedAt ≈ 5.5h before NOW, so the grace window is comfortably passed.
  id: 'mission_abc', status: 'done', resultCount: 1, updatedAt: NOW - 20_000_000, ...o,
});
const gate = (o: Partial<Parameters<typeof reapGate>[0]> = {}) =>
  reapGate({
    mission: done(), busy: false, connectStrategy: 'attach-existing', ctxPct: 100,
    idleMinutes: 500, terminalAgeMinutes: 600, cfg: CFG, ...o,
  });

test('reapGate: done + exhausted context → reap', () => {
  assert.equal(gate().reap, true);
});

test('reapGate: done + long idle at LOW context → reap', () => {
  assert.equal(gate({ ctxPct: 18, idleMinutes: 6000 }).reap, true);
});

test('reapGate: an ACTIVE mission is never reaped', () => {
  for (const status of ['active', 'waiting', 'draft', 'paused', 'blocked']) {
    const r = gate({ mission: done({ status }) });
    assert.equal(r.reap, false, `${status} must be kept`);
  }
});

test('reapGate: an onboarded session is never reaped', () => {
  assert.equal(gate({ mission: done({ origin: 'onboarded' }) }).reap, false);
});

test('reapGate: a reserved store id is never reaped', () => {
  assert.equal(gate({ mission: done({ id: '__controller__' }) }).reap, false);
});

test('reapGate: a busy pane is never reaped, however exhausted', () => {
  assert.equal(gate({ busy: true }).reap, false);
});

test('reapGate: connectStrategy=refuse is never reaped', () => {
  assert.equal(gate({ connectStrategy: 'refuse' }).reap, false);
});

test('reapGate: a pane with no mission is never reaped', () => {
  const r = gate({ mission: null });
  assert.equal(r.reap, false);
  assert.match(r.reason, /no mission/);
});

test('reapGate: grace window protects a just-finished mission', () => {
  assert.equal(gate({ terminalAgeMinutes: 5 }).reap, false);
  assert.equal(gate({ terminalAgeMinutes: 31 }).reap, true);
});

test('reapGate: unknown terminal age keeps the pane', () => {
  assert.equal(gate({ terminalAgeMinutes: null }).reap, false);
});

test('reapGate: healthy context + short idle → kept', () => {
  assert.equal(gate({ ctxPct: 40, idleMinutes: 10 }).reap, false);
});

// ── buildHarvestEntry ────────────────────────────────────

test('buildHarvestEntry: git provenance becomes the ref', () => {
  const e = buildHarvestEntry(
    done({ resultCount: 0 }),
    { ref: 'b893bb8 merged to main', summary: '1 commit: feat(voice): selectable voice', commits: 1 },
    { sessionId: 'sid-1', jsonl: '/p/sid-1.jsonl' },
    { name: 'lmx-x', ctxPct: 100, idleMinutes: 300 },
  );
  assert.match(e.ref, /b893bb8/);
  assert.equal(e.commits, 1);
});

test('buildHarvestEntry: no git provenance still points at the transcript', () => {
  const e = buildHarvestEntry(
    done({ resultCount: 0 }), null,
    { sessionId: 'sid-2', jsonl: '/p/sid-2.jsonl' },
    { name: 'lmx-y', ctxPct: 100, idleMinutes: 300 },
  );
  assert.match(e.ref, /session:sid-2/);
  assert.match(e.summary, /no .*provenance|never branched/i);
  assert.match(e.summary, /\/p\/sid-2\.jsonl/); // the account is not lost
  assert.equal(e.commits, 0);
});

test('buildHarvestEntry: oversize summary is clipped to the store limit', () => {
  const e = buildHarvestEntry(
    done({ resultCount: 0 }),
    { ref: 'x', summary: 'y'.repeat(5000), commits: 3 },
    { sessionId: 's', jsonl: null }, { name: 'p', ctxPct: 100, idleMinutes: 1 },
  );
  assert.ok(e.summary.length <= 2000, `summary ${e.summary.length} must be <= 2000`);
});

// ── runExecutorReaper ────────────────────────────────────

function mkDeps(over: Partial<ExecutorReaperDeps> = {}): ExecutorReaperDeps & { killed: string[]; written: string[] } {
  const killed: string[] = [];
  const written: string[] = [];
  const d: ExecutorReaperDeps & { killed: string[]; written: string[] } = {
    killed, written,
    listExecutorPanes: () => ['lmx-a'],
    paneFacts: () => ({ createdMs: 0, activityMs: 0, cwd: '/r/.claude/worktrees/mission-mission_abc' }),
    capture: () => IDLE_SCREEN,
    sessionForPane: () => ({ sessionId: 'sid-1', jsonl: '/p/sid-1.jsonl', connectStrategy: 'attach-existing' }),
    missionFor: () => done({ resultCount: 1 }),
    refetchMission: async () => done({ resultCount: 1 }),
    isLeader: () => true,
    missionCount: () => 54,
    transcriptMtimeMs: () => 0,
    harvestCommits: () => null,
    appendResult: async (id) => { written.push(id); return true; },
    clearBinding: async () => {},
    kill: (p) => { killed.push(p); },
    now: () => NOW,
    log: () => {},
    ...over,
  };
  return d;
}

test('runExecutorReaper: DEFAULTS TO DRY RUN — kills nothing', async () => {
  const d = mkDeps();
  const r = await runExecutorReaper({}, d); // no dryRun key at all
  assert.equal(r.decisions[0].action, 'would-reap');
  assert.deepEqual(d.killed, []);
});

test('runExecutorReaper: a non-leader node does nothing', async () => {
  const d = mkDeps({ isLeader: () => false });
  const r = await runExecutorReaper({ dryRun: false }, d);
  assert.equal(r.scanned, 0);
  assert.deepEqual(d.killed, []);
});

test('runExecutorReaper: an empty mission list is a sync lag, not 32 orphans', async () => {
  const d = mkDeps({ missionCount: () => 0 });
  const r = await runExecutorReaper({ dryRun: false }, d);
  assert.equal(r.scanned, 0);
  assert.deepEqual(d.killed, []);
});

test('runExecutorReaper: armed run kills and clears the binding', async () => {
  const cleared: string[] = [];
  const d = mkDeps({ clearBinding: async (id) => { cleared.push(id); } });
  const r = await runExecutorReaper({ dryRun: false }, d);
  assert.equal(r.reaped, 1);
  assert.deepEqual(d.killed, ['lmx-a']);
  assert.deepEqual(cleared, ['mission_abc']);
});

test('runExecutorReaper: a FAILED harvest write cancels the reap', async () => {
  const d = mkDeps({
    missionFor: () => done({ resultCount: 0 }),
    appendResult: async () => false, // the write did not land
  });
  const r = await runExecutorReaper({ dryRun: false }, d);
  assert.equal(r.decisions[0].action, 'harvest-failed');
  assert.deepEqual(d.killed, [], 'must not kill when the account could not be saved');
});

test('runExecutorReaper: harvest happens BEFORE the kill', async () => {
  const order: string[] = [];
  const d = mkDeps({
    missionFor: () => done({ resultCount: 0 }),
    appendResult: async () => { order.push('harvest'); return true; },
    kill: () => { order.push('kill'); },
  });
  await runExecutorReaper({ dryRun: false }, d);
  assert.deepEqual(order, ['harvest', 'kill']);
});

test('runExecutorReaper: a mission that already has results is not re-harvested', async () => {
  const d = mkDeps({ missionFor: () => done({ resultCount: 3 }) });
  await runExecutorReaper({ dryRun: false }, d);
  assert.deepEqual(d.written, []);
});

test('runExecutorReaper: re-check finds the pane busy → kill aborted', async () => {
  let n = 0;
  const d = mkDeps({
    // first capture (scan) idle, second capture (re-check) busy
    capture: () => (++n === 1 ? IDLE_SCREEN : BUSY_SCREEN_THAT_LOOKS_IDLE),
  });
  const r = await runExecutorReaper({ dryRun: false }, d);
  assert.equal(r.reaped, 0);
  assert.match(r.decisions[0].reason, /re-check/);
  assert.deepEqual(d.killed, []);
});

test('runExecutorReaper: re-check finds the mission re-activated → kill aborted', async () => {
  // Scan sees `done`; the independent re-read sees it back on `active`.
  const d = mkDeps({ refetchMission: async () => done({ status: 'active' }) });
  const r = await runExecutorReaper({ dryRun: false }, d);
  assert.equal(r.reaped, 0);
  assert.deepEqual(d.killed, []);
});

test('runExecutorReaper: re-check reads the STORE, not the scan snapshot', async () => {
  // If the re-check reused `missionFor`, this mission would still look done and
  // the pane would be killed. Only a real re-read catches the flip.
  let refetched = 0;
  const d = mkDeps({ refetchMission: async () => { refetched++; return done({ status: 'waiting' }); } });
  const r = await runExecutorReaper({ dryRun: false }, d);
  assert.equal(refetched, 1, 'the store must be re-read exactly once before the kill');
  assert.equal(r.reaped, 0);
  assert.deepEqual(d.killed, []);
});

test('runExecutorReaper: a re-check that THROWS aborts the kill', async () => {
  const d = mkDeps({ refetchMission: async () => { throw new Error('store unreachable'); } });
  const r = await runExecutorReaper({ dryRun: false }, d);
  assert.equal(r.reaped, 0);
  assert.deepEqual(d.killed, [], 'an unreadable store must never authorise a kill');
});

test('runExecutorReaper: a missing/zero updatedAt is UNKNOWN age, not epoch-ancient', async () => {
  for (const stamp of [0, undefined, NaN]) {
    const d = mkDeps({ missionFor: () => done({ updatedAt: stamp as number }) });
    const r = await runExecutorReaper({ dryRun: false }, d);
    assert.equal(r.reaped, 0, `updatedAt=${stamp} must not reap`);
    assert.deepEqual(d.killed, []);
  }
});

test('runExecutorReaper: an unresolvable pane is reported, never reaped', async () => {
  const d = mkDeps({ missionFor: () => null });
  const r = await runExecutorReaper({ dryRun: false }, d);
  assert.equal(r.unresolved, 1);
  assert.deepEqual(d.killed, []);
});

test('runExecutorReaper: maxReapsPerRun truncates LOUDLY, never silently', async () => {
  const logs: string[] = [];
  const d = mkDeps({
    listExecutorPanes: () => ['a', 'b', 'c', 'd', 'e'],
    log: (l) => logs.push(l),
  });
  const r = await runExecutorReaper({ dryRun: false, maxReapsPerRun: 2 }, d);
  assert.equal(r.reaped, 2);
  assert.equal(r.truncated, true);
  assert.ok(logs.some((l) => /maxReapsPerRun/.test(l)), 'must log the truncation');
});

test('runExecutorReaper: a kill that throws leaves the mission bound, not half-reaped', async () => {
  const cleared: string[] = [];
  const d = mkDeps({
    kill: () => { throw new Error('tmux POSTCONDITION_FAILED'); },
    clearBinding: async (id) => { cleared.push(id); },
  });
  const r = await runExecutorReaper({ dryRun: false }, d);
  assert.equal(r.reaped, 0);
  assert.deepEqual(cleared, [], 'binding must survive a failed kill');
});
