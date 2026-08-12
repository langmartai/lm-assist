import { test } from 'node:test';
import assert from 'node:assert';
import { selectActive, selectBound } from '../mission/mission-store';
import { buildSnapshot, type BuildDeps } from '../fleet/session-footprint-collector';

// Task 2 narrowed `selectActive`/`listActiveMissions` to exclude `manageMode: 'standby'`
// missions, so the supervisor stops arming timers / re-placing a session a human is
// personally operating. That change must NOT make the footprint/occupancy path (which
// answers "who occupies this session?", not "should the supervisor engage this?") blind
// to standby missions — a standby session is MORE spoken-for than an unbound one, not
// less. This file proves the two selectors deliberately disagree on a standby mission.

type Fixture = {
  id: string;
  status: string;
  manageMode?: string;
  binding?: { sessionId?: string | null } | null;
};

function mk(id: string, status: string, opts: { manageMode?: string; sessionId?: string | null } = {}): Fixture {
  return {
    id,
    status,
    manageMode: opts.manageMode,
    binding: opts.sessionId !== undefined ? { sessionId: opts.sessionId } : null,
  };
}

test('selectBound includes a standby, bound, non-terminal mission; selectActive excludes it', () => {
  const all: Fixture[] = [
    mk('mission_standby_bound', 'active', { manageMode: 'standby', sessionId: 'sess_standby' }),
    mk('mission_handoff_bound', 'active', { manageMode: 'handoff', sessionId: 'sess_handoff' }),
    mk('mission_standby_done', 'done', { manageMode: 'standby', sessionId: 'sess_done' }),
    mk('mission_standby_unbound', 'waiting', { manageMode: 'standby', sessionId: null }),
  ];

  // The supervisor's set: standby is out, regardless of binding.
  const activeIds = selectActive(all).map((m) => m.id);
  assert.deepEqual(activeIds, ['mission_handoff_bound'], 'listActiveMissions/selectActive must still exclude standby');

  // The occupancy set: standby is IN as long as it's non-terminal and bound.
  const boundIds = selectBound(all).map((m) => m.id);
  assert.deepEqual(
    boundIds.sort(),
    ['mission_handoff_bound', 'mission_standby_bound'].sort(),
    'selectBound must include a standby mission that is bound and non-terminal',
  );
  assert.ok(!boundIds.includes('mission_standby_done'), 'a terminal (done) mission must never report as occupying a session');
  assert.ok(!boundIds.includes('mission_standby_unbound'), 'a mission with no session binding must never report as occupying a session');
});

test('footprint path: a standby-mission session reports managed, not null', async () => {
  const now = 1_000_000;
  // Mirrors how getLocalSnapshot() wires `bound()`: derive the sessionId->missionId map
  // from the occupancy selector (selectBound), exactly as session-footprint-collector.ts does.
  const missions: Fixture[] = [
    mk('mission_standby_bound', 'active', { manageMode: 'standby', sessionId: 'sess_standby' }),
  ];
  const boundMap = new Map<string, string>();
  for (const m of selectBound(missions)) {
    if (m.binding?.sessionId) boundMap.set(m.binding.sessionId, m.id);
  }

  const deps: BuildDeps = {
    sessions: () => [
      { sessionId: 'sess_standby', cacheData: { cwd: '', fileMtime: now, customTitle: 'human-operated' } },
      { sessionId: 'sess_unowned', cacheData: { cwd: '', fileMtime: now, customTitle: 'nobody home' } },
    ],
    bound: async () => boundMap,
    identity: () => ({ node: 'n1', host: 'h1', cluster: 'c1' }),
    gitFor: async () => { throw new Error('gitFor should not be called — no cwd on either fixture session'); },
    ports: async () => [],
    now: () => now,
  };

  const snap = await buildSnapshot(deps);
  const standbySession = snap.sessions.find((s) => s.sessionId === 'sess_standby');
  const unownedSession = snap.sessions.find((s) => s.sessionId === 'sess_unowned');
  assert.ok(standbySession, 'fixture session must appear in the snapshot');
  assert.ok(unownedSession, 'fixture session must appear in the snapshot');
  assert.equal(standbySession!.managed, 'mission_standby_bound', 'a session under a standby mission must report managed, not null — that is the whole point of the feature');
  assert.equal(unownedSession!.managed, null, 'a session with no mission at all is correctly unmanaged');
});
