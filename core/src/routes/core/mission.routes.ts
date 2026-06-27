/** Mission CRUD + controller status. Bare {success,data}/{success,error} envelope (like worker.routes). */
import type { RouteHandler, RouteContext } from '../index';
import { randomBytes } from 'crypto';
import { touchActivity, trackResumedNative } from '../../mission/mission-session-reaper';
import { newMission, Mission, MissionStatus, Isolation, coarseActor, MissionActor, place, ExecutorState, MissionBinding } from '../../mission/mission-model';
import { resolveMcpActor, upgradeControllerActor } from '../../mission/mission-actor';
import { normalizeTags, mergeTags, validateParent, validateDependsOn } from '../../mission/mission-graph';
import {
  MissionDataPort, getMission, listMissions, putMission, thisNode, getControllerSession, listMissionHistory,
} from '../../mission/mission-store';
import { resolveMissionSession, ResolvedSession } from '../../mission/mission-session-resolver';
import type { Transport, SessionRole } from '../../mission/mission-session-resolver';
import { resumeWorker, type ResumeWorkerDeps } from '../../mission/mission-resume';
import { amIMonitor } from '../../monitor/stall-election';
import { getScheduledJobs } from '../../scheduler/scheduled-jobs';
import { listRecords } from '../../worker-role/worker-store';
import type { WorkerRecord } from '../../worker-role/types';
import { filterMissions, FilterError, type MissionFilter, type MissionSort } from '../../mission/mission-filter';
import { neighbors, subgraphEdges, toNode, type Direction, type MissionNode, type MissionEdge } from '../../mission/mission-traverse';
import { newView, normalizeView, validateView, type MissionView } from '../../mission/mission-views';
import { getView, listViews, putView, deleteView, type MissionViewPort } from '../../mission/mission-views-store';
import { computeSchedule } from '../../mission/mission-scheduler';
import { recentExternalChanges } from '../../mission/mission-changes';
import { placementAllowed } from '../../mission/mission-controller';
import { getClusterRecords } from '../../cluster/cluster-store';
import { getMyCluster } from '../../cluster/cluster-config';

interface Envelope { success: boolean; data?: unknown; error?: { code: string; message: string }; }
const ok = <T>(data: T): Envelope => ({ success: true, data });
const fail = (code: string, message: string): Envelope => ({ success: false, error: { code, message } });
const genId = () => 'mission_' + randomBytes(4).toString('hex');
const genViewId = () => 'view_' + randomBytes(4).toString('hex');
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const arr = (v: unknown): string[] | undefined => {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (typeof v === 'string') { try { const j = JSON.parse(v); return Array.isArray(j) ? j.filter((x) => typeof x === 'string') : undefined; } catch { return undefined; } }
  return undefined;
};
const VALID_STATUS = new Set<MissionStatus>(['draft', 'active', 'waiting', 'paused', 'blocked', 'done', 'failed']);

// --- leader-anchoring (missions live on the elected leader) ---
// Missions must live on the leader's store: the leader's supervisor drives them
// and every node's leader-aware view reads them. So create/update/list executed
// on a NON-leader node proxy to the leader server-side (the browser/connector
// never needs a hub token). This is robust even if cross-node sync lags.
export interface LeaderAnchorDeps {
  getElection: () => Promise<{ isMonitor: boolean; monitorNodeId: string | null }>;
  proxyGet: (node: string, path: string) => Promise<unknown>;
  proxyPost: (node: string, path: string, body: unknown) => Promise<unknown>;
}
export function realLeaderAnchor(): LeaderAnchorDeps {
  return {
    getElection: () => amIMonitor(),
    proxyGet: (n, p) => { const { proxyGet } = require('../../data/peer-client') as typeof import('../../data/peer-client'); return proxyGet(n, p); },
    proxyPost: (n, p, b) => { const { proxyPost } = require('../../data/peer-client') as typeof import('../../data/peer-client'); return proxyPost(n, p, b); },
  };
}
/**
 * If a leader-anchor dep is provided AND this node is not the leader, proxy the
 * op to the leader and return its envelope. Returns null when this node IS the
 * leader (or no anchor / no leader / proxy failed) → the caller handles locally.
 * No loop: a proxied request reaching the leader sees isMonitor=true → null → local.
 */
async function anchorToLeader(leader: LeaderAnchorDeps | undefined, method: 'GET' | 'POST', path: string, body?: unknown, failClosed = false): Promise<Envelope | null> {
  if (!leader) return null;
  let election: { isMonitor: boolean; monitorNodeId: string | null };
  try { election = await leader.getElection(); } catch { return null; }
  if (election.isMonitor || !election.monitorNodeId) return null;
  try {
    const result = method === 'GET'
      ? await leader.proxyGet(election.monitorNodeId, path)
      : await leader.proxyPost(election.monitorNodeId, path, body ?? {});
    if (result && typeof result === 'object' && 'success' in (result as object)) return result as Envelope;
    return ok((result as { data?: unknown })?.data ?? result);
  } catch (e) {
    // Writes are fail-CLOSED: a mission MUST land on the leader. Falling back to a
    // LOCAL write on a proxy error would either strand the mission on a non-leader
    // or (if the leader committed but the response was lost) create a duplicate.
    // Return a clear error so the caller retries (e.g. after a ~1-min failover).
    if (failClosed) return fail('LEADER_UNREACHABLE', `mission leader unreachable; retry shortly (${(e as Error).message})`);
    return null; // reads fall back to the local (synced) store
  }
}

// --- testable handlers (port-injected) ---

async function actorFor(b: Record<string, unknown>): Promise<MissionActor> {
  const hint = b._actor as { channel?: string; toolUseId?: string | null } | undefined;
  delete (b as any)._actor;
  if (hint && hint.channel === 'mcp') {
    const resolved = await resolveMcpActor(hint.toolUseId, thisNode(), Date.now());
    const ctrl = await getControllerSession().catch(() => null);
    return upgradeControllerActor(resolved, ctrl?.sessionId);
  }
  return coarseActor('user', thisNode(), Date.now());
}

export async function handleCreate(b: Record<string, unknown>, ownerNode: string, port?: MissionDataPort, actor?: MissionActor, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'POST', '/mission', b, true);
  if (anchored) return anchored;
  const who = actor ?? await actorFor(b);
  const title = str(b.title);
  const objective = str(b.objective);
  if (!title || !objective) return fail('INVALID_INPUT', 'title and objective are required');
  const env = (b.env && typeof b.env === 'object') ? b.env as Record<string, unknown> : {};
  const envHost = str(env.host);
  if (envHost) {
    const records = await getClusterRecords();
    if (!placementAllowed(envHost, records, thisNode(), getMyCluster())) {
      return fail('HOST_NOT_IN_CLUSTER', `host "${envHost}" is not in this node's cluster`);
    }
  }
  const tags = (b.tags && typeof b.tags === 'object') ? normalizeTags(b.tags as Record<string, string[]>) : {};
  const parentId = (b.parentId === null || b.parentId === '') ? null : (str(b.parentId) ?? null);
  const m = newMission({
    title, objective, ownerNode, createdBy: who,
    projects: arr(b.projects), dependsOn: arr(b.dependsOn),
    plan: str(b.plan), nextSteps: arr(b.nextSteps), tags, parentId,
    env: {
      isolation: (str(env.isolation) as Isolation) ?? 'cloud',
      host: str(env.host), repo: str(env.repo), branch: str(env.branch),
      resources: arr(env.resources) ?? [],
      exclusive: env.exclusive === true || env.exclusive === 'true',
    },
  }, Date.now(), genId);
  const all = await listMissions(port);
  const pv = validateParent(m.id, m.parentId, all);
  if (!pv.ok) return fail(pv.code, pv.message);
  const dv = validateDependsOn(m.id, m.dependsOn, [...all, m]);
  if (!dv.ok) return fail(dv.code, dv.message);
  await putMission(m, port, { actor: who });
  return ok(m);
}

export async function handleList(port?: MissionDataPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'GET', '/mission');
  if (anchored) return anchored;
  return ok(await listMissions(port));
}

export async function handleGet(id: string, port?: MissionDataPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  // Leader-anchored READ: missions live on the elected leader, so a non-leader node proxies the
  // single-get to it (mirrors handleList) — else GET /mission/:id 404s off-leader (the mission
  // detail tab broke this way: the list is anchored but the single-get wasn't).
  const anchored = await anchorToLeader(leader, 'GET', `/mission/${encodeURIComponent(id)}`);
  if (anchored) return anchored;
  const m = await getMission(id, port);
  return m ? ok(m) : fail('NOT_FOUND', `no mission ${id}`);
}

