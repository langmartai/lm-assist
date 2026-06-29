import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildSnapshot, createLocalFootprintCache } from '../../fleet/session-footprint-collector';
import type { NodeFootprint } from '../../fleet/footprint-types';

const IDENT = () => ({ node: 'gw-1', host: 'h1', cluster: 'prod' });
const GIT_OK = async () => ({ git: { branch: 'main', worktree: '/r', upstream: 'origin/main', ahead: 0, dirty: 1, pushed: true }, openChanges: ['a.ts'], openChangesTruncated: false, repo: '/r' });

test('buildSnapshot — assembles sessions, tags managed, attaches git + ports', async () => {
  const snap = await buildSnapshot({
    sessions: () => [
      { sessionId: 'sess-A', cacheData: { cwd: '/r', fileMtime: 1000, isActive: true, title: 'A' } },
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
  assert.deepEqual(a.openChanges, ['a.ts']);
  const c = snap.sessions.find((s) => s.sessionId === 'session_cloud1')!;
  assert.equal(c.managed, null);
  assert.equal(c.transport, 'cloud');
  assert.deepEqual(snap.ports, [{ port: 5432, proto: 'tcp', pid: 9, proc: 'postgres' }]);
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
