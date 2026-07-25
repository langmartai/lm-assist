/**
 * Regression tests for CCR registry liveness.
 *
 * THE bug these exist for (measured on node 117, 2026-07-25): `ccr_remote_list`
 * reported three entries `alive:false` while all three referred to LIVE sessions.
 * The registry stores the `ccr-bridge.js` helper pid, not claude's, so `alive`
 * answered "is the bridge up?" while reading as "is the session alive?". An agent
 * asked what was running, believed it, and told the user nothing was.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import {
  computeLiveness,
  isReapable,
  reapRecords,
  buildRemoteListReport,
  DEFAULT_REAP_AFTER_MS,
  type LivenessDeps,
  type SessionLiveness,
} from '../terminal/ccr-liveness';

/** Deps builder — nothing here touches a process, tmux, or the filesystem. */
const deps = (over: Partial<LivenessDeps> = {}): LivenessDeps => ({
  pidAlive: () => false,
  sessionLive: () => null,
  tmuxExists: () => false,
  ...over,
});

const live = (pid: number, tmux: string | null = null): SessionLiveness => ({
  live: true,
  pid,
  tmuxSession: tmux,
});

// ---------------------------------------------------------------------------
// 1. The incident itself
// ---------------------------------------------------------------------------

test('THE incident: dead bridge pid + live session => alive, not dead', () => {
  // ccr-89mc8iuv as it sat in the registry on 117.
  const rec = {
    sessionId: '32c5294c-fcfd-4f38-948d-70235445743b',
    tmuxSession: 'ccr-32c5294c',
    pid: 1319611, // the bridge — dead
    startedAt: '2026-07-22T08:28:36.886Z',
  };

  const r = computeLiveness(
    rec,
    deps({
      pidAlive: (p) => p !== 1319611, // bridge is gone
      sessionLive: () => live(1319220, 'ccr-32c5294c'), // claude is not
    }),
  );

  assert.equal(r.alive, true, 'the session is live — this is the whole bug');
  assert.equal(r.bridgeAlive, false, 'and the bridge really is down');
  assert.equal(r.verifiedBy, 'session-registry');
  assert.equal(r.unverified, false);
  assert.equal(r.sessionPid, 1319220, 'reports the REAL owner pid, not the record pid');
  assert.equal(r.tmuxAlive, true);
  assert.match(r.reason, /LIVE/);
  assert.match(r.reason, /relay is broken/, 'says the bridge is down and what to do');
});

test('inject records (pid:null) are no longer structurally dead', () => {
  // recordForLiveConnection writes pid:null, so isAlive(null) made these alive:false
  // FOREVER — even though inject only ever attaches to an already-live session.
  const r = computeLiveness(
    { sessionId: '32c5294c-fcfd-4f38-948d-70235445743b', pid: null, startedAt: '2026-07-22T08:28:36.889Z' },
    deps({ sessionLive: () => live(1319220) }),
  );

  assert.equal(r.alive, true);
  assert.equal(r.bridgeAlive, false, 'there is no bridge process for an inject record');
  assert.equal(r.verifiedBy, 'session-registry');
});

test('a live bridge does not make a dead session look alive', () => {
  const r = computeLiveness(
    { sessionId: 'sid-1', pid: 999, startedAt: new Date().toISOString() },
    deps({ pidAlive: () => true, sessionLive: () => ({ live: false, pid: null, tmuxSession: null }) }),
  );

  assert.equal(r.alive, false, 'the session registry wins over the bridge pid');
  assert.equal(r.bridgeAlive, true);
  assert.match(r.reason, /no live owner/);
});

// ---------------------------------------------------------------------------
// 2. The ladder degrades instead of guessing
// ---------------------------------------------------------------------------

test('no sessionId => falls back to real tmux state', () => {
  const r = computeLiveness(
    { tmuxSession: 'ccr-abc', pid: 5, startedAt: new Date().toISOString() },
    deps({ tmuxExists: (n) => n === 'ccr-abc' }),
  );

  assert.equal(r.alive, true);
  assert.equal(r.verifiedBy, 'tmux');
  assert.equal(r.unverified, false, 'tmux IS actual process state');
  assert.equal(r.sessionAlive, null, 'but it says nothing about a specific session');
});

test('an unresolvable session degrades to the next rung, it does not throw', () => {
  const r = computeLiveness(
    { sessionId: 'sid-x', tmuxSession: 'ccr-x', startedAt: new Date().toISOString() },
    deps({
      sessionLive: () => {
        throw new Error('registry unreadable');
      },
      tmuxExists: () => true,
    }),
  );

  assert.equal(r.alive, true);
  assert.equal(r.verifiedBy, 'tmux');
});

test('bridge-pid-only records are marked UNVERIFIED, never confidently dead', () => {
  const r = computeLiveness(
    { pid: 1206277, startedAt: '2026-06-02T21:27:24.310Z' }, // a real yitest row
    deps({ pidAlive: () => false }),
  );

  assert.equal(r.alive, false);
  assert.equal(r.verifiedBy, 'bridge-pid');
  assert.equal(r.unverified, true, 'we checked the helper, NOT the session');
  assert.match(r.reason, /NOT verified/);
});

