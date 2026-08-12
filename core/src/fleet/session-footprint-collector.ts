import type { NodeFootprint, SessionFootprint, PortHold } from './footprint-types';
import { collectGitState } from './git-survey';
import { collectPorts } from './port-survey';
import { runCmd } from './run-cmd';

const RECENT_MS = 30 * 60 * 1000;
const ACTIVE_MS = 5 * 60 * 1000;
const CAP_SESSIONS = 15;
const GIT_PARALLEL = 4;

function relAge(ms: number, now: number): string {
  const age = now - ms;
  if (age < 60_000) return 'just now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  return `${Math.floor(age / 86_400_000)}d ago`;
}

export interface BuildDeps {
  sessions: () => Array<{ sessionId: string; cacheData: { cwd?: string; fileMtime?: number; customTitle?: string; slug?: string } }>;
  bound: () => Promise<Map<string, string>>;                 // sessionId/cse/sid → missionId
  identity: () => { node: string; host: string; cluster: string };
  gitFor: (cwd: string) => Promise<Awaited<ReturnType<typeof collectGitState>>>;
  ports: () => Promise<PortHold[]>;
  now: () => number;
}

export async function buildSnapshot(deps: BuildDeps): Promise<NodeFootprint> {
  const id = deps.identity();
  const now = deps.now();
  const recent = deps.sessions()
    .filter((s) => (s.cacheData?.fileMtime ?? 0) >= now - RECENT_MS)
    .sort((a, b) => (b.cacheData?.fileMtime ?? 0) - (a.cacheData?.fileMtime ?? 0))
    .slice(0, CAP_SESSIONS);

  const [boundMap, ports] = await Promise.all([deps.bound().catch(() => new Map<string, string>()), deps.ports().catch(() => [] as PortHold[])]);

  // Dedupe git scans by cwd, bounded parallelism.
  const cwds = Array.from(new Set(recent.map((s) => s.cacheData?.cwd).filter((c): c is string => !!c)));
  const gitByCwd = new Map<string, Awaited<ReturnType<typeof collectGitState>>>();
  for (let i = 0; i < cwds.length; i += GIT_PARALLEL) {
    const batch = cwds.slice(i, i + GIT_PARALLEL);
    const res = await Promise.all(batch.map((c) => deps.gitFor(c).catch(() => null)));
    batch.forEach((c, j) => { if (res[j]) gitByCwd.set(c, res[j]!); });
  }

  // Collapse openChanges to once per worktree: sessions sharing a worktree carry an identical (and
  // potentially long) list, so keep it on the first (most-recent — `recent` is sorted desc) session
  // and have siblings reference it. The git block stays per-session, so collision detection is intact.
  const canonicalByWorktree = new Map<string, string>();
  const sessions: SessionFootprint[] = recent.map((s) => {
    const cwd = s.cacheData?.cwd ?? '';
    const g = (cwd && gitByCwd.get(cwd)) || { git: { branch: null, worktree: null, upstream: null, ahead: 0, dirty: 0, pushed: false }, openChanges: [], openChangesTruncated: false, repo: null };
    const cloud = /^(session_|cse_)/.test(s.sessionId);
    let openChanges = g.openChanges;
    let openChangesTruncated = g.openChangesTruncated;
    let openChangesSharedWith: string | undefined;
    const wt = g.git.worktree;
    if (wt && openChanges.length > 0) {
      const canonical = canonicalByWorktree.get(wt);
      if (canonical) { openChanges = []; openChangesTruncated = false; openChangesSharedWith = canonical; }
      else canonicalByWorktree.set(wt, s.sessionId);
    }
    return {
      cluster: id.cluster, node: id.node, host: id.host,
      sessionId: s.sessionId, title: s.cacheData?.customTitle ?? s.cacheData?.slug,
      transport: cloud ? 'cloud' : 'native',
      managed: boundMap.get(s.sessionId) ?? null,
      cwd, repo: g.repo, git: g.git,
      openChanges, openChangesTruncated,
      ...(openChangesSharedWith ? { openChangesSharedWith } : {}),
      lastActiveRel: relAge(s.cacheData?.fileMtime ?? now, now), isActive: (now - (s.cacheData?.fileMtime ?? 0)) < ACTIVE_MS,
    };
  });

  return { node: id.node, cluster: id.cluster, host: id.host, snapshotAgeSec: 0, reachable: true, warming: false, stale: false, sessions, ports };
}

