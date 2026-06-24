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

// --- testable handlers (port-injected) ---

async function actorFor(b: Record<string, unknown>): Promise<MissionActor> {
  const hint = b._actor as { channel?: string; toolUseId?: string | null } | undefined;
  delete (b as any)._actor;
  if (hint && hint.channel === 'mcp') return resolveMcpActor(hint.toolUseId, thisNode(), Date.now());
  return coarseActor('user', thisNode(), Date.now());
}

export async function handleCreate(b: Record<string, unknown>, ownerNode: string, port?: MissionDataPort, actor?: MissionActor): Promise<Envelope> {
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

export async function handleList(port?: MissionDataPort): Promise<Envelope> {
  return ok(await listMissions(port));
}

export async function handleGet(id: string, port?: MissionDataPort): Promise<Envelope> {
  const m = await getMission(id, port);
  return m ? ok(m) : fail('NOT_FOUND', `no mission ${id}`);
}

export async function handlePatch(id: string, b: Record<string, unknown>, port?: MissionDataPort, actor?: MissionActor): Promise<Envelope> {
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
): Promise<Envelope> {
  const doGetElection = getElection ?? (() => amIMonitor());
  const doGetJob = getJob ?? (() => getScheduledJobs().getJob('mission-controller'));
  const doGetLeaderHost = getLeaderHost ?? defaultGetLeaderHost;
  const [election, controllerSession] = await Promise.all([
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

export async function handleSessionRead(sid: string, lastN?: number, deps?: SessionOpsDeps): Promise<Envelope> {
  const d = deps ?? defaultSessionOpsDeps();
  const r = d.resolve(sid);
  try {
    if (r.transport === 'cloud') {
      const result = await d.cloudRead({ sid, lastN });
      // Cloud messages already have { role, text } from CloudTranscriptMsg — pass through as-is.
      const normalized = result.messages.map((m) => ({
        role: (m as any).role ?? 'assistant',
        text: (m as any).text ?? (m as any).content ?? '',
      }));
      return ok({ messages: normalized });
    } else {
      const result = await d.nativeRead(sid);
      // Native ConversationMessage has { role, content } — normalize content -> text for a uniform shape.
      const normalized = result.messages.map((m) => ({
        role: m.role,
        text: m.content,
      }));
      return ok({ messages: normalized });
    }
  } catch (e) {
    return fail('READ_ERROR', (e as Error).message);
  }
}

export async function handleSessionDrive(sid: string, text: string, deps?: SessionOpsDeps): Promise<Envelope> {
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

export async function handleSessionControl(sid: string, action: string, deps?: SessionOpsDeps): Promise<Envelope> {
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

export function createMissionRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    { method: 'POST', pattern: /^\/mission$/, handler: async (req) => handleCreate((req.body || {}) as Record<string, unknown>, thisNode()) },
    { method: 'GET', pattern: /^\/mission$/, handler: async () => handleList() },
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
    { method: 'PATCH', pattern: /^\/mission\/(?<id>[^/]+)$/, handler: async (req) => handlePatch(req.params.id, (req.body || {}) as Record<string, unknown>) },
    // POST /mission/:id — same semantics as PATCH, accepts MCP workerPost (POST-only)
    { method: 'POST', pattern: /^\/mission\/(?<id>[^/]+)$/, handler: async (req) => handlePatch(req.params.id, (req.body || {}) as Record<string, unknown>) },
    // Session operability routes (read / drive / control) — literal /session/:sid/ prefix
    { method: 'POST', pattern: /^\/mission\/session\/(?<sid>[^/]+)\/read$/, handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const lastN = typeof b.lastN === 'number' ? b.lastN : (typeof b.lastN === 'string' ? parseInt(b.lastN, 10) : undefined);
        return handleSessionRead(req.params.sid, lastN);
      } },
    { method: 'POST', pattern: /^\/mission\/session\/(?<sid>[^/]+)\/drive$/, handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const text = typeof b.text === 'string' ? b.text : '';
        return handleSessionDrive(req.params.sid, text);
      } },
    { method: 'POST', pattern: /^\/mission\/session\/(?<sid>[^/]+)\/control$/, handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const action = typeof b.action === 'string' ? b.action : '';
        return handleSessionControl(req.params.sid, action);
      } },
  ];
}
