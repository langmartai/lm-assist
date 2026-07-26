/**
 * Node facts — the OBSERVED layer of node selection, read LIVE on every call.
 *
 * Everything here is deliberately re-derived rather than stored: online status,
 * cluster membership, repos present, and current occupancy all change on their own,
 * and a cached placement fact is worse than a missing one because it is confidently
 * wrong in the direction of "yes, put work there". The LEARNED layer (what Core
 * cannot observe) lives in the `node-profiles` registry instead.
 *
 * Sources, all already existing:
 *   • `getComposed()` (session_footprints)  — reachability, cluster, host, and what
 *     each node is currently occupied with (repo/branch/session/managed).
 *   • the cluster map                        — in-cluster scoping for placement.
 *   • the local project list                 — an EXHAUSTIVE repo inventory, but only
 *                                              for THIS node.
 *
 * 🔴 Repo inventory is exhaustive ONLY for self. For peers we can prove a repo is
 * PRESENT (a session is open in it) but never that one is ABSENT, so peers are marked
 * `reposComplete:false` and the ranker refuses to eliminate on a partial list. Failing
 * closed on a signal that is merely missing would eliminate the whole fleet the first
 * time a probe degraded.
 */
import type { NodeFacts } from './node-rank';

export interface FactsDeps {
  /** Composed footprints for the scope (session_footprints' own compose step). */
  composed: () => Promise<{
    nodes: Array<{
      node: string; cluster: string; host: string; reachable: boolean; warming?: boolean;
      sessions: Array<{ sessionId: string; repo: string | null; managed: string | null; git?: { branch: string | null } }>;
    }>;
    unreachable: string[];
    partial: boolean;
  }>;
  /** gatewayId → cluster for every known node, plus this node's own identity. */
  clusterOf: (nodeId: string) => string;
  myCluster: () => string;
  selfId: () => string | null;
  /** Absolute repo paths on THIS node — exhaustive. */
  localRepos: () => Promise<string[]>;
  /** Mission records, for resource/exclusivity held by each bound session. */
  missionsBySession?: () => Promise<Map<string, { resources?: string[]; exclusive?: boolean }>>;
}

/**
 * Collect facts for every node in scope.
 *
 * Best-effort PER SOURCE: a failing probe degrades that one signal and is reported in
 * `degraded[]`, it never sinks selection. Placement must not stop because one read
 * timed out — that would turn a slow peer into a fleet-wide outage.
 */
export async function collectNodeFacts(deps: FactsDeps): Promise<{ facts: NodeFacts[]; degraded: string[] }> {
  const globalDegraded: string[] = [];
  const self = deps.selfId();
  const myCluster = deps.myCluster();

  let composed: Awaited<ReturnType<FactsDeps['composed']>> | null = null;
  try {
    composed = await deps.composed();
  } catch (e) {
    globalDegraded.push(`footprints unavailable: ${(e as Error)?.message?.slice(0, 120) ?? 'error'}`);
  }

  let localRepos: string[] = [];
  let localReposOk = false;
  try {
    localRepos = await deps.localRepos();
    localReposOk = true;
  } catch (e) {
    globalDegraded.push(`local repo inventory unavailable: ${(e as Error)?.message?.slice(0, 120) ?? 'error'}`);
  }

  let missionBySession = new Map<string, { resources?: string[]; exclusive?: boolean }>();
  if (deps.missionsBySession) {
    try {
      missionBySession = await deps.missionsBySession();
    } catch {
      globalDegraded.push('mission resource map unavailable — resource conflicts not evaluated');
    }
  }

  const facts: NodeFacts[] = [];
  const seen = new Set<string>();

  for (const n of composed?.nodes ?? []) {
    seen.add(n.node);
    const isSelf = !!self && n.node === self;
    const degraded: string[] = [];
    if (n.warming) degraded.push('footprint snapshot still warming');

    // Repos: exhaustive for self; for peers only what sessions prove is present.
    const observed = n.sessions.map((s) => s.repo).filter((r): r is string => !!r);
    const repos = isSelf && localReposOk
      ? [...new Set([...localRepos, ...observed])]
      : [...new Set(observed)];
    if (isSelf && !localReposOk) degraded.push('local repo inventory failed — treated as partial');

    facts.push({
      nodeId: n.node,
      hostname: n.host,
      online: n.reachable,
      cluster: n.cluster || deps.clusterOf(n.node),
      inCluster: (n.cluster || deps.clusterOf(n.node)) === myCluster,
      repos,
      reposComplete: isSelf && localReposOk,
      branches: [...new Set(n.sessions.map((s) => s.git?.branch).filter((b): b is string => !!b))],
      occupancy: n.sessions.map((s) => {
        const m = s.managed ? missionBySession.get(s.managed) : undefined;
        return {
          sessionId: s.sessionId,
          repo: s.repo ?? undefined,
          branch: s.git?.branch ?? undefined,
          managed: s.managed,
          resources: m?.resources,
          exclusive: m?.exclusive,
        };
      }),
      ...(degraded.length ? { degraded } : {}),
    });
  }

  // An unreachable peer must still APPEAR, marked offline with a reason. Omitting it
  // would make "why wasn't node X considered?" unanswerable — the node would simply
  // not exist in the answer, which reads as "there is no such node".
  for (const id of composed?.unreachable ?? []) {
    if (seen.has(id)) continue;
    const cluster = deps.clusterOf(id);
    facts.push({
      nodeId: id,
      online: false,
      cluster,
      inCluster: cluster === myCluster,
      degraded: ['unreachable — no footprint snapshot'],
    });
  }

  return { facts, degraded: globalDegraded };
}
