/** Mission CRUD + controller status. Bare {success,data}/{success,error} envelope (like worker.routes). */
import type { RouteHandler, RouteContext } from '../index';
import { randomBytes } from 'crypto';
import { newMission, Mission, MissionStatus, Isolation, coarseActor, MissionActor, place, ExecutorState } from '../../mission/mission-model';
import { resolveMcpActor } from '../../mission/mission-actor';
import {
  MissionDataPort, getMission, listMissions, putMission, thisNode, getControllerSession,
} from '../../mission/mission-store';
import { resolveMissionSession, ResolvedSession } from '../../mission/mission-session-resolver';
import type { Transport, SessionRole } from '../../mission/mission-session-resolver';
import { amIMonitor } from '../../monitor/stall-election';
import { getScheduledJobs } from '../../scheduler/scheduled-jobs';
import { listRecords } from '../../worker-role/worker-store';
import type { WorkerRecord } from '../../worker-role/types';

interface Envelope { success: boolean; data?: unknown; error?: { code: string; message: string }; }
const ok = <T>(data: T): Envelope => ({ success: true, data });
const fail = (code: string, message: string): Envelope => ({ success: false, error: { code, message } });
const genId = () => 'mission_' + randomBytes(4).toString('hex');
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
  if (hint && hint.channel === 'mcp') return resolveMcpActor(hint.toolUseId, thisNode(), Date.now());
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
  const m = newMission({
    title, objective, ownerNode, createdBy: who,
    projects: arr(b.projects), dependsOn: arr(b.dependsOn),
    plan: str(b.plan), nextSteps: arr(b.nextSteps),
    env: {
      isolation: (str(env.isolation) as Isolation) ?? 'cloud',
      host: str(env.host), repo: str(env.repo), branch: str(env.branch),
      resources: arr(env.resources) ?? [],
      exclusive: env.exclusive === true || env.exclusive === 'true',
    },
  }, Date.now(), genId);
  await putMission(m, port);
  return ok(m);
}

export async function handleList(port?: MissionDataPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'GET', '/mission');
  if (anchored) return anchored;
  return ok(await listMissions(port));
}

export async function handleGet(id: string, port?: MissionDataPort): Promise<Envelope> {
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
  if (arr(b.dependsOn)) m.dependsOn = arr(b.dependsOn)!;
  if (arr(b.projects)) m.projects = arr(b.projects)!;
  const sv = str(b.status) as MissionStatus | undefined;
  if (sv) { if (!VALID_STATUS.has(sv)) return fail('INVALID_INPUT', `invalid status "${sv}"`); m.status = sv; }
  if (b.env && typeof b.env === 'object') {
    const e = b.env as Record<string, unknown>;
    if (str(e.isolation)) m.env.isolation = str(e.isolation) as Isolation;
    if (str(e.host) !== undefined) m.env.host = str(e.host);
    if (str(e.repo) !== undefined) m.env.repo = str(e.repo);
    if (str(e.branch) !== undefined) m.env.branch = str(e.branch);
    if (arr(e.resources)) m.env.resources = arr(e.resources)!;
    if (e.exclusive !== undefined) m.env.exclusive = e.exclusive === true || e.exclusive === 'true';
  }
  m.lastUpdatedBy = who;
  m.adjustments.push({ at: Date.now(), trigger: 'user-edit', change: 'mission updated via API', by: 'user', actor: who });
  await putMission(m, port);
  return ok(m);
}

// ---------------------------------------------------------------------------
// Rail handlers (place + executor-status)
// ---------------------------------------------------------------------------

export async function handlePlace(id: string, port?: MissionDataPort): Promise<Envelope> {
  const m = await getMission(id, port);
  if (!m) return fail('NOT_FOUND', `no mission ${id}`);
  const all = await listMissions(port);
  return ok(place(m, all));
}

