/** Cross-node mission store backed by the data service (dataset `missions`, syncMode:'full'). */
import type { Mission, MissionBinding, MissionProgress, MissionResult, MissionAdjustment, MissionChange, MissionActor } from './mission-model';
import { withActorBackfill } from './mission-model';
import { appendHistory } from './mission-history';
import { getDataService } from '../data/data-service';
import { getProjectSettings } from '../project-settings';
import type { CallCtx } from '../data/data-service';
import type { DataRecord } from '../data/types';
import { getHubConfig } from '../hub-client/hub-config';

const DATASET = 'missions';
const CONTROLLER_ID = '__controller__';
const ENGAGEMENT_ID = '__engagement__';
/** Reserved record ids in the missions dataset that are NOT user missions. */
const RESERVED_IDS = new Set([CONTROLLER_ID, ENGAGEMENT_ID]);

const HISTORY_DATASET = 'mission-history';

export interface MissionHistoryRecord {
  id: string;            // `${missionId}:${rev}`
  missionId: string;
  rev: number;
  at: number;
  actor: import('./mission-model').MissionActor;
  changes: Record<string, { from: unknown; to: unknown }>;
}
export interface MissionHistoryPort {
  isEnabled(): boolean;
  put(rec: MissionHistoryRecord): Promise<void>;
  query(missionId: string, opts: { limit?: number; beforeRev?: number }): Promise<MissionHistoryRecord[]>;
}

/** Wave-4 engagement bookkeeping — stored under reserved key __engagement__. */
export interface EngagementState {
  lastEngagedAt: number | null;
  lastActiveIds: string[];
  seen: Record<string, { alive: boolean; gated: boolean; cursor: number }>;
  /** Stable key of THIS node's in-cluster roster (sorted gatewayIds). When it changes,
   *  the supervisor force-engages the controller so it re-scopes its cluster. Absent
   *  until the first observation (which sets the baseline without a spurious drive). */
  lastRosterKey?: string;
  /** Whether any mission has had a session update (material or interim) since the last
   *  engagement. Gates the safety-interval fallback in shouldEngage so it never fires on
   *  pure elapsed time alone. Cleared (false) whenever an engage actually happens. */
  dirtySinceEngage?: boolean;
  /** Ids that were SCHEDULABLE and UNBOUND last tick — lets shouldEngage tell NEW unplaced
   *  work from the same unplaced work it already raised (bl_28543c78). */
  lastReadyUnbound?: string[];
  /** Consecutive ticks each mission has been schedulable-and-unbound. Drives the
   *  starvation safety net; rebuilt from the current set every tick, so ids that get
   *  placed simply disappear. */
  unplacedTicks?: Record<string, number>;
}

/** Controller session state — stored in the missions dataset under reserved key __controller__. */
export interface ControllerSession {
  node: string;
  sessionId: string;
  cse: string | null;
  tmux: string;
  startedAt: number;
  /** Unix-ms of the last full adapt-DRIVE pass (set by supervisor on 'drive'). Absent = never driven. */
  lastDriveAt?: number;
}

/** The seam the store reads/writes through. Tests inject an in-memory fake. */
export interface MissionDataPort {
  isEnabled(): boolean;
  get(id: string): Promise<Mission | null>;
  list(): Promise<Mission[]>;
  put(m: Mission): Promise<void>;
  del(id: string): Promise<void>;
}

function systemCtx(): CallCtx { return { principal: { type: 'local' } }; }

function missionToRecord(m: Mission): DataRecord {
  const now = new Date().toISOString();
  return { id: m.id, version: 0, fields: { ...m } as Record<string, unknown>, createdAt: now, updatedAt: now };
}
function isControllerFields(fields: Record<string, unknown>): boolean {
  // Controller records have node+sessionId+tmux+startedAt but no title — distinguish from missions.
  return !!(fields.node && fields.sessionId && fields.tmux && !fields.title);
}
function recordToMission(fields: Record<string, unknown>): Mission {
  if (isControllerFields(fields)) {
    // Shouldn't be called on controller records from normal list/get path — but guard just in case.
    return fields as unknown as Mission;
  }
  return withActorBackfill(fields as unknown as Mission);
}

let ensured = false;
async function ensureDataset(svc: ReturnType<typeof getDataService>): Promise<void> {
  if (ensured) return;
  try {
    await svc.createDataset(systemCtx(), {
      id: DATASET, backend: 'cache', title: 'Missions',
      visibility: 'cross-node-readable', syncMode: 'full', config: { kind: 'cache' },
    } as any);
  } catch { /* already exists — fine */ }
  ensured = true;
}