export async function handlePatch(id: string, b: Record<string, unknown>, port?: MissionDataPort, actor?: MissionActor, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'POST', `/mission/${encodeURIComponent(id)}`, b, true);
  if (anchored) return anchored;
  const who = actor ?? await actorFor(b);
  const m = await getMission(id, port);
  if (!m) return fail('NOT_FOUND', `no mission ${id}`);
  if (str(b.objective)) m.objective = str(b.objective)!;
  if (str(b.title)) m.title = str(b.title)!;
  if (str(b.plan) !== undefined) m.plan = str(b.plan);
  if (arr(b.nextSteps)) m.nextSteps = arr(b.nextSteps);
  if (arr(b.dependsOn)) {
    const deps = arr(b.dependsOn)!;
    const dv = validateDependsOn(m.id, deps, await listMissions(port));
    if (!dv.ok) return fail(dv.code, dv.message);
    m.dependsOn = deps;
  }
  if (arr(b.projects)) m.projects = arr(b.projects)!;
  if (b.tags && typeof b.tags === 'object') m.tags = normalizeTags(b.tags as Record<string, string[]>);
  if (b.parentId !== undefined) {
    const pid = (b.parentId === null || b.parentId === '') ? null : (str(b.parentId) ?? null);
    const pv = validateParent(m.id, pid, await listMissions(port));
    if (!pv.ok) return fail(pv.code, pv.message);
    m.parentId = pid;
  }
  const sv = str(b.status) as MissionStatus | undefined;
  if (sv) { if (!VALID_STATUS.has(sv)) return fail('INVALID_INPUT', `invalid status "${sv}"`); m.status = sv; }
  if (b.env && typeof b.env === 'object') {
    const e = b.env as Record<string, unknown>;
    if (str(e.isolation)) m.env.isolation = str(e.isolation) as Isolation;
    if (str(e.host) !== undefined) {
      const newHost = str(e.host);
      if (newHost && !placementAllowed(newHost, await getClusterRecords(), thisNode(), getMyCluster())) {
        return fail('HOST_NOT_IN_CLUSTER', `host "${newHost}" is not in this node's cluster`);
      }
      m.env.host = newHost;
    }
    if (str(e.repo) !== undefined) m.env.repo = str(e.repo);
    if (str(e.branch) !== undefined) m.env.branch = str(e.branch);
    if (arr(e.resources)) m.env.resources = arr(e.resources)!;
    if (e.exclusive !== undefined) m.env.exclusive = e.exclusive === true || e.exclusive === 'true';
  }
  // Bind a spawned executor to the mission. WITHOUT this the controller could ccr_cloud_start a
  // worker but had no way to attach it (the guide said "bind via mission_update" but the field was
  // never accepted) → the mission stayed unbound → the supervisor couldn't monitor it → a worker's
  // pendingQuestion never triggered the fast gate-engagement → the cloud worker idle-suspended
  // before being answered. `binding:{sessionId,kind,node?,ccr?}` (sessionId=null to unbind).
  if (b.binding !== undefined && (b.binding === null || typeof b.binding === 'object')) {
    const bn = (b.binding || {}) as Record<string, unknown>;
    const sid = str(bn.sessionId);
    if (b.binding === null || sid === undefined) {
      m.binding = null;
    } else {
      const k = str(bn.kind);
      const binding: MissionBinding = {
        sessionId: sid,
        node: str(bn.node) ?? thisNode(),
        kind: (k === 'orchestrator' || k === 'worker') ? k : 'worker',
        boundAt: Date.now(),
      };
      if (bn.ccr && typeof bn.ccr === 'object') {
        const cc = bn.ccr as Record<string, unknown>;
        const cse = str(cc.cse); const csid = str(cc.sid);
        if (cse && csid) binding.ccr = { cse, sid: csid, webUrl: str(cc.webUrl) ?? null };
      }
      m.binding = binding;
    }
  }
  await putMission(m, port, { actor: who });
  return ok(m);
}

export async function handleTag(id: string, b: Record<string, unknown>, port?: MissionDataPort, actor?: MissionActor, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'POST', `/mission/${encodeURIComponent(id)}/tags`, b, true);
  if (anchored) return anchored;
  const who = actor ?? await actorFor(b);
  const m = await getMission(id, port);
  if (!m) return fail('NOT_FOUND', `no mission ${id}`);
  const asMap = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, string[]> : undefined;
  m.tags = mergeTags(m.tags ?? {}, { add: asMap(b.add), remove: asMap(b.remove), set: asMap(b.set) });
  await putMission(m, port, { actor: who });
  return ok(m);
}

export async function handleHistory(
  id: string,
  opts: { limit?: number; beforeRev?: number },
  leader?: LeaderAnchorDeps,
  listHistory: typeof listMissionHistory = listMissionHistory,
): Promise<Envelope> {
  const qs = new URLSearchParams();
  if (opts.limit != null) qs.set('limit', String(opts.limit));
  if (opts.beforeRev != null) qs.set('beforeRev', String(opts.beforeRev));
  const path = `/mission/${encodeURIComponent(id)}/history${qs.toString() ? `?${qs}` : ''}`;
  const anchored = await anchorToLeader(leader, 'GET', path);
  if (anchored) return anchored;
  return ok({ history: await listHistory(id, opts) });
}

// ---------------------------------------------------------------------------
// Graph-query handlers (filter / neighbors / graph) — read-only
// ---------------------------------------------------------------------------

function asFilter(v: unknown): MissionFilter[] | undefined { return Array.isArray(v) ? (v as MissionFilter[]) : undefined; }
function asSort(v: unknown): MissionSort[] | undefined { return Array.isArray(v) ? (v as MissionSort[]) : undefined; }
const DIRS = new Set<Direction>(['parents', 'children', 'dependencies', 'dependents', 'all']);

export async function handleQuery(b: Record<string, unknown>, port?: MissionDataPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'POST', '/mission/query', b, false);
  if (anchored) return anchored;
  try {
    const limit = typeof b.limit === 'number' ? b.limit : (typeof b.limit === 'string' ? parseInt(b.limit, 10) : undefined);
    const missions = filterMissions(await listMissions(port), asFilter(b.filter), { sort: asSort(b.sort), limit: limit != null && !Number.isNaN(limit) ? limit : undefined });
    return ok({ missions });
  } catch (e) { if (e instanceof FilterError) return fail(e.code, e.message); throw e; }
}

export async function handleNeighbors(id: string, b: Record<string, unknown>, port?: MissionDataPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const dir = (typeof b.direction === 'string' && DIRS.has(b.direction as Direction)) ? (b.direction as Direction) : 'all';
  const depth = typeof b.depth === 'number' ? b.depth : (typeof b.depth === 'string' ? parseInt(b.depth, 10) : 1);
  const anchored = await anchorToLeader(leader, 'POST', `/mission/${encodeURIComponent(id)}/neighbors`, { direction: dir, depth }, false);
  if (anchored) return anchored;
  const m = await getMission(id, port);
  if (!m) return fail('NOT_FOUND', `no mission ${id}`);
  const all = await listMissions(port);
  const r = neighbors(id, all, { direction: dir, depth: !Number.isNaN(depth) ? depth : 1 });
  return ok({ mission: m, neighbors: r.neighbors.map(toNode), edges: r.edges });
}

/**
 * Shared pure graph-build: filter missions, optionally expand neighbor BFS, return {nodes,edges}.
 * Used by both handleGraph (MCP/REST) and handleViewGraph (saved-view render) so they are identical
 * in behavior. Key contract: `expand` needs only to be a non-null object (no `direction` required —
 * direction defaults to 'all'); depth is coerced from string (MCP delivers numbers as strings).
 */
function buildGraph(
  all: Mission[],
  filter: MissionFilter[] | undefined,
  expand: { direction?: unknown; depth?: unknown } | undefined,
): { nodes: MissionNode[]; edges: MissionEdge[] } {
  const matches = filterMissions(all, filter);
  const nodeIds = new Set(matches.map((m) => m.id));
  if (expand && typeof expand === 'object') {
    const dir = (typeof expand.direction === 'string' && DIRS.has(expand.direction as Direction))
      ? (expand.direction as Direction)
      : 'all';
    // MCP delivers numeric args as STRINGS over the connector — coerce (mirrors handleNeighbors).
    const depthRaw = typeof expand.depth === 'number' ? expand.depth : (typeof expand.depth === 'string' ? parseInt(expand.depth, 10) : 1);
    const depth = !Number.isNaN(depthRaw) ? depthRaw : 1;
    for (const m of matches) for (const n of neighbors(m.id, all, { direction: dir, depth }).neighbors) nodeIds.add(n.id);
  }
  const byId = new Map(all.map((m) => [m.id, m]));
  const nodes = [...nodeIds].map((id) => byId.get(id)).filter(Boolean).map((m) => toNode(m!));
  return { nodes, edges: subgraphEdges(nodeIds, all) };
}

export async function handleGraph(b: Record<string, unknown>, port?: MissionDataPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'POST', '/mission/graph', b, false);
  if (anchored) return anchored;
  try {
    const all = await listMissions(port);
    return ok(buildGraph(all, asFilter(b.filter), b.expand as { direction?: unknown; depth?: unknown } | undefined));
  } catch (e) { if (e instanceof FilterError) return fail(e.code, e.message); throw e; }
}

