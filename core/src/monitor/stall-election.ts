/** Single-monitor election by deterministic convention over the hub's online-node set. */
import { getHubConfig } from '../hub-client/hub-config';
import { listOnlineNodeIds } from '../data/peer-client';

/** Pure: true iff `selfId` is the lowest id among the online candidates (self always a candidate). */
export function electMonitor(onlineNodeIds: string[], selfId: string | null): boolean {
  if (!selfId) return false;
  const candidates = onlineNodeIds.includes(selfId) ? onlineNodeIds.slice() : [...onlineNodeIds, selfId];
  candidates.sort();
  return candidates.length > 0 && candidates[0] === selfId;
}

/** IO: resolve this node's id + the online set and decide. On hub error, NOT monitor
 *  (so a hub blip can't make every node scan remotes). */
export async function amIMonitor(): Promise<{ isMonitor: boolean; monitorNodeId: string | null; selfId: string | null }> {
  const selfId = getHubConfig().gatewayId;
  let online: string[];
  try {
    online = await listOnlineNodeIds();
  } catch {
    return { isMonitor: false, monitorNodeId: null, selfId };
  }
  const candidates = (online.includes(selfId || '') ? online.slice() : [...online, selfId || '']).filter(Boolean).sort();
  const monitorNodeId = candidates[0] ?? null;
  return { isMonitor: !!selfId && monitorNodeId === selfId, monitorNodeId, selfId };
}
