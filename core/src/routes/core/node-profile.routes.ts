/** Node-profile registry + node selection routes.
 *
 *  READS are served from the local replica (the registry is a fleet-synced dataset).
 *  WRITES are origin-anchored like the other registries — the store handles that.
 *
 *  `/node-select` composes the LEARNED layer (profiles) with the OBSERVED layer
 *  (node-facts, read live) through the pure ranker, and returns EVERY node considered
 *  — eligible ones first, eliminated ones carrying `blockers[]`. A bare list of
 *  survivors would read as "these are all the options" when it is really "these are
 *  the ones that passed checks you cannot see". */
import type { RouteHandler } from '../index';
import { getNodeProfile, listNodeProfiles, putNodeProfile, profilesByNode } from '../../mcp-server/registry/node-profile-store';
import { rankNodes, pickDeterministic, type Need, type NodeFacts } from '../../fleet/node-rank';
import { collectNodeFacts } from '../../fleet/node-facts';
import { resolveMcpActor } from '../../mission/mission-actor';
import type { MissionActor } from '../../mission/mission-model';

type Envelope = { success: true; data: unknown } | { success: false; error: { code: string; message: string } };
const ok = (data: unknown): Envelope => ({ success: true, data });
const fail = (code: string, message: string): Envelope => ({ success: false, error: { code, message } });

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const arr = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : undefined);

async function actorFor(b: Record<string, unknown>): Promise<MissionActor> {
  const hint = b._actor as { channel?: string; toolUseId?: string | null } | undefined;
  delete (b as Record<string, unknown>)._actor;
  const { thisNode } = require('../../mission/mission-store') as typeof import('../../mission/mission-store');
  return resolveMcpActor(hint?.toolUseId ?? null, thisNode(), Date.now());
}

/** Live facts for the current cluster. Best-effort per source — see node-facts. */
export async function liveFacts(): Promise<{ facts: NodeFacts[]; degraded: string[] }> {
  const { getComposed } = require('../../fleet/footprint-compose') as typeof import('../../fleet/footprint-compose');
  const { composeDeps } = require('./fleet.routes') as typeof import('./fleet.routes');
  const { getClusterRecords } = require('../../cluster/cluster-store') as typeof import('../../cluster/cluster-store');
  const { getMyCluster } = require('../../cluster/cluster-config') as typeof import('../../cluster/cluster-config');
  const { clusterOf } = require('../../cluster/cluster-map') as typeof import('../../cluster/cluster-map');
  const { thisNode, listMissions } = require('../../mission/mission-store') as typeof import('../../mission/mission-store');

  let records: Awaited<ReturnType<typeof getClusterRecords>> = [];
  try { records = await getClusterRecords(); } catch { /* cluster map cold — clusterOf falls back */ }
  const self = thisNode();
  const myCluster = getMyCluster();

  return collectNodeFacts({
    composed: async () => getComposed('cluster', composeDeps()) as never,
    clusterOf: (id) => clusterOf(id, records, self, myCluster),
    myCluster: () => myCluster,
    selfId: () => self,
    // EXHAUSTIVE for this node only — the projects service enumerates every project
    // Claude Code knows here, which is what makes "repo absent" provable locally.
    localRepos: async () => {
      const { getProjectsService } = require('../../projects-service') as typeof import('../../projects-service');
      return getProjectsService().listProjects({ includeSize: false })
        .map((p) => p.path)
        .filter((p): p is string => !!p);
    },
    // The full roster, so out-of-cluster nodes appear with a reason instead of vanishing.
    knownNodes: async () => records.map((r) => ({
      nodeId: r.gatewayId,
      hostname: (r as { hostname?: string }).hostname,
      cluster: r.cluster,
    })),
    missionsBySession: async () => {
      const map = new Map<string, { resources?: string[]; exclusive?: boolean }>();
      for (const m of await listMissions()) map.set(m.id, { resources: m.env.resources, exclusive: m.env.exclusive });
      return map;
    },
  });
}

/** Build the Need for a mission, so `node_select({missionId})` ranks for real work. */
async function needForMission(id: string): Promise<Need | null> {
  const { getMission } = require('../../mission/mission-store') as typeof import('../../mission/mission-store');
  const m = await getMission(id);
  if (!m) return null;
  return {
    missionId: m.id,
    repo: m.env.repo,
    branch: m.env.branch ?? `mission/${m.id}`,
    resources: m.env.resources,
    exclusive: m.env.exclusive,
    // A mission's declared resources double as capability needs — `port:3000` or
    // `claudeai-cookie` mean the same thing to the ranker as to a human reading them.
    need: m.env.resources ?? [],
  };
}