export async function handleSchedule(b: Record<string, unknown>, port?: MissionDataPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'POST', '/mission/schedule', b, false);
  if (anchored) return anchored;
  const all = await listMissions(port);
  return ok(computeSchedule(all));
}

export async function handleChanges(b: Record<string, unknown>, port?: MissionDataPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'POST', '/mission/changes', b, false);
  if (anchored) return anchored;
  const all = await listMissions(port);
  const sinceRev = (b.sinceRev && typeof b.sinceRev === 'object') ? (b.sinceRev as Record<string, number>) : undefined;
  const sinceTsRaw = typeof b.sinceTs === 'number' ? b.sinceTs : (typeof b.sinceTs === 'string' ? parseInt(b.sinceTs, 10) : undefined);
  const sinceTs = sinceTsRaw != null && !Number.isNaN(sinceTsRaw) ? sinceTsRaw : undefined;
  return ok({ changes: recentExternalChanges(all, { sinceRev, sinceTs }) });
}

// ---------------------------------------------------------------------------
// View handlers (dashboard saved views)
// ---------------------------------------------------------------------------

export async function handleViewSet(b: Record<string, unknown>, port?: MissionViewPort, actor?: MissionActor, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'POST', '/mission/views', b, true);
  if (anchored) return anchored;
  const who = actor ?? await actorFor(b);
  const id = str(b.id);
  const existing = id ? await getView(id, port) : null;
  const base: MissionView = existing
    ? { ...existing, name: str(b.name) ?? existing.name, query: (b.query as MissionView['query']) ?? existing.query, display: (b.display as MissionView['display']) ?? existing.display, lastUpdatedBy: who }
    : newView({ name: str(b.name) ?? '', query: b.query as MissionView['query'], display: b.display as MissionView['display'], createdBy: who }, Date.now(), genViewId);
  const view = normalizeView(base);
  const v = validateView(view);
  if (!v.ok) return fail('INVALID_VIEW', v.message);
  await putView(view, port);
  return ok(view);
}

export async function handleViewList(port?: MissionViewPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'GET', '/mission/views');
  if (anchored) return anchored;
  return ok({ views: await listViews(port) });
}

export async function handleViewGet(id: string, port?: MissionViewPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'GET', `/mission/views/${encodeURIComponent(id)}`);
  if (anchored) return anchored;
  const view = await getView(id, port);
  return view ? ok(view) : fail('NOT_FOUND', `no view ${id}`);
}

export async function handleViewDelete(id: string, port?: MissionViewPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'POST', `/mission/views/${encodeURIComponent(id)}/delete`, {}, true);
  if (anchored) return anchored;
  await deleteView(id, port);
  return ok({ deleted: id });
}

export async function handleViewGraph(id: string, viewPort?: MissionViewPort, missionPort?: MissionDataPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'GET', `/mission/views/${encodeURIComponent(id)}/graph`);
  if (anchored) return anchored;
  const view = await getView(id, viewPort);
  if (!view) return fail('NOT_FOUND', `no view ${id}`);
  try {
    const all = await listMissions(missionPort);
    return ok({ view, ...buildGraph(all, view.query?.filter, view.query?.expand) });
  } catch (e) { if (e instanceof FilterError) return fail(e.code, e.message); throw e; }
}

// ---------------------------------------------------------------------------
// Rail handlers (place + executor-status)
// ---------------------------------------------------------------------------

export async function handlePlace(id: string, port?: MissionDataPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  // Leader-anchored READ: the mission lives on the leader, so a non-leader proxies (else "no mission"
  // — the controller hit exactly this: mission_list showed it but mission_place reported no mission).
  const anchored = await anchorToLeader(leader, 'GET', `/mission/${encodeURIComponent(id)}/place`);
  if (anchored) return anchored;
  const m = await getMission(id, port);
  if (!m) return fail('NOT_FOUND', `no mission ${id}`);
  const all = await listMissions(port);
  return ok(place(m, all));
}

export async function handleExecutorStatus(
  id: string,
  port?: MissionDataPort,
  readExec?: (m: Mission) => Promise<ExecutorState>,
  leader?: LeaderAnchorDeps,
): Promise<Envelope> {
  // Leader-anchored READ (same as handlePlace): mission + binding live on the leader.
  const anchored = await anchorToLeader(leader, 'GET', `/mission/${encodeURIComponent(id)}/executor-status`);
  if (anchored) return anchored;
  const m = await getMission(id, port);
  if (!m) return fail('NOT_FOUND', `no mission ${id}`);
  const defaultReadExec = async (mission: Mission): Promise<ExecutorState> => {
    const { readExecutorState } = require('../../mission/mission-controller') as typeof import('../../mission/mission-controller');
    return readExecutorState(mission);
  };
  const doRead = readExec ?? defaultReadExec;
  const s = await doRead(m);
  return ok({
    alive: s.alive,
    idle: s.idle,
    serverStalled: s.serverStalled,
    gate: s.gate,
    status: s.newOutput ? 'has-output' : 'idle',
  });
}

export interface MissionSession { sid: string; kind: 'orchestrator' | 'worker'; role: 'primary' | 'sub'; lastContact?: number; }

export async function handleSessions(
  id: string,
  port?: MissionDataPort,
  listWorkers: () => WorkerRecord[] = listRecords,
  leader?: LeaderAnchorDeps,
): Promise<Envelope> {
  // Leader-anchored READ (same reason as handleGet): the binding + worker records live on the leader.
  const anchored = await anchorToLeader(leader, 'GET', `/mission/${encodeURIComponent(id)}/sessions`);
  if (anchored) return anchored;
  const m = await getMission(id, port);
  if (!m) return fail('NOT_FOUND', `no mission ${id}`);
  const sessions: MissionSession[] = [];
  const primarySid = m.binding ? (m.binding.ccr?.sid || m.binding.sessionId) : null;
  if (primarySid) {
    sessions.push({ sid: primarySid, kind: m.binding!.kind === 'orchestrator' ? 'orchestrator' : 'worker', role: 'primary', lastContact: m.binding!.boundAt });
    for (const w of listWorkers()) {
      if (w.orchestrator?.id === primarySid && w.sessionId !== primarySid) {
        sessions.push({ sid: w.sessionId, kind: 'worker', role: 'sub', lastContact: w.orchestrator?.lastContact });
      }
    }
  }
  return ok({ sessions });
}

// ---------------------------------------------------------------------------
// GET /mission/controller — election + job + controllerSession (Task 9)
// ---------------------------------------------------------------------------

export interface LeaderInfo {
  node: string | null;
  host: string | null;
  isSelf: boolean;
}