export async function handleExecutorStatus(
  id: string,
  port?: MissionDataPort,
  readExec?: (m: Mission) => Promise<ExecutorState>,
): Promise<Envelope> {
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
): Promise<Envelope> {
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
  nativeDrive: (sid: string, text: string) => Promise<void>;
  nativeInterrupt: (sid: string) => Promise<void>;
  nativeStop: (sid: string) => Promise<void>;
  clearController: () => Promise<void>;
  getControllerSession: () => Promise<{ sessionId: string; cse: string | null } | null>;
  resolve: (sid: string) => ResolvedSession;
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
      return ok({ messages: normalized });
    } else {
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
      return ok({ messages: normalized });
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
      return ok({ transport: 'cloud', alive: false });
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

/** Deps for handleSessionResume — injected for testability. */
export interface SessionResumeDeps {
  /** Resolve transport for a sid (pure sync). */
  resolve: (sid: string) => { sid: string; transport: Transport; missionId: string | null; role: SessionRole };
  /** Check cloud session liveness (throws or returns terminal status → gone). */
  cloudStatus: CloudStatusFn;
  /** Relaunch a native session for the given missionId; returns the new sid. */
  relaunch: (missionId: string | undefined) => Promise<{ sid: string; boundAt: number }>;
  /** Idle minutes before auto-close (from project settings). */
  idleMin: number;
}

function defaultSessionResumeDeps(): SessionResumeDeps {
  return {
    resolve: (sid) => resolveMissionSession(sid, [], null),
    cloudStatus: (sid) => {
      const { cloudStatus } = require('../../terminal/ccr-cloud') as typeof import('../../terminal/ccr-cloud');
      return cloudStatus(sid);
    },
    relaunch: async (missionId) => {
      const { getMission } = require('../../mission/mission-store') as typeof import('../../mission/mission-store');
      const m = missionId ? await getMission(missionId) : null;
      if (!m) throw new Error(`mission ${missionId} not found for relaunch`);
      const { startNativeExecutor } = require('../../mission/mission-controller') as typeof import('../../mission/mission-controller');
      const { place } = require('../../mission/mission-model') as typeof import('../../mission/mission-model');
      const { listMissions: lm } = require('../../mission/mission-store') as typeof import('../../mission/mission-store');
      const all = await lm();
      const pd = place(m, all);
      if (!pd.go) throw new Error(`mission ${missionId} not placeable for relaunch: ${(pd as any).reason}`);
      // Build native start deps (same pattern as mission-controller.ts startCloudExecutor native path)
      const { cloudListAccount, cloudDrive } = require('../../terminal/ccr-cloud') as typeof import('../../terminal/ccr-cloud');
      const { pickNewSession, cseToSessionSid } = require('../../mission/mission-native') as typeof import('../../mission/mission-native');
      const { tmuxCcController } = require('../../terminal/tmux-backend') as typeof import('../../terminal/tmux-backend');
      const { gitCommand } = require('../../checkpoint/git-utils') as typeof import('../../checkpoint/git-utils');
      const { missionSessionTitle } = require('../../mission/mission-model') as typeof import('../../mission/mission-model');
      const pathmod = require('path') as typeof import('path');
      const baselineArr = await cloudListAccount().then((ss: Array<{ sid: string }>) => ss.map((s) => s.sid)).catch(() => [] as string[]);
      const nativeDeps = {
        ensureWorktree: async (repo: string, dir: string, branch: string): Promise<string> => {
          const absRepo = pathmod.isAbsolute(repo) ? repo : pathmod.resolve(process.cwd(), repo);
          const absDir = pathmod.isAbsolute(dir) ? dir : pathmod.resolve(absRepo, dir);
          try {
            gitCommand(['worktree', 'add', absDir, '-b', branch], absRepo);
          } catch (err) {
            if (!/already exists|already checked out|is already/i.test((err as Error).message || '')) throw err;
          }
          return absDir;
        },
        launch: async (cwd: string): Promise<{ sessionId: string | null; tmuxSession: string }> => {
          const res = await tmuxCcController.launch({ cwd, remoteControl: true, skipPermissions: true, autoTrust: true, name: missionSessionTitle(m) });
          return { sessionId: (res.sessionId as string | null) ?? null, tmuxSession: res.tmuxSession as string };
        },
        listAccount: cloudListAccount,
        baseline: baselineArr,
        drive: async (sid: string, text: string) => {
          await cloudDrive({ sid, text }).catch((e: Error) => {
            console.debug(`[mission-resume] drive to ${sid} failed: ${e.message}`);
          });
        },
      };
      const decisionAny = pd as any;
      const repoRaw: string = (pd.go ? decisionAny.repo : null) || process.cwd();
      const repoAbs = pathmod.isAbsolute(repoRaw) ? repoRaw : pathmod.resolve(process.cwd(), repoRaw);
      const binding = await startNativeExecutor(m, { ...(pd.go ? pd : {}), repo: repoAbs }, nativeDeps);
      if (!binding.sessionId) throw new Error('native relaunch did not resolve a session id');
      return { sid: binding.sessionId, boundAt: binding.boundAt ?? Date.now() };
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
  body: { missionId?: string },
  deps?: SessionResumeDeps,
  node?: string,
  leader?: LeaderAnchorDeps,
): Promise<Envelope> {
  // Leader-anchor: resume is a write (relaunching a session must run on the leader)
  const anchored = await anchorToLeader(leader, 'POST', `/mission/session/${encodeURIComponent(sid)}/resume`, body, true);
  if (anchored) return anchored;

  const d = deps ?? defaultSessionResumeDeps();
  const r = d.resolve(sid);

  if (r.transport === 'cloud') {
    // Cloud: check if alive; if so, it's already running (nothing to do)
    try {
      const st = await d.cloudStatus(sid);
      if (TERMINAL_CLOUD_STATUSES.includes(st.status)) {
        return ok({ resumed: false, reason: 'gone', transport: 'cloud' });
      }
      return ok({ resumed: true, sid, transport: 'cloud' });
    } catch {
      return ok({ resumed: false, reason: 'gone', transport: 'cloud' });
    }
  }

  // Native: relaunch via the injected dep
  try {
    const launched = await d.relaunch(body.missionId);
    const autoCloseAt = Date.now() + d.idleMin * 60_000;
    return ok({ resumed: true, sid: launched.sid, transport: 'native', autoCloseAt });
  } catch (e) {
    return fail('RELAUNCH_ERROR', (e as Error).message);
  }
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
    // rail routes: /place and /executor-status BEFORE /:id so literals win
    { method: 'GET', pattern: /^\/mission\/(?<id>[^/]+)\/place$/, handler: async (req) => handlePlace(req.params.id) },
    { method: 'GET', pattern: /^\/mission\/(?<id>[^/]+)\/executor-status$/, handler: async (req) => handleExecutorStatus(req.params.id) },
    // /mission/:id/sessions BEFORE /mission/:id so the literal suffix wins
    { method: 'GET', pattern: /^\/mission\/(?<id>[^/]+)\/sessions$/, handler: async (req) => handleSessions(req.params.id) },
    { method: 'GET', pattern: /^\/mission\/(?<id>[^/]+)$/, handler: async (req) => handleGet(req.params.id) },
    { method: 'PATCH', pattern: /^\/mission\/(?<id>[^/]+)$/, handler: async (req) => handlePatch(req.params.id, (req.body || {}) as Record<string, unknown>, undefined, undefined, realLeaderAnchor()) },
    // POST /mission/:id — same semantics as PATCH, accepts MCP workerPost (POST-only)
    { method: 'POST', pattern: /^\/mission\/(?<id>[^/]+)$/, handler: async (req) => handlePatch(req.params.id, (req.body || {}) as Record<string, unknown>, undefined, undefined, realLeaderAnchor()) },
    // Session operability routes (read / drive / control) — literal /session/:sid/ prefix
    // Optional body field `node`: if set and != thisNode(), the local Core proxies to that node
    // server-side (browser never gets the hub Bearer token).
    // /mission/session/:sid/status and /resume BEFORE /read|drive|control (literal suffix wins)
    { method: 'GET', pattern: /^\/mission\/session\/(?<sid>[^/]+)\/status$/, handler: async (req) => handleSessionStatus(req.params.sid) },
    { method: 'POST', pattern: /^\/mission\/session\/(?<sid>[^/]+)\/status$/, handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const node = typeof b.node === 'string' ? b.node : undefined;
        return handleSessionStatus(req.params.sid, undefined, node);
      } },
    { method: 'POST', pattern: /^\/mission\/session\/(?<sid>[^/]+)\/resume$/, handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const missionId = typeof b.missionId === 'string' ? b.missionId : undefined;
        return handleSessionResume(req.params.sid, { missionId }, undefined, undefined, realLeaderAnchor());
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
  ];
}
