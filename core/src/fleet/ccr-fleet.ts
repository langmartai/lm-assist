/**
 * CCR fleet aggregate — ONE call for everything the /ccr page renders.
 *
 * The web UI used to poll 4 endpoints (cloud / remote / remote-control /
 * cc-sessions) against ONE node (whichever the machine picker targeted), so
 * the page could never see the whole fleet and every extra node would have
 * made the browser chattier. Core composes the view instead:
 *
 *   GET /fleet/ccr/local → this node's snapshot: CCR bridges + rc
 *       (controller/executors) + local cc-sessions. Local reads only — NO
 *       claude.ai calls. accountRc stays empty here: it is account-wide (the
 *       enriched cloud list already covers those sessions) and per-node
 *       copies would just be N duplicate upstream calls.
 *   GET /fleet/ccr → enriched cloud list (once, account-wide) + self snapshot
 *       + every online peer's /fleet/ccr/local via the hub machine-proxy
 *       (session-footprints pattern). Fleet-scoped on purpose: sessions are
 *       shared fleet-wide — clusters partition placement/election, not
 *       session visibility.
 */
import { proxyGet, listAllOnlineNodeIds } from '../data/peer-client';

export interface CcrNodeSnapshot {
  node: string;
  remotes: unknown[];
  rc: { controller: unknown | null; executors: unknown[]; accountRc: unknown[] };
  locals: unknown[];
  collectedAt: number;
}

export interface CcrFleetView {
  generatedAt: number;
  /** this (aggregating) node's id — rows from it are "local" to the caller. */
  self: string;
  /** account-wide enriched cloud/bridge sessions (cloudListEnriched). */
  cloud: unknown[];
  nodes: CcrNodeSnapshot[];
  unreachable: string[];
  partial: boolean;
  /** why the cloud list is empty/stale, when it failed (surfaced to the UI). */
  cloudError?: string | null;
}