/** Default leader-host resolver: fetches /api/tier-agent/machines via the hub and maps gatewayId → hostname. Non-fatal (returns null on any error). */
async function defaultGetLeaderHost(node: string | null): Promise<string | null> {
  if (!node) return null;
  try {
    const { getHubConfig } = require('../../hub-client/hub-config') as typeof import('../../hub-client/hub-config');
    const cfg = getHubConfig();
    const base = (cfg.hubUrl || '').replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
    if (!base) return null;
    const res = await fetch(`${base}/api/tier-agent/machines`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    if (!res.ok) return null;
    const json = await res.json() as any;
    const machines: any[] = Array.isArray(json) ? json : (json.machines || json.data || []);
    const match = machines.find((m: any) => (m.gatewayId || m.machineId || m.id) === node);
    return match ? ((match.hostname || match.machineHostname || null) as string | null) : null;
  } catch {
    return null;
  }
}

export async function handleGetController(
  port?: MissionDataPort,
  getElection?: () => Promise<{ isMonitor: boolean; monitorNodeId: string | null }>,
  getJob?: () => unknown,
  getLeaderHost?: (node: string | null) => Promise<string | null>,
  proxyController?: (node: string) => Promise<unknown>,
): Promise<Envelope> {
  const doGetElection = getElection ?? (() => amIMonitor());
  const doGetJob = getJob ?? (() => getScheduledJobs().getJob('mission-controller'));
  const doGetLeaderHost = getLeaderHost ?? defaultGetLeaderHost;
  const doProxyController = proxyController ?? ((node: string) => {
    const { proxyGet } = require('../../data/peer-client') as typeof import('../../data/peer-client');
    return proxyGet(node, '/mission/controller');
  });
  const [election, localControllerSession] = await Promise.all([
    doGetElection(),
    getControllerSession(port),
  ]);
  const job = doGetJob();
  const leaderNode = election.monitorNodeId ?? null;
  const selfId = thisNode();
  const host = await doGetLeaderHost(leaderNode);
  const leader: LeaderInfo = {
    node: leaderNode,
    host,
    isSelf: leaderNode !== null && leaderNode === selfId,
  };

  // Non-leader node: proxy the controller status from the leader so the browser
  // sees the leader's controllerSession (not the local stale/null one).
  // The browser has no hub Bearer token — only the server can proxy.
  let controllerSession = localControllerSession;
  if (!election.isMonitor && leaderNode) {
    try {
      const leaderData = await doProxyController(leaderNode) as any;
      const leaderCtrl = (leaderData?.data ?? leaderData) as any;
      if (leaderCtrl?.controllerSession !== undefined) {
        controllerSession = leaderCtrl.controllerSession;
      }
    } catch {
      // Non-fatal: fall back to local controllerSession on any proxy error
    }
  }

  return ok({ election, job, controllerSession, leader });
}

// ---------------------------------------------------------------------------
// All sessions list: controller + every active mission's orchestrator/workers
// ---------------------------------------------------------------------------

export interface AllSessionRow {
  sid: string;
  missionId: string | null;
  role: 'controller' | 'orchestrator' | 'worker';
  transport: 'cloud' | 'native';
  status?: string;
  webUrl?: string | null;
}

export async function handleAllSessions(
  port?: MissionDataPort,
  listWorkers: () => WorkerRecord[] = listRecords,
  controllerSid?: string | null,
): Promise<Envelope> {
  const all = await listMissions(port);
  const activeMissions = all.filter((m) => m.status === 'active' || m.status === 'waiting');
  const sessions: AllSessionRow[] = [];

  // Prepend the controller session row (if any)
  const ctrlSid = controllerSid ?? (await getControllerSession(port))?.sessionId ?? null;
  if (ctrlSid) {
    const resolved = resolveMissionSession(ctrlSid, activeMissions, ctrlSid);
    sessions.push({ sid: ctrlSid, missionId: null, role: 'controller', transport: resolved.transport });
  }

  // Add orchestrators and their sub-workers for each active mission
  for (const m of activeMissions) {
    if (!m.binding?.sessionId) continue;
    const primarySid = m.binding.ccr?.sid || m.binding.sessionId;
    const webUrl = m.binding.ccr?.webUrl ?? null;
    const resolved = resolveMissionSession(primarySid, activeMissions, ctrlSid);
    sessions.push({
      sid: primarySid,
      missionId: m.id,
      role: resolved.role === 'controller' ? 'orchestrator' : resolved.role,
      transport: resolved.transport,
      webUrl,
    });
    // Sub-workers
    for (const w of listWorkers()) {
      if (w.orchestrator?.id === primarySid && w.sessionId !== primarySid) {
        const wResolved = resolveMissionSession(w.sessionId, activeMissions, ctrlSid);
        sessions.push({
          sid: w.sessionId,
          missionId: m.id,
          role: 'worker',
          transport: wResolved.transport,
        });
      }
    }
  }

  return ok({ sessions });
}

// ---------------------------------------------------------------------------
// Session read / drive / control (transport-dispatched)
// ---------------------------------------------------------------------------

export interface SessionOpsDeps {
  cloudRead: (opts: { sid: string; lastN?: number }) => Promise<{ sid: string; messages: Array<Record<string, unknown>>; pendingQuestion: unknown | null }>;
  cloudDrive: (opts: { sid: string; text: string }) => Promise<{ delivered: boolean; sid: string }>;
  cloudStop: (sid: string) => Promise<{ stopped: boolean; sid: string }>;
  nativeRead: (sid: string) => Promise<{ messages: Array<{ role: string; content: string; [k: string]: unknown }> }>;
  /** Return raw JSONL line objects for a native session (each parsed line, for pendingQuestion extraction). */
  nativeRawMessages: (sid: string) => Promise<Array<{ message?: { content?: unknown[] } }>>;
  nativeDrive: (sid: string, text: string) => Promise<void>;
  nativeInterrupt: (sid: string) => Promise<void>;
  nativeStop: (sid: string) => Promise<void>;
  clearController: () => Promise<void>;
  getControllerSession: () => Promise<{ sessionId: string; cse: string | null } | null>;
  resolve: (sid: string) => ResolvedSession;
  /**
   * Resolve a native session's bridge cse_… (a `--remote-control` session — the controller
   * or a mission-bound native worker), or null. Optional: when present, a native read whose
   * local transcript shows no pending question falls back to the bridge worker/events channel.
   */
  bridgeCseFor?: (sid: string) => Promise<string | null>;
  /** Read a bridge session's worker/events channel for a pending AskUserQuestion. */
  workerEventsRead?: (cse: string) => Promise<{ pendingQuestion: import('../../terminal/ccr-cloud').PendingControlRequest | null }>;
}

/**
 * Resolve a native session's bridge cse_… (a `claude --remote-control` session — the controller
 * or a mission-bound native worker), or null. In order:
 *   1. the elected controller-session record (when its cse is populated);
 *   2. the session's OWN local transcript, which records `{type:'bridge-session', bridgeSessionId:'cse_…'}`
 *      on every bridge (re)connect — the robust general source (the controller record's cse is often
 *      null, but the transcript always has it for a remote-control session);
 *   3. a mission binding's ccr bridge webUrl.
 * Best-effort → null. Shared by the read + answer default deps.
 */
async function defaultBridgeCseFor(sid: string): Promise<string | null> {
  try {
    const { getControllerSession: gcs } = require('../../mission/mission-store') as typeof import('../../mission/mission-store');
    const ctrl = await gcs();
    if (ctrl && ctrl.sessionId === sid && ctrl.cse) return ctrl.cse;
  } catch { /* best-effort */ }
  // 2) the session's transcript records its bridge cse (works for the controller + native executors)
  try {
    const { sessionVerdict } = require('../../terminal/cc-sessions') as typeof import('../../terminal/cc-sessions');
    const { extractBridgeCse } = require('../../terminal/ccr-cloud') as typeof import('../../terminal/ccr-cloud');
    const jsonl = sessionVerdict(sid).jsonl;
    if (jsonl) {
      const fs = require('fs') as typeof import('fs');
      const text = fs.readFileSync(jsonl, 'utf-8');
      const lines: Array<{ type?: string; bridgeSessionId?: string }> = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { lines.push(JSON.parse(line)); } catch { /* skip */ }
      }
      const cse = extractBridgeCse(lines);
      if (cse) return cse;
    }
  } catch { /* best-effort */ }
  // 3) a mission binding's ccr webUrl
  try {
    const { listMissions } = require('../../mission/mission-store') as typeof import('../../mission/mission-store');
    const { cseFromWebUrl } = require('../../terminal/ccr-manager') as typeof import('../../terminal/ccr-manager');
    for (const m of await listMissions()) {
      const b = m.binding as { sessionId?: string; ccr?: { webUrl?: string | null } } | null;
      if (b && b.sessionId === sid && b.ccr?.webUrl) {
        const cse = cseFromWebUrl(b.ccr.webUrl);
        if (cse) return cse;
      }
    }
  } catch { /* best-effort */ }
  return null;
}

function defaultSessionOpsDeps(): SessionOpsDeps {
  return {
    cloudRead: async (opts) => {
      const { cloudRead } = require('../../terminal/ccr-cloud') as typeof import('../../terminal/ccr-cloud');
      const r = await cloudRead(opts);
      return { sid: r.sid, messages: r.messages as unknown as Array<Record<string, unknown>>, pendingQuestion: r.pendingQuestion };
    },
    cloudDrive: async (opts) => {
      const { cloudDrive } = require('../../terminal/ccr-cloud') as typeof import('../../terminal/ccr-cloud');
      return cloudDrive(opts);
    },
    cloudStop: async (sid) => {
      const { cloudStop } = require('../../terminal/ccr-cloud') as typeof import('../../terminal/ccr-cloud');
      return cloudStop(sid);
    },
    nativeRead: async (sid) => {
      const { AgentSessionStore } = require('../../agent-session-store') as typeof import('../../agent-session-store');
      const store = new AgentSessionStore({ projectPath: process.cwd(), persist: false });
      const res = await store.getConversation({ sessionId: sid });
      const msgs = (res?.messages ?? []) as unknown as Array<{ role: string; content: string; [k: string]: unknown }>;
      return { messages: msgs };
    },
    nativeRawMessages: async (sid) => {
      // Read the raw JSONL file for the session (each parsed line) for pendingQuestion extraction.
      const { sessionVerdict } = require('../../terminal/cc-sessions') as typeof import('../../terminal/cc-sessions');
      const verdict = sessionVerdict(sid);
      const jsonl = verdict.jsonl;
      if (!jsonl) return [];
      const fs = require('fs') as typeof import('fs');
      let text = '';
      try { text = fs.readFileSync(jsonl, 'utf-8'); } catch { return []; }
      const lines: Array<{ message?: { content?: unknown[] } }> = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { lines.push(JSON.parse(line)); } catch { /* skip */ }
      }
      return lines;
    },
    nativeDrive: async (sid, text) => {
      const { getCcController } = require('../../terminal/backend') as typeof import('../../terminal/backend');
      await getCcController().prompt(sid, text);
    },
    nativeInterrupt: async (sid) => {
      const { getCcController } = require('../../terminal/backend') as typeof import('../../terminal/backend');
      await getCcController().interrupt(sid);
    },
    nativeStop: async (sid) => {
      const { getCcController } = require('../../terminal/backend') as typeof import('../../terminal/backend');
      // CcController.close() terminates the Claude session (kills its tmux session on Linux).
      await getCcController().close(sid);
    },
    clearController: async () => {
      const { putControllerSession } = require('../../mission/mission-store') as typeof import('../../mission/mission-store');
      await putControllerSession(null);
    },
    getControllerSession: async () => {
      const { getControllerSession: gcs } = require('../../mission/mission-store') as typeof import('../../mission/mission-store');
      return gcs();
    },
    resolve: (sid) => {
      // Sync fallback — resolve with no missions (full list too expensive here without a port)
      return resolveMissionSession(sid, [], null);
    },
    bridgeCseFor: defaultBridgeCseFor,
    workerEventsRead: async (cse) => {
      const { cloudClientEventsRead } = require('../../terminal/ccr-cloud') as typeof import('../../terminal/ccr-cloud');
      const r = await cloudClientEventsRead(cse);
      return { pendingQuestion: r.pendingQuestion };
    },
  };
}