/** The live adapter over getDataService(). dataServiceEnabled off => isEnabled() false => no-op/empty. */
function livePort(): MissionDataPort {
  return {
    isEnabled: () => getDataService().isEnabled(),
    get: async (id) => {
      const svc = getDataService();
      if (!svc.isEnabled()) return null;
      await ensureDataset(svc);
      const r = await svc.get(systemCtx(), DATASET, id);
      return r.ok && r.value ? recordToMission(r.value.fields) : null;
    },
    list: async () => {
      const svc = getDataService();
      if (!svc.isEnabled()) return [];
      await ensureDataset(svc);
      const r = await svc.query(systemCtx(), DATASET, { limit: 10000 } as any);
      return r.ok ? r.value.records.map((rec) => recordToMission(rec.fields)) : [];
    },
    put: async (m) => {
      const svc = getDataService();
      if (!svc.isEnabled()) return;
      await ensureDataset(svc);
      await svc.put(systemCtx(), DATASET, missionToRecord(m));
    },
    del: async (id) => {
      const svc = getDataService();
      if (!svc.isEnabled()) return;
      await ensureDataset(svc);
      await svc.del(systemCtx(), DATASET, id);
    },
  };
}

let _default: MissionDataPort | null = null;
function defaultPort(): MissionDataPort { return _default ?? (_default = livePort()); }

let historyEnsured = false;
async function ensureHistoryDataset(svc: ReturnType<typeof getDataService>): Promise<void> {
  if (historyEnsured) return;
  try {
    await svc.createDataset(systemCtx(), {
      id: HISTORY_DATASET, backend: 'cache', title: 'Mission History',
      visibility: 'cross-node-readable', syncMode: 'full', config: { kind: 'cache' },
    } as any);
  } catch { /* already exists — fine */ }
  historyEnsured = true;
}

function liveHistoryPort(): MissionHistoryPort {
  return {
    isEnabled: () => getDataService().isEnabled(),
    put: async (rec) => {
      const svc = getDataService();
      if (!svc.isEnabled()) return;
      await ensureHistoryDataset(svc);
      const now = new Date().toISOString();
      await svc.put(systemCtx(), HISTORY_DATASET, { id: rec.id, version: 0, fields: { ...rec } as Record<string, unknown>, createdAt: now, updatedAt: now });
    },
    query: async (missionId, opts) => {
      const svc = getDataService();
      if (!svc.isEnabled()) return [];
      await ensureHistoryDataset(svc);
      const filter: Array<{ field: string; op: string; value: unknown }> = [{ field: 'missionId', op: 'eq', value: missionId }];
      if (typeof opts.beforeRev === 'number') filter.push({ field: 'rev', op: 'lt', value: opts.beforeRev });
      const r = await svc.query(systemCtx(), HISTORY_DATASET, { filter, sort: [{ field: 'rev', dir: 'desc' }], limit: opts.limit ?? 50 } as any);
      return r.ok ? r.value.records.map((rec) => rec.fields as unknown as MissionHistoryRecord) : [];
    },
  };
}
let _historyDefault: MissionHistoryPort | null = null;
function defaultHistoryPort(): MissionHistoryPort { return _historyDefault ?? (_historyDefault = liveHistoryPort()); }

/** Best-effort durable append of one change to the unbounded mission-history dataset. */
export async function appendMissionHistory(missionId: string, change: MissionChange, port: MissionHistoryPort = defaultHistoryPort()): Promise<void> {
  if (!port.isEnabled()) return;
  await port.put({ id: `${missionId}:${change.rev}`, missionId, rev: change.rev, at: change.at, actor: change.actor, changes: change.changes });
}
/** Page the full history trail, newest-first. */
export async function listMissionHistory(missionId: string, opts: { limit?: number; beforeRev?: number } = {}, port: MissionHistoryPort = defaultHistoryPort()): Promise<MissionHistoryRecord[]> {
  return port.query(missionId, opts);
}

/** This node's id, for stamping `ownerNode` on new missions. */
export function thisNode(): string { return getHubConfig().gatewayId ?? 'unknown'; }

export async function getMission(id: string, port: MissionDataPort = defaultPort()): Promise<Mission | null> {
  return port.get(id);
}
export async function listMissions(port: MissionDataPort = defaultPort()): Promise<Mission[]> {
  const all = await port.list();
  return all.filter((m) => !RESERVED_IDS.has(m.id));
}
/** Pure: the missions the supervisor should engage on. Standby is excluded — a
 *  human is running that session, so it must not arm the controller's timers. */
export function selectActive<T extends { id: string; status: string; manageMode?: string }>(all: T[]): T[] {
  return all.filter((m) =>
    !RESERVED_IDS.has(m.id)
    && (m.status === 'active' || m.status === 'waiting')
    && m.manageMode !== 'standby');
}

export async function listActiveMissions(port: MissionDataPort = defaultPort()): Promise<Mission[]> {
  return selectActive(await port.list());
}

// ---------------------------------------------------------------------------
// Controller session state (reserved key __controller__ in missions dataset)
// ---------------------------------------------------------------------------

/** Get the persisted controller session (null if none or not started). */
export async function getControllerSession(port: MissionDataPort = defaultPort()): Promise<ControllerSession | null> {
  const raw = await port.get(CONTROLLER_ID);
  if (!raw) return null;
  // The raw record was stored as a mission-shaped object wrapping ControllerSession in its fields.
  // But MissionDataPort.get() returns Mission — we stored the ControllerSession in the fields slot.
  // We stored it via put() using a cast, so `raw` is actually the ControllerSession fields.
  const f = raw as unknown as Record<string, unknown>;
  if (!f.sessionId) return null;
  return { node: f.node as string, sessionId: f.sessionId as string, cse: (f.cse as string | null) ?? null, tmux: f.tmux as string, startedAt: f.startedAt as number };
}

