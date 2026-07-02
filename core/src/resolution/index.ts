/** Singleton wired with real deps. Lazy requires — each dep reads files/config at call time. */
import { ResolutionService } from './resolution-service';
import { buildSessionResolver, buildDatasetResolver, buildRoleResolver, buildMissionResolver } from './resolvers';

let svc: ResolutionService | null = null;

export function getResolutionService(): ResolutionService {
  if (svc) return svc;
  svc = new ResolutionService();

  const leader = async (): Promise<string | null> => {
    const { amIMonitor } = require('../monitor/stall-election') as typeof import('../monitor/stall-election');
    return (await amIMonitor()).monitorNodeId;
  };

  svc.register(buildSessionResolver({
    isLocal: async (id) => {
      const { workerGet } = require('../mcp-server/tools/_passthrough') as typeof import('../mcp-server/tools/_passthrough');
      const res = await workerGet<{ exists?: boolean } | boolean>(`/sessions/${encodeURIComponent(id)}/exists`).catch(() => null);
      return res === true || (typeof res === 'object' && !!res && (res as { exists?: boolean }).exists === true);
    },
    selfNode: () => {
      const { getHubConfig } = require('../hub-client/hub-config') as typeof import('../hub-client/hub-config');
      return getHubConfig().gatewayId ?? 'local';
    },
    peerNodes: async () => {
      const { listOnlineNodeIds } = require('../data/peer-client') as typeof import('../data/peer-client');
      const { getHubConfig } = require('../hub-client/hub-config') as typeof import('../hub-client/hub-config');
      const self = getHubConfig().gatewayId;
      return (await listOnlineNodeIds()).filter((n) => n !== self);
    },
    probe: async (node, id) => {
      const { proxyGet } = require('../data/peer-client') as typeof import('../data/peer-client');
      const json = await proxyGet(node, `/sessions/${encodeURIComponent(id)}/exists`).catch(() => null) as { data?: { exists?: boolean }; exists?: boolean } | null;
      return json?.data?.exists === true || json?.exists === true;
    },
  }));

  svc.register(buildDatasetResolver({
    ownerOf: (id) => {
      const { getDatasetRegistry } = require('../data/dataset-registry') as typeof import('../data/dataset-registry');
      return getDatasetRegistry().get(id)?.ownerNode ?? null;
    },
  }));

  svc.register(buildRoleResolver({ leader }));

  svc.register(buildMissionResolver({
    exists: async (id) => {
      const { getMission } = require('../mission/mission-store') as typeof import('../mission/mission-store');
      return (await getMission(id)) !== null;
    },
    leader,
  }));

  return svc;
}
