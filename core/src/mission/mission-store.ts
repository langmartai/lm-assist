/** Cross-node mission store backed by the data service (dataset `missions`, syncMode:'full'). */
import type { Mission, MissionBinding, MissionProgress, MissionResult, MissionAdjustment } from './mission-model';
import { withActorBackfill } from './mission-model';
import { getDataService } from '../data/data-service';
import type { CallCtx } from '../data/data-service';
import type { DataRecord } from '../data/types';
import { getHubConfig } from '../hub-client/hub-config';

const DATASET = 'missions';

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
function recordToMission(fields: Record<string, unknown>): Mission {
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
  return port.list();
}
export async function listActiveMissions(port: MissionDataPort = defaultPort()): Promise<Mission[]> {
  return (await port.list()).filter((m) => m.status === 'active' || m.status === 'waiting');
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
