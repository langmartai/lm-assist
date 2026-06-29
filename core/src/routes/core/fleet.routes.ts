import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse } from '../../api/helpers';
import { getLocalSnapshot } from '../../fleet/session-footprint-collector';
import { getComposed, type ComposeDeps } from '../../fleet/footprint-compose';
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
  ];
}