/** Optional cross-node proxy dep for session ops. Tests inject this; production uses proxyPost from peer-client. */
export interface SessionProxyDeps {
  proxyPost: (node: string, urlPath: string, body: unknown) => Promise<unknown>;
}
function defaultSessionProxyDeps(): SessionProxyDeps {
  return {
    proxyPost: (node, urlPath, body) => {
      const { proxyPost: pp } = require('../../data/peer-client') as typeof import('../../data/peer-client');
      return pp(node, urlPath, body);
    },
  };
}
/**
 * Normalise a proxy response into an Envelope.
 * The remote Core returns { success, data, ... } — pass it through directly.
 * If the stub/proxy returns bare data (e.g. just { data: {...} }), wrap in ok().
 */
function proxyEnvelope(result: unknown): Envelope {
  if (result && typeof result === 'object' && 'success' in (result as object)) {
    return result as Envelope;
  }
  const r = result as any;
  return ok(r?.data !== undefined ? r.data : r);
}

export async function handleSessionRead(sid: string, lastN?: number, deps?: SessionOpsDeps, node?: string, proxyDeps?: SessionProxyDeps): Promise<Envelope> {
  const self = thisNode();
  if (node && node !== self) {
    // Proxy to the target node server-side — the browser has no hub Bearer token.
    const pd = proxyDeps ?? defaultSessionProxyDeps();
    try {
      const result = await pd.proxyPost(node, `/mission/session/${encodeURIComponent(sid)}/read`, { lastN }) as any;
      return proxyEnvelope(result);
    } catch (e) {
      return fail('PROXY_ERROR', (e as Error).message);
    }
  }
  const d = deps ?? defaultSessionOpsDeps();
  const r = d.resolve(sid);
  try {
    if (r.transport === 'cloud') {
      const result = await d.cloudRead({ sid, lastN });
      // Cloud messages already have { role, text, tools? } from CloudTranscriptMsg — pass tools through.
      const normalized = result.messages.map((m) => {
        const out: { role: string; text: string; tools?: string[] } = {
          role: (m as any).role ?? 'assistant',
          text: (m as any).text ?? (m as any).content ?? '',
        };
        const tools = (m as any).tools;
        if (Array.isArray(tools) && tools.length > 0) out.tools = tools;
        return out;
      });
      // Pass through the cloud pendingQuestion (already computed by cloudRead).
      const pendingQuestion = result.pendingQuestion ?? null;
      return ok({ messages: normalized, pendingQuestion });
    } else {
      // Best-effort: refresh the idle timer for resumed native sessions.
      try { touchActivity(sid, Date.now()); } catch { /* best-effort */ }
      const result = await d.nativeRead(sid);
      // Native ConversationMessage has { role, content, toolCalls? } — normalize content -> text
      // and map toolCalls[].name to tools: string[] for a uniform shape.
      const normalized = result.messages.map((m) => {
        const out: { role: string; text: string; tools?: string[] } = {
          role: m.role,
          text: m.content,
        };
        const toolCalls = (m as any).toolCalls as Array<{ name: string }> | undefined;
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          out.tools = toolCalls.map((tc) => tc.name);
        }
        return out;
      });
      // Extract pendingQuestion from raw JSONL (tool_use / tool_result blocks).
      let pendingQuestion: import('../../terminal/ccr-cloud').PendingQuestion | null = null;
      try {
        const rawMsgs = await d.nativeRawMessages(sid);
        const { extractPendingQuestion } = require('../../terminal/ccr-cloud') as typeof import('../../terminal/ccr-cloud');
        pendingQuestion = extractPendingQuestion(rawMsgs);
      } catch { /* best-effort: non-fatal */ }
      // A `--remote-control` (bridge) session's AskUserQuestion is intercepted by the bridge
      // and relayed to claude.ai — it is NOT in the local .jsonl. When the transcript shows no
      // pending question and this native session has a bridge cse, read the worker/events
      // channel (observer-only fan-out replay) and surface that question instead.
      if (!pendingQuestion && d.bridgeCseFor && d.workerEventsRead) {
        try {
          const cse = await d.bridgeCseFor(sid);
          if (cse) {
            const wr = await d.workerEventsRead(cse);
            if (wr.pendingQuestion) pendingQuestion = wr.pendingQuestion;
          }
        } catch { /* best-effort: non-fatal */ }
      }
      return ok({ messages: normalized, pendingQuestion });
    }
  } catch (e) {
    return fail('READ_ERROR', (e as Error).message);
  }
}

export async function handleSessionDrive(sid: string, text: string, deps?: SessionOpsDeps, node?: string, proxyDeps?: SessionProxyDeps): Promise<Envelope> {
  const self = thisNode();
  if (node && node !== self) {
    const pd = proxyDeps ?? defaultSessionProxyDeps();
    try {
      const result = await pd.proxyPost(node, `/mission/session/${encodeURIComponent(sid)}/drive`, { text }) as any;
      return proxyEnvelope(result);
    } catch (e) {
      return fail('PROXY_ERROR', (e as Error).message);
    }
  }
  const d = deps ?? defaultSessionOpsDeps();
  const r = d.resolve(sid);
  try {
    if (r.transport === 'cloud') {
      const result = await d.cloudDrive({ sid, text });
      return ok({ delivered: result.delivered });
    } else {
      // Best-effort: refresh the idle timer for resumed native sessions.
      try { touchActivity(sid, Date.now()); } catch { /* best-effort */ }
      await d.nativeDrive(sid, text);
      return ok({ delivered: true });
    }
  } catch (e) {
    return fail('DRIVE_ERROR', (e as Error).message);
  }
}

