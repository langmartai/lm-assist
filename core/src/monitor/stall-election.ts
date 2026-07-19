/** Single-monitor election by deterministic convention over the hub's online-node set. */
import { getHubConfig } from '../hub-client/hub-config';
import { listOnlineNodeIdsStrict } from '../data/peer-client';

/** Pure: true iff `selfId` is the lowest id among the online candidates (self always a candidate). */
export function electMonitor(onlineNodeIds: string[], selfId: string | null): boolean {
  if (!selfId) return false;
  const candidates = onlineNodeIds.includes(selfId) ? onlineNodeIds.slice() : [...onlineNodeIds, selfId];
  candidates.sort();
  return candidates.length > 0 && candidates[0] === selfId;
}

export interface MonitorVerdict {
  isMonitor: boolean;
  monitorNodeId: string | null;
  selfId: string | null;
  /** the election inputs were unavailable AND no recent confident answer exists. */
  indeterminate?: boolean;
  /** served from the last confident answer because the inputs are currently unavailable. */
  stale?: boolean;
}

// ── Hysteresis ───────────────────────────────────────────────────────────────
// Election inputs lie for a short window after a core restart: the hub fetch
// throws until the worker socket re-authenticates, and the cluster map can be
// unreadable while the data service warms — which used to pool every node into
// `default` and hand the election to another cluster's lower gateway-id.
// "Can't determine" must NEVER read as a confident "not monitor" — that exact
// coercion tore down a healthy production controller (2026-07-19). So: compute
// fresh when possible (and remember it); on failure serve the last confident
// answer within the window; only with no recent answer say `indeterminate`,
// which consumers treat as "do nothing destructive".
const ELECTION_HYSTERESIS_MS = 10 * 60_000;
let _lastGood: { at: number; v: MonitorVerdict } | null = null;
export function _resetElectionCache(): void { _lastGood = null; }

export async function amIMonitor(
  listFn: () => Promise<string[]> = listOnlineNodeIdsStrict,
  now: () => number = Date.now,
): Promise<MonitorVerdict> {
  const selfId = getHubConfig().gatewayId;
  try {
    const online = await listFn();
    const candidates = (online.includes(selfId || '') ? online.slice() : [...online, selfId || '']).filter(Boolean).sort();
    const monitorNodeId = candidates[0] ?? null;
    const v: MonitorVerdict = { isMonitor: !!selfId && monitorNodeId === selfId, monitorNodeId, selfId };
    _lastGood = { at: now(), v };
    return v;
  } catch {
    if (_lastGood && now() - _lastGood.at < ELECTION_HYSTERESIS_MS) {
      return { ..._lastGood.v, stale: true };
    }
    return { isMonitor: false, monitorNodeId: null, selfId, indeterminate: true };
  }
}
