import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildSnapshot, createLocalFootprintCache } from '../../fleet/session-footprint-collector';
import type { NodeFootprint, GitState } from '../../fleet/footprint-types';

const IDENT = () => ({ node: 'gw-1', host: 'h1', cluster: 'prod' });
const GIT_OK = async () => ({ git: { branch: 'main', worktree: '/r', upstream: 'origin/main', ahead: 0, dirty: 1, pushed: true }, openChanges: ['a.ts'], openChangesTruncated: false, repo: '/r' });

test('buildSnapshot — assembles sessions, tags managed, attaches git + ports', async () => {
  const snap = await buildSnapshot({
    sessions: () => [
      { sessionId: 'sess-A', cacheData: { cwd: '/r', fileMtime: 1000, customTitle: 'A' } },
      { sessionId: 'session_cloud1', cacheData: { cwd: '/r', fileMtime: 900 } },
    ],
    bound: async () => new Map([['sess-A', 'mission-7']]),
    identity: IDENT,
    gitFor: GIT_OK,
    ports: async () => [{ port: 5432, proto: 'tcp', pid: 9, proc: 'postgres' }],
    now: () => 2000,
  });
  assert.equal(snap.node, 'gw-1');
  assert.equal(snap.warming, false);
  assert.equal(snap.sessions.length, 2);
  const a = snap.sessions.find((s) => s.sessionId === 'sess-A')!;
  assert.equal(a.managed, 'mission-7');
  assert.equal(a.transport, 'native');
  assert.equal(a.title, 'A');
  assert.equal(a.isActive, true);    // now=2000, fileMtime=1000 → age 1000ms < ACTIVE_MS
  assert.deepEqual(a.openChanges, ['a.ts']);
  const c = snap.sessions.find((s) => s.sessionId === 'session_cloud1')!;
  assert.equal(c.managed, null);
  assert.equal(c.transport, 'cloud');
  assert.deepEqual(snap.ports, [{ port: 5432, proto: 'tcp', pid: 9, proc: 'postgres' }]);
});

test('buildSnapshot — collapses openChanges to once per worktree (siblings reference the canonical)', async () => {
  const gitByCwd: Record<string, { git: GitState; openChanges: string[]; openChangesTruncated: boolean; repo: string | null }> = {
    '/r1': { git: { branch: 'main', worktree: '/r1', upstream: 'o/main', ahead: 1, dirty: 2, pushed: false }, openChanges: ['a.ts', 'b.ts'], openChangesTruncated: false, repo: '/r1' },
    '/r2': { git: { branch: 'dev', worktree: '/r2', upstream: null, ahead: 0, dirty: 1, pushed: false }, openChanges: ['c.ts'], openChangesTruncated: false, repo: '/r2' },
  };
  const snap = await buildSnapshot({
    sessions: () => [
      { sessionId: 'newest', cacheData: { cwd: '/r1', fileMtime: 3000 } },  // most-recent in /r1 → canonical
      { sessionId: 'older', cacheData: { cwd: '/r1', fileMtime: 2000 } },   // same worktree → elided
      { sessionId: 'other', cacheData: { cwd: '/r2', fileMtime: 1000 } },   // different worktree → keeps own
    ],
    bound: async () => new Map(),
    identity: IDENT,
    gitFor: async (cwd: string) => gitByCwd[cwd],
    ports: async () => [],
    now: () => 4000,
  });
  const newest = snap.sessions.find((s) => s.sessionId === 'newest')!;
  const older = snap.sessions.find((s) => s.sessionId === 'older')!;
  const other = snap.sessions.find((s) => s.sessionId === 'other')!;
  // canonical (most-recent in the worktree) keeps the full list, no pointer
  assert.deepEqual(newest.openChanges, ['a.ts', 'b.ts']);
  assert.equal(newest.openChangesSharedWith, undefined);
  // sibling in the SAME worktree → openChanges elided + points to the canonical; git block intact
  assert.deepEqual(older.openChanges, []);
  assert.equal(older.openChangesSharedWith, 'newest');
  assert.equal(older.git.worktree, '/r1');  // worktree/branch/dirty still per-session → collision detection intact
  assert.equal(older.git.dirty, 2);
  // different worktree → keeps its own list, no pointer
  assert.deepEqual(other.openChanges, ['c.ts']);
  assert.equal(other.openChangesSharedWith, undefined);
});

test('createLocalFootprintCache.get() — NEVER awaits the collector: returns warming synchronously while build hangs', () => {
  let resolveBuild!: (s: NodeFootprint) => void;
  const build = () => new Promise<NodeFootprint>((res) => { resolveBuild = res; }); // never settles during the test
  const cache = createLocalFootprintCache(build, IDENT, { now: () => 0 });
  const first = cache.get(); // must return synchronously, no await
  assert.equal(first.warming, true);
  assert.equal(first.sessions.length, 0);
  cache.dispose();
});

test('createLocalFootprintCache — single-flight: concurrent get()s trigger ONE build; serves cache once ready', async () => {
  let builds = 0;
  const build = async (): Promise<NodeFootprint> => { builds++; return { node: 'gw-1', host: 'h1', cluster: 'prod', snapshotAgeSec: 0, reachable: true, warming: false, stale: false, sessions: [], ports: [] }; };
  let clock = 0;
  const cache = createLocalFootprintCache(build, IDENT, { now: () => clock, ttlMs: 10_000 });
  cache.get(); cache.get(); cache.get();             // cold → one kick
  await new Promise((r) => setTimeout(r, 0));          // let the build microtask settle
  const warm = cache.get();
  assert.equal(warm.warming, false);
  assert.equal(builds, 1, 'single-flight should have built once');
  clock = 20_000;                                      // now stale
  cache.get();                                         // stale → kicks a refresh
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(builds, 2, 'stale read should trigger exactly one more build');
  cache.dispose();
});