export function createLocalFootprintCache(
  build: () => Promise<NodeFootprint>,
  identity: () => { node: string; host: string; cluster: string },
  opts: { ttlMs?: number; warmMs?: number; now?: () => number } = {},
) {
  const ttlMs = opts.ttlMs ?? 10_000;
  const warmMs = opts.warmMs ?? 120_000;
  const now = opts.now ?? Date.now;
  let snapshot: NodeFootprint | null = null;
  let snapshotAt = 0;
  let inFlight: Promise<void> | null = null;
  let lastAccess = 0;
  let timer: NodeJS.Timeout | null = null;

  function kickRefresh(): void {
    if (inFlight) return; // single-flight
    inFlight = build()
      .then((s) => { snapshot = s; snapshotAt = now(); })
      .catch(() => { /* best-effort; keep last snapshot */ })
      .finally(() => { inFlight = null; });
  }

  function ensureWarm(): void {
    if (timer) return;
    timer = setInterval(() => {
      if (now() - lastAccess > warmMs) { if (timer) { clearInterval(timer); timer = null; } return; }
      if (!snapshot || now() - snapshotAt >= ttlMs) kickRefresh();
    }, Math.max(1000, Math.floor(ttlMs * 1.5)));
    if (timer.unref) timer.unref();
  }

  function get(): NodeFootprint {
    lastAccess = now();
    ensureWarm();
    const id = identity();
    if (!snapshot) { kickRefresh(); return { node: id.node, cluster: id.cluster, host: id.host, snapshotAgeSec: 0, reachable: true, warming: true, stale: true, sessions: [], ports: [] }; }
    const ageSec = Math.floor((now() - snapshotAt) / 1000);
    const stale = now() - snapshotAt >= ttlMs;
    if (stale) kickRefresh();
    return { ...snapshot, snapshotAgeSec: ageSec, stale, warming: false };
  }

  return { get, kickRefresh, dispose: () => { if (timer) { clearInterval(timer); timer = null; } } };
}

// ── Module singleton wired at runtime (real deps) ──
let _cache: ReturnType<typeof createLocalFootprintCache> | null = null;
export function getLocalSnapshot(): NodeFootprint {
  if (!_cache) {
    const { getSessionCache } = require('../session-cache') as typeof import('../session-cache');
    const { getHubConfig } = require('../hub-client/hub-config') as typeof import('../hub-client/hub-config');
    const { getMyCluster } = require('../cluster/cluster-config') as typeof import('../cluster/cluster-config');
    const { listBoundMissions, thisNode } = require('../mission/mission-store') as typeof import('../mission/mission-store');
    const gitCache = new Map<string, { at: number; v: Awaited<ReturnType<typeof collectGitState>> }>();
    const build = () => buildSnapshot({
      sessions: () => getSessionCache().getAllSessionsFromCache(),
      bound: async () => {
        // Deliberately listBoundMissions, not listActiveMissions: occupancy reporting must
        // see standby missions too (a human running the session is MORE spoken-for, not
        // less) — see selectBound's doc comment in mission-store.ts.
        const map = new Map<string, string>();
        for (const m of await listBoundMissions().catch(() => [])) {
          const b = m.binding; if (!b) continue;
          if (b.sessionId) map.set(b.sessionId, m.id);
          const ccr = (b as any).ccr; if (ccr?.cse) map.set(ccr.cse, m.id); if (ccr?.sid) map.set(ccr.sid, m.id);
        }
        return map;
      },
      identity: () => ({ node: thisNode(), host: getHubConfig().hostname || thisNode(), cluster: getMyCluster() }),
      gitFor: async (cwd) => {
        const hit = gitCache.get(cwd); const t = Date.now();
        if (hit && t - hit.at < 10_000) return hit.v;
        const v = await collectGitState(cwd, runCmd); gitCache.set(cwd, { at: t, v }); return v;
      },
      ports: () => collectPorts(runCmd, process.platform),
      now: Date.now,
    });
    _cache = createLocalFootprintCache(build, () => ({ node: thisNode(), host: getHubConfig().hostname || thisNode(), cluster: getMyCluster() }));
  }
  return _cache.get();
}