export async function handleNodeSelect(b: Record<string, unknown>): Promise<Envelope> {
  const missionId = str(b.missionId);
  let need: Need = {
    need: arr(b.need) ?? [],
    repo: str(b.repo),
    branch: str(b.branch),
    resources: arr(b.resources),
  };
  if (missionId) {
    const mn = await needForMission(missionId);
    if (!mn) return fail('MISSION_NOT_FOUND', `no mission ${missionId}`);
    // Explicit args refine the mission's own need rather than replacing it.
    need = { ...mn, ...(arr(b.need)?.length ? { need: [...(mn.need ?? []), ...arr(b.need)!] } : {}) };
  }

  const { facts, degraded } = await liveFacts();
  const profiles = profilesByNode(await listNodeProfiles().catch(() => []));
  const candidates = rankNodes(need, facts, profiles, { includeNotes: true });
  const eligible = candidates.filter((c) => c.blockers.length === 0);

  // 🔴 A recommendation that does not actually claim the required trait must SAY SO.
  // Measured on prod: asking for `elevated-worker` recommended the only in-cluster
  // node, which does not have it — "recommended" read as "yes, this node can do it".
  // Being the best of one is not the same as being able.
  const top = eligible[0];
  const unmetOnTop = top?.unmetNeeds ?? [];

  return ok({
    need,
    // Both lists, always: `eligible` for the decision, `candidates` so a refusal or a
    // surprising pick can be explained without a second call.
    eligible: eligible.map((c) => c.node),
    recommended: top?.node ?? null,
    ...(unmetOnTop.length
      ? {
        warning: `the recommended node has NO declared capability for: ${unmetOnTop.join(', ')}. It is the best AVAILABLE node, not a node known to satisfy this work. Verify before relying on it — and once you know, record it with node_profile so the next caller does not have to.`,
        unmetNeeds: unmetOnTop,
      }
      : {}),
    candidates,
    ...(degraded.length ? { degraded } : {}),
    ...(eligible.length === 0
      ? { hint: 'No node is eligible. Read each candidate\'s blockers[] — the usual causes are an out-of-cluster host, an offline node, or a profile `avoid` entry matching this work.' }
      : {}),
  });
}

/** The deterministic pick, exposed for the supervisor safety net (notes excluded). */
export async function selectDeterministic(need: Need): Promise<{ node: string; why: string[] } | null> {
  const { facts } = await liveFacts();
  const profiles = profilesByNode(await listNodeProfiles().catch(() => []));
  const c = pickDeterministic(need, facts, profiles);
  return c ? { node: c.node, why: c.why } : null;
}

export function createNodeProfileRoutes(): RouteHandler[] {
  return [
    {
      method: 'GET',
      pattern: /^\/node-profiles$/,
      handler: async () => {
        const docs = await listNodeProfiles();
        return ok({
          total: docs.length,
          profiles: docs,
          ...(docs.length === 0
            ? { hint: 'No node profiles yet. This registry is TAUGHT: when you learn what a node is good or bad for, write it back with node_profile so the next placement starts from that lesson.' }
            : {}),
        }) as never;
      },
    },
    {
      method: 'GET',
      pattern: /^\/node-profiles\/(?<id>[^/]+)$/,
      handler: async (req) => {
        const doc = await getNodeProfile(req.params.id);
        // Absent is NOT an error: a node with no profile is one nothing has been
        // learned about yet, which is the normal starting state for the whole fleet.
        return ok(doc ?? { name: req.params.id, capabilities: [], avoid: [], weight: 0, notes: '', rev: 0, unprofiled: true }) as never;
      },
    },
    {
      method: 'PUT',
      pattern: /^\/node-profiles\/(?<id>[^/]+)$/,
      handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const who = await actorFor(b);
        const patch: Record<string, unknown> = {};
        if (b.capabilities !== undefined) patch.capabilities = arr(b.capabilities) ?? b.capabilities;
        if (b.avoid !== undefined) patch.avoid = arr(b.avoid) ?? b.avoid;
        if (b.weight !== undefined) patch.weight = typeof b.weight === 'string' ? Number(b.weight) : b.weight;
        if (b.notes !== undefined) patch.notes = b.notes;
        if (Object.keys(patch).length === 0) {
          return fail('NOTHING_TO_WRITE', 'supply at least one of capabilities, avoid, weight, notes') as never;
        }
        try {
          const r = await putNodeProfile(req.params.id, patch as never, who);
          return ok({ profile: r.doc, changed: r.changed }) as never;
        } catch (e) {
          const err = e as Error & { code?: string };
          return fail(err.code ?? 'WRITE_FAILED', err.message) as never;
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/node-select$/,
      handler: async (req) => handleNodeSelect((req.body || {}) as Record<string, unknown>) as never,
    },
  ];
}