export async function handleSessionControl(sid: string, action: string, deps?: SessionOpsDeps, node?: string, proxyDeps?: SessionProxyDeps): Promise<Envelope> {
  const self = thisNode();
  if (node && node !== self) {
    const pd = proxyDeps ?? defaultSessionProxyDeps();
    try {
      const result = await pd.proxyPost(node, `/mission/session/${encodeURIComponent(sid)}/control`, { action }) as any;
      return proxyEnvelope(result);
    } catch (e) {
      return fail('PROXY_ERROR', (e as Error).message);
    }
  }
  const d = deps ?? defaultSessionOpsDeps();
  const r = d.resolve(sid);
  try {
    if (action === 'restart') {
      // The synchronous resolver can't know the controller sid (it resolves with empty missions/null ctrlSid).
      // Look it up from the store: a session is the controller if it matches the stored ControllerSession.
      const ctrl = await d.getControllerSession();
      const isController = !!ctrl && (sid === ctrl.sessionId || (ctrl.cse !== null && sid === ctrl.cse));
      if (!isController) {
        return fail('INVALID_INPUT', 'restart is controller-only — clear the controller session so the supervisor relaunches');
      }
      // Kill the OLD controller's tmux BEFORE clearing the record. Otherwise the supervisor sees
      // an empty record (!live) and launches a fresh controller while the old one is still running
      // → TWO concurrent controllers (observed: a restart left the 10h-old controller alive next to
      // the new one). Best-effort: the relaunch proceeds even if the stop fails.
      try { await d.nativeStop(ctrl!.sessionId); } catch { /* best-effort — supervisor still relaunches */ }
      await d.clearController();
      return ok({ action: 'restart', scheduled: true });
    }
    if (action === 'interrupt') {
      if (r.transport === 'cloud') {
        await d.cloudDrive({ sid, text: '[interrupt] stop the current action and await' });
      } else {
        await d.nativeInterrupt(sid);
      }
      return ok({ action: 'interrupt' });
    }
    if (action === 'stop') {
      if (r.transport === 'cloud') {
        const result = await d.cloudStop(sid);
        return ok({ action: 'stop', stopped: result.stopped });
      } else {
        await d.nativeStop(sid);
        return ok({ action: 'stop', stopped: true });
      }
    }
    return fail('INVALID_INPUT', `unknown action "${action}"`);
  } catch (e) {
    return fail('CONTROL_ERROR', (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// handleSessionAnswer — answer a pending AskUserQuestion
// ---------------------------------------------------------------------------

export interface SessionAnswerDeps {
  /** Call cloudAnswer for cloud sessions. */
  cloudAnswer: (opts: { sid: string; answer: string; toolUseId?: string }) => Promise<unknown>;
  /**
   * Send keys to a native tmux session to answer an AskUserQuestion.
   * `tmuxSession` = the tmux session name. `keys` = the key sequence(s) to send (e.g. "2" then "Enter").
   */
  nativeSendKeys: (tmuxSession: string, keys: string) => Promise<void>;
  /** Get the pending question (with options) for a native session — to resolve index for an option label. */
  nativeGetPendingQuestion: (sid: string) => Promise<import('../../terminal/ccr-cloud').PendingQuestion | null>;
  /** Resolve tmux session name for a native sid (throws if not in tmux). */
  nativeTmuxSession: (sid: string) => string;
  resolve: (sid: string) => ResolvedSession;
  /** Resolve a native session's bridge cse_… (controller / mission-bound native worker), or null. */
  bridgeCseFor?: (sid: string) => Promise<string | null>;
  /**
   * Answer a pending AskUserQuestion on a bridge session via its worker/events channel
   * (protocol-native control_response — works with no local tmux and from any node).
   */
  workerEventsAnswer?: (opts: { cse: string; answer: string; requestId?: string }) => Promise<unknown>;
}

function defaultSessionAnswerDeps(): SessionAnswerDeps {
  return {
    cloudAnswer: (opts) => {
      const { cloudAnswer: ca } = require('../../terminal/ccr-cloud') as typeof import('../../terminal/ccr-cloud');
      return ca(opts);
    },
    nativeSendKeys: async (tmuxSession, keys) => {
      const tmux = require('../../terminal/tmux') as typeof import('../../terminal/tmux');
      // Send keys literally (digit or text), then Enter.
      await tmux.sendKeys(tmuxSession, { keys, literal: true, enter: true, paneQualifier: null });
    },
    nativeGetPendingQuestion: async (sid) => {
      const { sessionVerdict } = require('../../terminal/cc-sessions') as typeof import('../../terminal/cc-sessions');
      const { extractPendingQuestion } = require('../../terminal/ccr-cloud') as typeof import('../../terminal/ccr-cloud');
      const verdict = sessionVerdict(sid);
      if (!verdict.jsonl) return null;
      const fs = require('fs') as typeof import('fs');
      let text = '';
      try { text = fs.readFileSync(verdict.jsonl, 'utf-8'); } catch { return null; }
      const lines: Array<{ message?: { content?: unknown[] } }> = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { lines.push(JSON.parse(line)); } catch { /* skip */ }
      }
      return extractPendingQuestion(lines);
    },
    nativeTmuxSession: (sid) => {
      const { sessionVerdict } = require('../../terminal/cc-sessions') as typeof import('../../terminal/cc-sessions');
      const v = sessionVerdict(sid);
      if (!v.tmuxSession) throw new Error(`session ${sid} is not in a tmux pane`);
      return v.tmuxSession;
    },
    resolve: (sid) => resolveMissionSession(sid, [], null),
    bridgeCseFor: defaultBridgeCseFor,
    workerEventsAnswer: (opts) => {
      const { cloudClientEventsAnswer } = require('../../terminal/ccr-cloud') as typeof import('../../terminal/ccr-cloud');
      return cloudClientEventsAnswer(opts);
    },
  };
}

/**
 * Answer a pending AskUserQuestion in a mission session.
 * Leader-anchored (write, failClosed): must run on the leader node.
 *
 * - cloud → delegates to cloudAnswer
 * - native → resolves the option index (1-based) for an option label, then sends the digit + Enter
 *            via raw tmux send-keys (NOT cc.prompt which asserts idle).
 *
 * @param sid     Session id
 * @param body    { answer: string; toolUseId?: string }
 * @param deps    Injected deps (default: defaultSessionAnswerDeps)
 * @param node    Target node (for cross-node proxy)
 * @param leader  Leader-anchor deps
 * @param proxyDeps Cross-node proxy deps
 */
export async function handleSessionAnswer(
  sid: string,
  body: { answer: string; toolUseId?: string; requestId?: string },
  deps?: SessionAnswerDeps,
  node?: string,
  leader?: LeaderAnchorDeps,
  proxyDeps?: SessionProxyDeps,
): Promise<Envelope> {
  const answer = (body.answer || '').toString().trim();
  if (!answer) return fail('INVALID_INPUT', 'answer is required');

  // Leader-anchor: answering a question is a write — must land on the leader.
  const anchored = await anchorToLeader(leader ?? realLeaderAnchor(), 'POST', `/mission/session/${encodeURIComponent(sid)}/answer`, body, true);
  if (anchored) return anchored;

  // Cross-node proxy: if `node` is set and != self, proxy to the target node.
  const self = thisNode();
  if (node && node !== self) {
    const pd = proxyDeps ?? defaultSessionProxyDeps();
    try {
      const result = await pd.proxyPost(node, `/mission/session/${encodeURIComponent(sid)}/answer`, body) as any;
      return proxyEnvelope(result);
    } catch (e) {
      return fail('PROXY_ERROR', (e as Error).message);
    }
  }

  const d = deps ?? defaultSessionAnswerDeps();
  const r = d.resolve(sid);

  try {
    if (r.transport === 'cloud') {
      const result = await d.cloudAnswer({ sid, answer, toolUseId: body.toolUseId });
      return ok({ answered: true, transport: 'cloud', result });
    } else {
      // Native: prefer the bridge worker/events channel for a `--remote-control` session
      // (protocol-native control_response — works with no local tmux, and cross-node). The
      // bridge auto-resolves the pending control_request's request_id when not given.
      if (d.bridgeCseFor && d.workerEventsAnswer) {
        const cse = await d.bridgeCseFor(sid).catch(() => null);
        if (cse) {
          const result = await d.workerEventsAnswer({ cse, answer, requestId: body.requestId });
          return ok({ answered: true, transport: 'bridge', cse, result });
        }
      }
      // Fall back to raw tmux send-keys for a pure-local native session with no bridge:
      // resolve the pending question's options to map answer → 1-based index digit.
      const pending = await d.nativeGetPendingQuestion(sid);
      const options = pending?.questions?.[0]?.options ?? [];
      const optIdx = options.findIndex(
        (o) => o.label === answer || o.label?.toLowerCase() === answer.toLowerCase(),
      );
      let keys: string;
      if (optIdx >= 0) {
        // 1-based index digit (AskUserQuestion dialogs use 1-based numbering).
        keys = String(optIdx + 1);
      } else {
        // Free text / fallback: send the answer text directly.
        keys = answer;
      }
      const tmuxSession = d.nativeTmuxSession(sid);
      await d.nativeSendKeys(tmuxSession, keys);
      return ok({ answered: true, transport: 'native', keys, mode: optIdx >= 0 ? 'option' : 'input' });
    }
  } catch (e) {
    return fail('ANSWER_ERROR', (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// isIdleExpired — pure helper (exported for reaper + tests)
// ---------------------------------------------------------------------------

export function isIdleExpired(opts: { lastActivityAt: number; now: number; idleMin: number }): boolean {
  return (opts.now - opts.lastActivityAt) > opts.idleMin * 60_000;
}

// ---------------------------------------------------------------------------
// Session status + resume
// ---------------------------------------------------------------------------

/** Terminal cloud session statuses (mirrors mission-controller.ts). */
const TERMINAL_CLOUD_STATUSES = ['stopped', 'completed', 'failed', 'error', 'archived'];

export type CloudStatusFn = (sid: string) => Promise<{ sid: string; status: string; raw: any }>;
export type NativeVerdictFn = (sid: string) => Promise<{ inTmux: boolean; tmuxSession: string | null; driveable: boolean }>;

/**
 * handleSessionStatus: resolve transport, check liveness.
 * Signature mirrors handleSessionRead (DI + cross-node proxy).
 *
 * @param deps        Session ops deps (resolver via deps.resolve)
 * @param node        Target node — if set and != thisNode(), proxy to that node
 * @param nativeVerdict  Injected native liveness check (default: sessionVerdict from cc-sessions)
 * @param cloudStatusFn  Injected cloud liveness check (default: cloudStatus from ccr-cloud)
 * @param proxyDeps   Cross-node proxy deps (default: proxyPost from peer-client)
 */
export async function handleSessionStatus(
  sid: string,
  deps?: SessionOpsDeps,
  node?: string,
  nativeVerdict?: NativeVerdictFn,
  cloudStatusFn?: CloudStatusFn,
  proxyDeps?: SessionProxyDeps,
): Promise<Envelope> {
  const self = thisNode();
  if (node && node !== self) {
    const pd = proxyDeps ?? defaultSessionProxyDeps();
    try {
      const result = await pd.proxyPost(node, `/mission/session/${encodeURIComponent(sid)}/status`, {}) as any;
      return proxyEnvelope(result);
    } catch (e) {
      return fail('PROXY_ERROR', (e as Error).message);
    }
  }

  const d = deps ?? defaultSessionOpsDeps();
  const r = d.resolve(sid);

  if (r.transport === 'cloud') {
    const getStatus: CloudStatusFn = cloudStatusFn ?? ((s) => {
      const { cloudStatus } = require('../../terminal/ccr-cloud') as typeof import('../../terminal/ccr-cloud');
      return cloudStatus(s);
    });
    try {
      const st = await getStatus(sid);
      const alive = !TERMINAL_CLOUD_STATUSES.includes(st.status);
      return ok({ transport: 'cloud', alive });
    } catch {
      // A thrown cloudStatus is a TRANSPORT/transient error (429/5xx/network), NOT a
      // confirmed terminal status — treat as alive (grace) so a blip doesn't falsely
      // prompt resume. (Mirrors executorLiveness's grace window.)
      return ok({ transport: 'cloud', alive: true });
    }
  } else {
    const getVerdict: NativeVerdictFn = nativeVerdict ?? ((s) => {
      const { sessionVerdict } = require('../../terminal/cc-sessions') as typeof import('../../terminal/cc-sessions');
      const v = sessionVerdict(s);
      return Promise.resolve({ inTmux: v.inTmux, tmuxSession: v.tmuxSession, driveable: v.inTmux });
    });
    try {
      const v = await getVerdict(sid);
      return ok({ transport: 'native', alive: v.inTmux });
    } catch {
      return ok({ transport: 'native', alive: false });
    }
  }
}

/** Deps for handleSessionResume — injected for testability. Mirrors ResumeWorkerDeps + idleMin. */
export interface SessionResumeDeps extends ResumeWorkerDeps {
  /** Idle minutes before auto-close (from project settings). */
  idleMin: number;
}

function defaultSessionResumeDeps(): SessionResumeDeps {
  // The existing native resume body (claude --resume <sid> --remote-control in the
  // mission worktree, preserves sid) — unchanged, just lifted to a named const so
  // both resumeNative and ensureLive.resumeDead can reuse it.
  const resumeNativeImpl = async (missionId: string | undefined, sid: string): Promise<{ sid: string; boundAt: number }> => {
    const { getMission, putMission } = require('../../mission/mission-store') as typeof import('../../mission/mission-store');
    const m = missionId ? await getMission(missionId) : null;
    if (!m) throw new Error(`mission ${missionId} not found for resume`);
    const { startNativeExecutor } = require('../../mission/mission-controller') as typeof import('../../mission/mission-controller');
    const { place } = require('../../mission/mission-model') as typeof import('../../mission/mission-model');
    const { listMissions: lm } = require('../../mission/mission-store') as typeof import('../../mission/mission-store');
    const { cloudListAccount, cloudDrive } = require('../../terminal/ccr-cloud') as typeof import('../../terminal/ccr-cloud');
    const { tmuxCcController } = require('../../terminal/tmux-backend') as typeof import('../../terminal/tmux-backend');
    const { gitCommand } = require('../../checkpoint/git-utils') as typeof import('../../checkpoint/git-utils');
    const { missionSessionTitle } = require('../../mission/mission-model') as typeof import('../../mission/mission-model');
    const pathmod = require('path') as typeof import('path');
    const all = await lm();
    const pd = place(m, all);
    if (!pd.go) throw new Error(`mission ${missionId} not placeable for resume: ${(pd as any).reason}`);
    const baselineArr = await cloudListAccount().then((ss: Array<{ sid: string }>) => ss.map((s) => s.sid)).catch(() => [] as string[]);
    const nativeDeps = {
      ensureWorktree: async (repo: string, dir: string, branch: string): Promise<string> => {
        const absRepo = pathmod.isAbsolute(repo) ? repo : pathmod.resolve(process.cwd(), repo);
        const absDir = pathmod.isAbsolute(dir) ? dir : pathmod.resolve(absRepo, dir);
        try { gitCommand(['worktree', 'add', absDir, '-b', branch], absRepo); }
        catch (err) { if (!/already exists|already checked out|is already/i.test((err as Error).message || '')) throw err; }
        return absDir;
      },
      // CHANGE (a): pass resume: sid → `claude --resume <sid>` continues the SAME session.
      launch: async (cwd: string): Promise<{ sessionId: string | null; tmuxSession: string }> => {
        const res = await tmuxCcController.launch({ cwd, resume: sid, remoteControl: true, skipPermissions: true, autoTrust: true, name: missionSessionTitle(m) });
        return { sessionId: (res.sessionId as string | null) ?? null, tmuxSession: res.tmuxSession as string };
      },
      listAccount: cloudListAccount,
      baseline: baselineArr,
      drive: async (s: string, text: string) => { await cloudDrive({ sid: s, text }).catch(() => {}); },
    };
    const decisionAny = pd as any;
    const repoRaw: string = (pd.go ? decisionAny.repo : null) || process.cwd();
    const repoAbs = pathmod.isAbsolute(repoRaw) ? repoRaw : pathmod.resolve(process.cwd(), repoRaw);
    const binding = await startNativeExecutor(m, { ...(pd.go ? pd : {}), repo: repoAbs }, nativeDeps);
    // CHANGE (b): PRESERVE the original sessionId (continuity); only the bridge cse is new.
    m.binding = { ...binding, sessionId: sid, boundAt: binding.boundAt ?? Date.now() };
    try { await putMission(m); } catch { /* best-effort persist */ }
    return { sid, boundAt: m.binding.boundAt ?? Date.now() };
  };

  return {
    resolve: (sid) => {
      const r = resolveMissionSession(sid, [], null);
      return { transport: r.transport, missionId: r.missionId };
    },
    cloudStatus: (sid) => {
      const { cloudStatus } = require('../../terminal/ccr-cloud') as typeof import('../../terminal/ccr-cloud');
      return cloudStatus(sid);
    },
    cloudWake: async (sid) => {
      const { cloudDrive } = require('../../terminal/ccr-cloud') as typeof import('../../terminal/ccr-cloud');
      await cloudDrive({ sid, text: 'Resume: continue your task where you left off.', reBootstrap: true });
    },
    nativeVerdict: (sid) => {
      const { sessionVerdict } = require('../../terminal/cc-sessions') as typeof import('../../terminal/cc-sessions');
      const v = sessionVerdict(sid);
      return { connectStrategy: v.connectStrategy, safeToCreateTmux: v.safeToCreateTmux, inTmux: v.inTmux };
    },
    resumeNative: resumeNativeImpl,
    ensureLive: async (sid, o) => {
      const { buildEnsureDeps } = require('../../terminal/live-rc-connect-deps') as typeof import('../../terminal/live-rc-connect-deps');
      const { ensureRemoteControlled } = require('../../terminal/live-rc-connect') as typeof import('../../terminal/live-rc-connect');
      const { getProjectSettings } = require('../../project-settings') as typeof import('../../project-settings');
      const idleMin = getProjectSettings().missionSessionIdleCloseMin ?? 30;
      const ensureDeps = buildEnsureDeps({
        // If the process already died between verdict and now, resume it the normal
        // way (same worktree, --resume sid, re-bridge). cse is unknown here → null.
        resumeDead: async (s) => {
          await resumeNativeImpl(o.missionId, s);
          return { ok: true };
        },
      });
      return ensureRemoteControlled(sid, { force: o.force, idleThresholdMs: idleMin * 60 * 1000 }, ensureDeps);
    },
    idleMin: (() => {
      const { getProjectSettings } = require('../../project-settings') as typeof import('../../project-settings');
      return getProjectSettings().missionSessionIdleCloseMin ?? 30;
    })(),
  };
}

/**
 * handleSessionResume: reactivate a cloud session (if alive) or relaunch a native session.
 * Leader-anchored (resume is a write — must land on the leader).
 *
 * @param sid        Session id
 * @param body       Optional { missionId } for native relaunch
 * @param deps       Injected deps (default: defaultSessionResumeDeps)
 * @param node       Target node (for cross-node proxy; unused in route — resume proxied via leader)
 * @param leader     Leader-anchor deps (default: realLeaderAnchor)
 */
export async function handleSessionResume(
  sid: string,
  body: { missionId?: string; force?: boolean },
  deps?: SessionResumeDeps,
  node?: string,
  leader?: LeaderAnchorDeps,
): Promise<Envelope> {
  // Leader-anchor: resume is a write (relaunching a session must run on the leader)
  const anchored = await anchorToLeader(leader, 'POST', `/mission/session/${encodeURIComponent(sid)}/resume`, body, true);
  if (anchored) return anchored;

  const d = deps ?? defaultSessionResumeDeps();
  const result = await resumeWorker(sid, body.missionId, d, { force: !!body.force });
  // Stamp autoCloseAt + reaper tracking only for a freshly-resumed native session.
  if (result.transport === 'native' && result.resumed && result.reason === 'ok') {
    const now = Date.now();
    const autoCloseAt = now + d.idleMin * 60_000;
    try { trackResumedNative(result.sid, body.missionId, now); } catch { /* best-effort */ }
    return ok({ ...result, autoCloseAt });
  }
  return ok(result);
}

export function createMissionRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    { method: 'POST', pattern: /^\/mission$/, handler: async (req) => handleCreate((req.body || {}) as Record<string, unknown>, thisNode(), undefined, undefined, realLeaderAnchor()) },
    { method: 'GET', pattern: /^\/mission$/, handler: async () => handleList(undefined, realLeaderAnchor()) },
    // literal routes BEFORE /:id so literals win
    // /mission/sessions — all operable sessions (controller + orchestrators + workers)
    { method: 'GET', pattern: /^\/mission\/sessions$/, handler: async () => handleAllSessions() },
    // controller BEFORE :id/:id/sessions so literals win
    { method: 'GET', pattern: /^\/mission\/controller$/, handler: async () => handleGetController() },
    // graph-query literals — MUST be before POST /mission/:id (which would match id='query'/'graph')
    { method: 'POST', pattern: /^\/mission\/query$/, handler: async (req) => handleQuery((req.body || {}) as Record<string, unknown>, undefined, realLeaderAnchor()) },
    { method: 'POST', pattern: /^\/mission\/graph$/, handler: async (req) => handleGraph((req.body || {}) as Record<string, unknown>, undefined, realLeaderAnchor()) },
    { method: 'POST', pattern: /^\/mission\/schedule$/, handler: async (req) => handleSchedule((req.body || {}) as Record<string, unknown>, undefined, realLeaderAnchor()) },
    { method: 'POST', pattern: /^\/mission\/changes$/, handler: async (req) => handleChanges((req.body || {}) as Record<string, unknown>, undefined, realLeaderAnchor()) },
    // view literals — MUST be before /mission/:id patterns (else POST /mission/views matches POST /mission/:id)
    { method: 'POST', pattern: /^\/mission\/views$/, handler: async (req) => handleViewSet((req.body || {}) as Record<string, unknown>, undefined, undefined, realLeaderAnchor()) },
    { method: 'GET', pattern: /^\/mission\/views$/, handler: async () => handleViewList(undefined, realLeaderAnchor()) },
    // rail routes: /place and /executor-status BEFORE /:id so literals win
    { method: 'GET', pattern: /^\/mission\/(?<id>[^/]+)\/place$/, handler: async (req) => handlePlace(req.params.id, undefined, realLeaderAnchor()) },
    { method: 'GET', pattern: /^\/mission\/(?<id>[^/]+)\/executor-status$/, handler: async (req) => handleExecutorStatus(req.params.id, undefined, undefined, realLeaderAnchor()) },
    // /mission/:id/sessions BEFORE /mission/:id so the literal suffix wins
    { method: 'GET', pattern: /^\/mission\/(?<id>[^/]+)\/sessions$/, handler: async (req) => handleSessions(req.params.id, undefined, undefined, realLeaderAnchor()) },
    // /mission/:id/tags BEFORE /mission/:id so the literal suffix wins
    { method: 'POST', pattern: /^\/mission\/(?<id>[^/]+)\/tags$/, handler: async (req) => handleTag(req.params.id, (req.body || {}) as Record<string, unknown>, undefined, undefined, realLeaderAnchor()) },
    // /mission/:id/history BEFORE /mission/:id so the literal suffix wins
    { method: 'GET', pattern: /^\/mission\/(?<id>[^/]+)\/history$/, handler: async (req) => {
        const rawLimit = req.query?.limit != null ? parseInt(String(req.query.limit), 10) : undefined;
        const limit = rawLimit != null && !Number.isNaN(rawLimit) ? rawLimit : undefined;
        const rawBeforeRev = req.query?.beforeRev != null ? parseInt(String(req.query.beforeRev), 10) : undefined;
        const beforeRev = rawBeforeRev != null && !Number.isNaN(rawBeforeRev) ? rawBeforeRev : undefined;
        return handleHistory(req.params.id, { limit, beforeRev }, realLeaderAnchor());
      } },
    // /mission/:id/neighbors BEFORE bare GET /mission/:id so suffix wins
    { method: 'POST', pattern: /^\/mission\/(?<id>[^/]+)\/neighbors$/, handler: async (req) => handleNeighbors(req.params.id, (req.body || {}) as Record<string, unknown>, undefined, realLeaderAnchor()) },
    // view suffix routes — /graph BEFORE /views/:id; both before bare GET /mission/:id
    { method: 'GET', pattern: /^\/mission\/views\/(?<id>[^/]+)\/graph$/, handler: async (req) => handleViewGraph(req.params.id, undefined, undefined, realLeaderAnchor()) },
    { method: 'POST', pattern: /^\/mission\/views\/(?<id>[^/]+)\/delete$/, handler: async (req) => handleViewDelete(req.params.id, undefined, realLeaderAnchor()) },
    { method: 'DELETE', pattern: /^\/mission\/views\/(?<id>[^/]+)$/, handler: async (req) => handleViewDelete(req.params.id, undefined, realLeaderAnchor()) },
    { method: 'GET', pattern: /^\/mission\/views\/(?<id>[^/]+)$/, handler: async (req) => handleViewGet(req.params.id, undefined, realLeaderAnchor()) },
    { method: 'GET', pattern: /^\/mission\/(?<id>[^/]+)$/, handler: async (req) => handleGet(req.params.id, undefined, realLeaderAnchor()) },
    { method: 'PATCH', pattern: /^\/mission\/(?<id>[^/]+)$/, handler: async (req) => handlePatch(req.params.id, (req.body || {}) as Record<string, unknown>, undefined, undefined, realLeaderAnchor()) },
    // POST /mission/:id — same semantics as PATCH, accepts MCP workerPost (POST-only)
    { method: 'POST', pattern: /^\/mission\/(?<id>[^/]+)$/, handler: async (req) => handlePatch(req.params.id, (req.body || {}) as Record<string, unknown>, undefined, undefined, realLeaderAnchor()) },
    // Session operability routes (read / drive / control) — literal /session/:sid/ prefix
    // Optional body field `node`: if set and != thisNode(), the local Core proxies to that node
    // server-side (browser never gets the hub Bearer token).
    // /mission/session/:sid/status and /resume BEFORE /read|drive|control (literal suffix wins)
    { method: 'GET', pattern: /^\/mission\/session\/(?<sid>[^/]+)\/status$/, handler: async (req) => {
        // I2: honor ?node= so a native session's liveness is checked on its OWN node
        // (not whatever node serves the browser's Core) — else a remote-but-alive
        // session reads as dead → a false resume prompt → a duplicate executor.
        const node = typeof req.query?.node === 'string' ? req.query.node : undefined;
        return handleSessionStatus(req.params.sid, undefined, node);
      } },
    { method: 'POST', pattern: /^\/mission\/session\/(?<sid>[^/]+)\/status$/, handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const node = typeof b.node === 'string' ? b.node : undefined;
        return handleSessionStatus(req.params.sid, undefined, node);
      } },
    { method: 'POST', pattern: /^\/mission\/session\/(?<sid>[^/]+)\/resume$/, handler: async (req) => {
        const body = (req.body || {}) as { missionId?: string; force?: boolean };
        return handleSessionResume(req.params.sid, body, undefined, undefined, realLeaderAnchor());
      } },
    { method: 'POST', pattern: /^\/mission\/session\/(?<sid>[^/]+)\/read$/, handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const lastN = typeof b.lastN === 'number' ? b.lastN : (typeof b.lastN === 'string' ? parseInt(b.lastN, 10) : undefined);
        const node = typeof b.node === 'string' ? b.node : undefined;
        return handleSessionRead(req.params.sid, lastN, undefined, node);
      } },
    { method: 'POST', pattern: /^\/mission\/session\/(?<sid>[^/]+)\/drive$/, handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const text = typeof b.text === 'string' ? b.text : '';
        const node = typeof b.node === 'string' ? b.node : undefined;
        return handleSessionDrive(req.params.sid, text, undefined, node);
      } },
    { method: 'POST', pattern: /^\/mission\/session\/(?<sid>[^/]+)\/control$/, handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const action = typeof b.action === 'string' ? b.action : '';
        const node = typeof b.node === 'string' ? b.node : undefined;
        return handleSessionControl(req.params.sid, action, undefined, node);
      } },
    // POST /mission/session/:sid/answer — answer a pending AskUserQuestion (bridge: worker/events
    // control_response; native: tmux send-keys; cloud: cloudAnswer). Leader-anchored (write).
    // Optional body fields: `requestId` (the bridge control_request id), `node` (cross-node proxy).
    { method: 'POST', pattern: /^\/mission\/session\/(?<sid>[^/]+)\/answer$/, handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const answer = typeof b.answer === 'string' ? b.answer : '';
        const toolUseId = typeof b.toolUseId === 'string' ? b.toolUseId : undefined;
        const requestId = typeof b.requestId === 'string' ? b.requestId : undefined;
        const node = typeof b.node === 'string' ? b.node : undefined;
        return handleSessionAnswer(req.params.sid, { answer, toolUseId, requestId }, undefined, node);
      } },
  ];
}