/** Persist a controller session (null clears it). */
export async function putControllerSession(cs: ControllerSession | null, port: MissionDataPort = defaultPort()): Promise<void> {
  if (cs === null) {
    await port.del(CONTROLLER_ID);
    return;
  }
  // Store ControllerSession by casting it as a Mission (the port doesn't inspect the shape beyond id).
  await port.put({ id: CONTROLLER_ID, ...cs } as unknown as Mission);
}
export async function putMission(
  m: Mission,
  port: MissionDataPort = defaultPort(),
  opts: { actor?: MissionActor; historyPort?: MissionHistoryPort; inlineCap?: number } = {},
): Promise<Mission> {
  // Reserved records (__controller__/__engagement__) are not real missions — never version them.
  if (RESERVED_IDS.has(m.id)) { m.updatedAt = Date.now(); await port.put(m); return m; }
  const prev = await port.get(m.id);
  const { mission, change } = appendHistory(m, prev, opts.actor, opts.inlineCap ?? (getProjectSettings().missionHistoryInlineCap ?? 50));
  mission.updatedAt = Date.now();
  await port.put(mission);
  if (change) {
    try { await appendMissionHistory(mission.id, change, opts.historyPort); } catch { /* best-effort durable spill */ }
  }
  return mission;
}
export async function deleteMission(id: string, port: MissionDataPort = defaultPort()): Promise<void> {
  await port.del(id);
}
export async function findMissionBySession(sessionId: string, port: MissionDataPort = defaultPort()): Promise<Mission | null> {
  return (await port.list()).find((m) => m.binding?.sessionId === sessionId) ?? null;
}
/** Find a mission whose binding matches sid either as a plain sessionId OR a bridge ccr.sid (onboarded rails). */
export async function findMissionBySessionOrCcr(sid: string, port: MissionDataPort = defaultPort()): Promise<Mission | null> {
  return (await port.list()).find((m) => !RESERVED_IDS.has(m.id) && (m.binding?.sessionId === sid || m.binding?.ccr?.sid === sid)) ?? null;
}
export async function bindExecutor(id: string, binding: MissionBinding, port: MissionDataPort = defaultPort()): Promise<Mission | null> {
  const m = await port.get(id);
  if (!m) return null;
  m.binding = { ...binding, boundAt: Date.now() };
  return putMission(m, port);
}
export async function recordAdjustment(id: string, adj: MissionAdjustment, port: MissionDataPort = defaultPort()): Promise<Mission | null> {
  const m = await port.get(id);
  if (!m) return null;
  m.adjustments.push(adj);
  return putMission(m, port);
}
export async function mirrorProgress(id: string, progress: MissionProgress, results: MissionResult[] = [], port: MissionDataPort = defaultPort()): Promise<Mission | null> {
  const m = await port.get(id);
  if (!m) return null;
  m.progress = progress;
  if (results.length) m.results.push(...results);
  return putMission(m, port);
}

// ---------------------------------------------------------------------------
// Wave-4 engagement state (reserved key __engagement__ in missions dataset)
// ---------------------------------------------------------------------------

/** Read the engagement bookkeeping (defaults when absent). */
export async function getEngagementState(port: MissionDataPort = defaultPort()): Promise<EngagementState> {
  const raw = await port.get(ENGAGEMENT_ID);
  const f = (raw as unknown as Record<string, unknown> | null) || null;
  if (!f) return { lastEngagedAt: null, lastActiveIds: [], seen: {} };
  return {
    lastEngagedAt: (f.lastEngagedAt as number | null) ?? null,
    lastActiveIds: Array.isArray(f.lastActiveIds) ? (f.lastActiveIds as string[]) : [],
    seen: (f.seen as EngagementState['seen']) ?? {},
    lastRosterKey: typeof f.lastRosterKey === 'string' ? (f.lastRosterKey as string) : undefined,
    dirtySinceEngage: typeof f.dirtySinceEngage === 'boolean' ? (f.dirtySinceEngage as boolean) : undefined,
    lastReadyUnbound: Array.isArray(f.lastReadyUnbound) ? (f.lastReadyUnbound as string[]) : undefined,
    unplacedTicks: (f.unplacedTicks && typeof f.unplacedTicks === 'object')
      ? (f.unplacedTicks as Record<string, number>) : undefined,
  };
}

/** Persist the engagement bookkeeping. */
export async function putEngagementState(s: EngagementState, port: MissionDataPort = defaultPort()): Promise<void> {
  await port.put({ id: ENGAGEMENT_ID, ...s } as unknown as Mission);
}

/** Set a mission's token-free interim progress line (Wave 4 — supervisor-written, not the controller). */
export async function setMissionInterim(id: string, interim: { at: number; text: string }, port: MissionDataPort = defaultPort()): Promise<Mission | null> {
  const m = await port.get(id);
  if (!m) return null;
  m.interim = interim;
  return putMission(m, port);
}