const PEER_TIMEOUT_MS = 2500;
const COMPOSED_TTL_MS = 4000; // the web polls every 5s — each poll recomposes, bursts coalesce

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`peer timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** This node's CCR snapshot — every sub-source degrades to empty, never throws. */
export async function collectLocalCcrSnapshot(): Promise<CcrNodeSnapshot> {
  const { thisNode } = require('../mission/mission-store') as typeof import('../mission/mission-store');
  const node = thisNode();

  let remotes: unknown[] = [];
  try {
    const ccr = require('../terminal/ccr-manager') as typeof import('../terminal/ccr-manager');
    remotes = ccr.list();
  } catch { /* registry unavailable — no bridges */ }

  let controller: unknown | null = null;
  let executors: unknown[] = [];
  try {
    const { getControllerSession, listMissions } = require('../mission/mission-store') as typeof import('../mission/mission-store');
    const { missionSessionTitle } = require('../mission/mission-model') as typeof import('../mission/mission-model');
    const c = await getControllerSession().catch(() => null);
    if (c) controller = { sid: c.sessionId, cse: c.cse, tmux: c.tmux, node: c.node, title: 'Mission Controller', startedAt: c.startedAt };
    const missions = await listMissions().catch(() => []);
    executors = missions
      .filter((m: any) => m?.binding?.sessionId)
      .map((m: any) => ({
        sid: m.binding.sessionId as string,
        cse: (m.binding.ccr?.sid ?? null) as string | null,
        title: missionSessionTitle(m),
        missionId: m.id as string,
        status: m.status as string,
      }));
  } catch { /* mission store unavailable */ }

  let locals: unknown[] = [];
  try {
    const { getCcController } = require('../terminal/backend') as typeof import('../terminal/backend');
    const cc = getCcController();
    const sessions = await cc.list();
    // Same verdict trim as GET /terminal/cc-sessions — keep only the verdict's
    // new fields; the session already carries id/jsonl/owner/tmux.
    locals = sessions.map((s: any) => {
      const v = cc.verdict(s.sessionId);
      return {
        ...s,
        verdict: {
          live: v.live,
          allowedModes: v.allowedModes,
          connectStrategy: v.connectStrategy,
          safeToCreateTmux: v.safeToCreateTmux,
          reason: v.reason,
        },
      };
    });
  } catch { /* terminal backend unavailable on this platform */ }

  return { node, remotes, rc: { controller, executors, accountRc: [] }, locals, collectedAt: Date.now() };
}

export interface CcrFleetDeps {
  getLocal: () => Promise<CcrNodeSnapshot>;
  getCloud: () => Promise<unknown[]>;
  listOnline: () => Promise<string[]>;
  selfId: () => string;
  proxyGet: (node: string, path: string) => Promise<unknown>;
  now: () => number;
}

/** Pure merge — self snapshot first, reachable peers after, unreachable listed. */
export function mergeCcrFleet(
  self: CcrNodeSnapshot,
  cloud: unknown[],
  peers: Array<{ node: string; snap: CcrNodeSnapshot | null }>,
  selfId: string,
  now: number,
): CcrFleetView {
  const nodes: CcrNodeSnapshot[] = [self];
  const unreachable: string[] = [];
  for (const p of peers) {
    if (p.snap) nodes.push(p.snap);
    else unreachable.push(p.node);
  }
  return { generatedAt: now, self: selfId, cloud, nodes, unreachable, partial: unreachable.length > 0 };
}

let _cache: { at: number; value: CcrFleetView } | null = null;
// Last cloud list that came back successfully. The account API is polled every
// 5s and intermittently 401s under OAuth token rotation (multiple processes
// share the credentials file); serving the last-good list on error keeps the
// page's content from flapping to empty — the error is still surfaced.
let _lastGoodCloud: unknown[] | null = null;

export async function getCcrFleet(deps: CcrFleetDeps): Promise<CcrFleetView> {
  const t = deps.now();
  if (_cache && t - _cache.at < COMPOSED_TTL_MS) return _cache.value;

  const selfId = deps.selfId();
  let cloudError: string | null = null;
  const [self, cloudFresh, online] = await Promise.all([
    deps.getLocal(),
    deps.getCloud().catch((e) => { cloudError = String((e as Error)?.message || e); return null; }),
    deps.listOnline().catch(() => [] as string[]),
  ]);
  if (cloudFresh) _lastGoodCloud = cloudFresh;
  const cloud = cloudFresh ?? _lastGoodCloud ?? [];
  const peerIds = online.filter((n) => n !== selfId);
  const peers = await Promise.all(peerIds.map(async (n) => {
    try {
      const res = (await withTimeout(deps.proxyGet(n, '/fleet/ccr/local'), PEER_TIMEOUT_MS)) as { data?: CcrNodeSnapshot } | CcrNodeSnapshot;
      const snap = (res as any)?.data ?? res;
      return { node: n, snap: snap && typeof (snap as CcrNodeSnapshot).node === 'string' ? (snap as CcrNodeSnapshot) : null };
    } catch {
      return { node: n, snap: null };
    }
  }));

  const value = mergeCcrFleet(self, cloud, peers, selfId, deps.now());
  if (cloudError) value.cloudError = cloudError;
  _cache = { at: t, value };
  return value;
}

/** Test hook — the composed cache is module-global. */
export function _resetCcrFleetCache(): void { _cache = null; _lastGoodCloud = null; }

export function defaultCcrFleetDeps(): CcrFleetDeps {
  return {
    getLocal: collectLocalCcrSnapshot,
    getCloud: async () => {
      const ccrCloud = require('../terminal/ccr-cloud') as typeof import('../terminal/ccr-cloud');
      return (await ccrCloud.cloudListEnriched()) as unknown[];
    },
    listOnline: listAllOnlineNodeIds,
    selfId: () => {
      const { thisNode } = require('../mission/mission-store') as typeof import('../mission/mission-store');
      return thisNode();
    },
    proxyGet,
    now: Date.now,
  };
}
