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
  /** epoch ms of the last SUCCESSFUL cloud fetch (self or peer) — lets the UI age-gate its warning. */
  cloudFetchedAt?: number | null;
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

  // Best-effort session NAMES: the cc list only knows ids/cwds, but the
  // projects service already holds each session's rename/auto-summary/slug
  // (its getAllSessions is file-change-cache'd — cheap on this 5s path).
  try {
    const { getProjectsService } = require('../projects-service') as typeof import('../projects-service');
    locals = applyLocalSessionTitles(locals, getProjectsService().getAllSessions({}) as unknown[]);
  } catch { /* naming is decorative — never fail the snapshot */ }

  return { node, remotes, rc: { controller, executors, accountRc: [] }, locals, collectedAt: Date.now() };
}

/**
 * Pure: join display names onto cc-session items from the project sessions
 * list. Preference: user rename (customTitle) → auto summary → slug.
 */
export function applyLocalSessionTitles(locals: unknown[], projectSessions: unknown[]): unknown[] {
  const meta = new Map<string, { customTitle?: string; sessionSummary?: string; slug?: string; projectName?: string }>();
  for (const p of projectSessions as Array<{ sessionId?: string } & Record<string, unknown>>) {
    if (p?.sessionId) meta.set(p.sessionId, p as never);
  }
  return locals.map((l) => {
    const item = l as { sessionId?: string } & Record<string, unknown>;
    const m = item?.sessionId ? meta.get(item.sessionId) : undefined;
    if (!m) return l;
    const title = m.customTitle || m.sessionSummary || m.slug;
    return { ...item, ...(title ? { title } : {}), ...(m.projectName ? { projectName: m.projectName } : {}) };
  });
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
// Last cloud list that came back successfully (+ when). The account API is
// polled every 5s and intermittently fails under OAuth token rotation /
// upstream blips; serving the last-good list on error keeps the page's
// content from flapping to empty. The cloud list is ACCOUNT-wide, so when
// this node's fetch fails a PEER with healthy credentials can supply the
// same list (`/ccr/cloud` is relay-allowed) — self → peer → last-good.
let _lastGoodCloud: unknown[] | null = null;
let _lastGoodCloudAt: number | null = null;

/** Unwrap a peer's GET /ccr/cloud envelope ({success,data:{sessions}}) → sessions[] or null. */
export function peerCloudSessions(res: unknown): unknown[] | null {
  const body = (res as { data?: unknown })?.data ?? res;
  const sessions = (body as { sessions?: unknown })?.sessions;
  return Array.isArray(sessions) ? sessions : null;
}

export async function getCcrFleet(deps: CcrFleetDeps): Promise<CcrFleetView> {
  const t = deps.now();
  if (_cache && t - _cache.at < COMPOSED_TTL_MS) return _cache.value;

  const selfId = deps.selfId();
  let cloudError: string | null = null;
  const [self, selfCloud, online] = await Promise.all([
    deps.getLocal(),
    deps.getCloud().catch((e) => { cloudError = String((e as Error)?.message || e); return null; }),
    deps.listOnline().catch(() => [] as string[]),
  ]);
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

  // Cloud-list fallback chain: self → first reachable peer's /ccr/cloud → last-good.
  let cloudFresh = selfCloud;
  if (!cloudFresh) {
    for (const p of peers) {
      if (!p.snap) continue; // peer already proved unreachable
      try {
        const sessions = peerCloudSessions(await withTimeout(deps.proxyGet(p.node, '/ccr/cloud'), PEER_TIMEOUT_MS));
        if (sessions) { cloudFresh = sessions; cloudError = null; break; }
      } catch { /* try the next peer */ }
    }
  }
  if (cloudFresh) { _lastGoodCloud = cloudFresh; _lastGoodCloudAt = deps.now(); }
  const cloud = cloudFresh ?? _lastGoodCloud ?? [];

  const value = mergeCcrFleet(self, cloud, peers, selfId, deps.now());
  if (cloudError) value.cloudError = cloudError;
  value.cloudFetchedAt = _lastGoodCloudAt;
  _cache = { at: t, value };
  return value;
}

/** Test hook — the composed cache is module-global. */
export function _resetCcrFleetCache(): void { _cache = null; _lastGoodCloud = null; _lastGoodCloudAt = null; }

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