test('nothing checkable => UNKNOWN, explicitly not asserted dead', () => {
  const r = computeLiveness({ startedAt: new Date().toISOString() }, deps());

  assert.equal(r.alive, false);
  assert.equal(r.verifiedBy, 'none');
  assert.equal(r.unverified, true);
  assert.match(r.reason, /UNKNOWN, not asserted dead/);
});

// ---------------------------------------------------------------------------
// 3. Reaping
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const dead = { alive: false, unverified: false } as any;
const alive = { alive: true } as any;

test('reap: dead and old goes, dead and fresh stays', () => {
  const old = { startedAt: ago(DEFAULT_REAP_AFTER_MS + 1000) };
  const fresh = { startedAt: ago(60_000) };

  assert.equal(isReapable(old, dead, { now: NOW, ttlMs: DEFAULT_REAP_AFTER_MS }), true);
  assert.equal(isReapable(fresh, dead, { now: NOW, ttlMs: DEFAULT_REAP_AFTER_MS }), false);
});

test('reap: a LIVE entry is never reaped, at any age', () => {
  // The 117 entries were 3 days old AND live. Age alone must never be enough.
  const ancient = { startedAt: ago(90 * 24 * 60 * 60 * 1000) };
  assert.equal(isReapable(ancient, alive, { now: NOW, ttlMs: DEFAULT_REAP_AFTER_MS }), false);
});

test('reap: an unparseable startedAt is kept rather than guessed away', () => {
  assert.equal(isReapable({ startedAt: 'not-a-date' }, dead, { now: NOW, ttlMs: 1 }), false);
  assert.equal(isReapable({}, dead, { now: NOW, ttlMs: 1 }), false);
});

test('reapRecords: drops the stale, keeps the live, reports changed', () => {
  const records = {
    'ccr-live': { sessionId: 'sid-live', pid: 1, startedAt: ago(3 * 24 * 60 * 60 * 1000) },
    'ccr-old': { pid: 2, startedAt: ago(DEFAULT_REAP_AFTER_MS + 1) },
    'ccr-fresh': { pid: 3, startedAt: ago(1000) },
  };

  const out = reapRecords(
    records,
    deps({ pidAlive: () => false, sessionLive: (s) => (s === 'sid-live' ? live(42) : null) }),
    { now: NOW, ttlMs: DEFAULT_REAP_AFTER_MS },
  );

  assert.deepEqual(out.reaped, ['ccr-old']);
  assert.deepEqual(Object.keys(out.kept).sort(), ['ccr-fresh', 'ccr-live']);
  assert.equal(out.changed, true);
  assert.equal(out.rows.find((r) => (r as any).sessionId === 'sid-live')?.alive, true);
});

test('reapRecords: nothing stale => changed=false, so no needless write', () => {
  const out = reapRecords(
    { 'ccr-a': { pid: 1, startedAt: ago(1000) } },
    deps({ pidAlive: () => true }),
    { now: NOW, ttlMs: DEFAULT_REAP_AFTER_MS },
  );

  assert.equal(out.changed, false);
  assert.equal(out.reaped.length, 0);
});

// ---------------------------------------------------------------------------
// 4. Saying where we looked
// ---------------------------------------------------------------------------

const WHERE = { node: 'yitest-Virtual-Machine', cluster: 'stage' };

test('an empty result names the node AND cluster it searched, and how to widen', () => {
  const rep = buildRemoteListReport([], WHERE, 0);

  assert.equal(rep.searched.node, 'yitest-Virtual-Machine');
  assert.equal(rep.searched.cluster, 'stage');
  assert.ok(rep.hint, 'an empty list MUST carry a hint');
  assert.match(rep.hint!, /yitest-Virtual-Machine/);
  assert.match(rep.hint!, /stage/);
  assert.match(rep.hint!, /cc_sessions/, 'points at the tool that knows the live truth');
  assert.match(rep.hint!, /session_footprints/);
  assert.match(rep.hint!, /not evidence that nothing is running/);
});

test('a non-empty but all-dead result still hints — that was the stage node', () => {
  const rows = [{ alive: false, unverified: false, bridgeAlive: false }] as any;
  const rep = buildRemoteListReport(rows, WHERE, 5);

  assert.ok(rep.hint);
  assert.equal(rep.summary.total, 1);
  assert.equal(rep.summary.alive, 0);
  assert.equal(rep.summary.reaped, 5);
});

test('when something is alive there is no hint, and bridgeDown is counted', () => {
  const rows = [
    { alive: true, unverified: false, bridgeAlive: false }, // the 117 case
    { alive: true, unverified: false, bridgeAlive: true },
  ] as any;
  const rep = buildRemoteListReport(rows, { node: 'ubuntu-Virtual-Machine', cluster: 'prod' }, 0);

  assert.equal(rep.hint, undefined);
  assert.equal(rep.summary.alive, 2);
  assert.equal(rep.summary.bridgeDown, 1, 'live session whose relay is down is worth surfacing');
});

test('the note redirects to the tool that actually answers "what is running"', () => {
  const rep = buildRemoteListReport([], WHERE, 0);
  assert.match(rep.note, /not the list of running Claude Code sessions/);
  assert.match(rep.note, /cc_sessions/);
});
