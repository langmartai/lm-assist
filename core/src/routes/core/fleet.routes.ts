import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse } from '../../api/helpers';
import { getLocalSnapshot } from '../../fleet/session-footprint-collector';
import { getComposed, type ComposeDeps } from '../../fleet/footprint-compose';
import { collectLocalCcrSnapshot, getCcrFleet, defaultCcrFleetDeps } from '../../fleet/ccr-fleet';
import { getCredentialFleet, type CredentialDeps } from '../../fleet/credential-fleet';
import { collectLocalCredential } from '../../fleet/credential-collector';
import { proxyGet, listAllOnlineNodeIds } from '../../data/peer-client';
import { getClusterRecords } from '../../cluster/cluster-store';
import { getMyCluster } from '../../cluster/cluster-config';
import { thisNode } from '../../mission/mission-store'; // exports thisNode()=gatewayId; data/paths only has thisNodeId()

export function composeDeps(): ComposeDeps {
  return {
    getLocal: getLocalSnapshot,
    listOnline: listAllOnlineNodeIds,
    clusterOf: async () => {
      const recs = await getClusterRecords();
      return new Map(recs.map((r) => [r.gatewayId, r.cluster]));
    },
    myCluster: getMyCluster,
    selfId: thisNode,
    proxyGet,
    now: Date.now,
  };
}

export function credentialDeps(): CredentialDeps {
  return {
    getLocal: () => collectLocalCredential(true),
    listOnline: listAllOnlineNodeIds,
    clusterMap: async () => {
      const recs = await getClusterRecords();
      return new Map(recs.map((r) => [r.gatewayId, r.cluster]));
    },
    myCluster: getMyCluster,
    selfId: thisNode,
    proxyGet,
    now: Date.now,
  };
}

export function createFleetRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'GET',
      pattern: /^\/fleet\/session-footprints\/local$/,
      handler: async () => {
        const start = Date.now();
        return wrapResponse(getLocalSnapshot(), start); // sync read — never awaits a collector
      },
    },
    {
      method: 'GET',
      pattern: /^\/fleet\/session-footprints$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        const scope = (req.query?.scope === 'fleet' ? 'fleet' : 'cluster') as 'cluster' | 'fleet';
        return wrapResponse(await getComposed(scope, composeDeps()), start);
      },
    },
    // ── CCR page aggregate: bridges + rc + local cc-sessions, per node ──
    {
      method: 'GET',
      pattern: /^\/fleet\/ccr\/local$/,
      handler: async () => {
        const start = Date.now();
        return wrapResponse(await collectLocalCcrSnapshot(), start);
      },
    },
    {
      method: 'GET',
      pattern: /^\/fleet\/ccr$/,
      handler: async () => {
        const start = Date.now();
        return wrapResponse(await getCcrFleet(defaultCcrFleetDeps()), start);
      },
    },
    // ── claude.ai credential survey: which nodes can actually serve a
    //    cookie-backed call, and for which account. Lives under /fleet because
    //    /claude-ai is deliberately NOT relay-reachable (it can send messages
    //    and delete conversations); this report is read-only and secret-free.
    {
      method: 'GET',
      pattern: /^\/fleet\/credentials\/local$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        // ?probe=false answers without the live claude.ai call (reports
        // `unprobed`, which is never `ok` — only a 200 proves usable).
        const probe = req.query?.probe !== 'false';
        return wrapResponse(await collectLocalCredential(probe), start);
      },
    },
    {
      method: 'GET',
      pattern: /^\/fleet\/credentials$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        const scope = (req.query?.scope === 'cluster' ? 'cluster' : 'fleet') as 'cluster' | 'fleet';
        return wrapResponse(await getCredentialFleet(scope, credentialDeps()), start);
      },
    },
  ];
}
