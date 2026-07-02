/** Deps-injected resolvers — pure decision logic, IO injected (spec N3 table). */
import type { Resolver, Location } from './resolution-service';

const CLOUD_SESSION_RE = /^(session_|cse_)/;

export function buildSessionResolver(deps: {
  isLocal(id: string): Promise<boolean>;
  selfNode(): string;
  peerNodes(): Promise<string[]>;
  probe(node: string, id: string): Promise<boolean>;
}): Resolver {
  return {
    kind: 'session',
    async resolve(id: string): Promise<Location | null> {
      if (CLOUD_SESSION_RE.test(id)) return { cloud: true };
      if (await deps.isLocal(id).catch(() => false)) return { node: deps.selfNode() };
      const peers = await deps.peerNodes().catch(() => [] as string[]);
      for (const node of peers) {
        if (await deps.probe(node, id).catch(() => false)) return { node };
      }
      return null;
    },
  };
}

export function buildDatasetResolver(deps: { ownerOf(id: string): string | null }): Resolver {
  return {
    kind: 'dataset',
    async resolve(id: string): Promise<Location | null> {
      const owner = deps.ownerOf(id);
      return owner ? { node: owner } : null;
    },
  };
}

export function buildRoleResolver(deps: { leader(): Promise<string | null> }): Resolver {
  return {
    kind: 'role',
    async resolve(id: string): Promise<Location | null> {
      if (id !== 'leader') return null;
      const n = await deps.leader().catch(() => null);
      return n ? { node: n } : null;
    },
  };
}

/** Missions are leader-anchored (mission.routes proxies writes to the leader),
 *  so a mission's operating node IS the current leader — provided it exists. */
export function buildMissionResolver(deps: { exists(id: string): Promise<boolean>; leader(): Promise<string | null> }): Resolver {
  return {
    kind: 'mission',
    async resolve(id: string): Promise<Location | null> {
      if (!(await deps.exists(id).catch(() => false))) return null;
      const n = await deps.leader().catch(() => null);
      return n ? { node: n } : null;
    },
  };
}
