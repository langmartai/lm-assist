/** Cross-node mission store backed by the data service (dataset `missions`, syncMode:'full'). */
import type { Mission, MissionBinding, MissionProgress, MissionResult, MissionAdjustment } from './mission-model';
import { withActorBackfill } from './mission-model';
import { getDataService } from '../data/data-service';
import type { CallCtx } from '../data/data-service';
import type { DataRecord } from '../data/types';
import { getHubConfig } from '../hub-client/hub-config';

const DATASET = 'missions';
const CONTROLLER_ID = '__controller__';

/** Controller session state — stored in the missions dataset under reserved key __controller__. */
export interface ControllerSession {
  node: string;
  sessionId: string;
  cse: string | null;
  tmux: string;
  startedAt: number;
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

/** This node's id, for stamping `ownerNode` on new missions. */
export function thisNode(): string { return getHubConfig().gatewayId ?? 'unknown'; }

export async function getMission(id: string, port: MissionDataPort = defaultPort()): Promise<Mission | null> {
  return port.get(id);
}
export async function listMissions(port: MissionDataPort = defaultPort()): Promise<Mission[]> {
  const all = await port.list();
  return all.filter((m) => m.id !== CONTROLLER_ID);
}
export async function listActiveMissions(port: MissionDataPort = defaultPort()): Promise<Mission[]> {
  const all = await port.list();
  return all.filter((m) => m.id !== CONTROLLER_ID && (m.status === 'active' || m.status === 'waiting'));
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
export async function putMission(m: Mission, port: MissionDataPort = defaultPort()): Promise<Mission> {
  m.updatedAt = Date.now();
  await port.put(m);
  return m;
}
export async function deleteMission(id: string, port: MissionDataPort = defaultPort()): Promise<void> {
  await port.del(id);
}
export async function findMissionBySession(sessionId: string, port: MissionDataPort = defaultPort()): Promise<Mission | null> {
  return (await port.list()).find((m) => m.binding?.sessionId === sessionId) ?? null;
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
