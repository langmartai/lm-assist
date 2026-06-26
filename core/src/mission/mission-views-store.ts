/** Cross-node mission-view store backed by the data service (dataset `mission-views`, syncMode:'full'). */
import type { MissionView } from './mission-views';
import { getDataService } from '../data/data-service';
import type { CallCtx } from '../data/data-service';
import type { DataRecord } from '../data/types';

const DATASET = 'mission-views';
function systemCtx(): CallCtx { return { principal: { type: 'local' } }; }

export interface MissionViewPort {
  isEnabled(): boolean;
  get(id: string): Promise<MissionView | null>;
  list(): Promise<MissionView[]>;
  put(v: MissionView): Promise<void>;
  del(id: string): Promise<void>;
}

let ensured = false;
async function ensureDataset(svc: ReturnType<typeof getDataService>): Promise<void> {
  if (ensured) return;
  try {
    await svc.createDataset(systemCtx(), { id: DATASET, backend: 'cache', title: 'Mission Views', visibility: 'cross-node-readable', syncMode: 'full', config: { kind: 'cache' } } as any);
  } catch { /* already exists — fine */ }
  ensured = true;
}

function livePort(): MissionViewPort {
  return {
    isEnabled: () => getDataService().isEnabled(),
    get: async (id) => { const svc = getDataService(); if (!svc.isEnabled()) return null; await ensureDataset(svc); const r = await svc.get(systemCtx(), DATASET, id); return r.ok && r.value ? (r.value.fields as unknown as MissionView) : null; },
    list: async () => { const svc = getDataService(); if (!svc.isEnabled()) return []; await ensureDataset(svc); const r = await svc.query(systemCtx(), DATASET, { limit: 10000 } as any); return r.ok ? r.value.records.map((rec) => rec.fields as unknown as MissionView) : []; },
    put: async (v) => { const svc = getDataService(); if (!svc.isEnabled()) return; await ensureDataset(svc); const now = new Date().toISOString(); await svc.put(systemCtx(), DATASET, { id: v.id, version: 0, fields: { ...v } as Record<string, unknown>, createdAt: now, updatedAt: now } as DataRecord); },
    del: async (id) => { const svc = getDataService(); if (!svc.isEnabled()) return; await ensureDataset(svc); await svc.del(systemCtx(), DATASET, id); },
  };
}
let _default: MissionViewPort | null = null;
function defaultPort(): MissionViewPort { return _default ?? (_default = livePort()); }

export async function getView(id: string, port: MissionViewPort = defaultPort()): Promise<MissionView | null> { return port.get(id); }
export async function listViews(port: MissionViewPort = defaultPort()): Promise<MissionView[]> { return port.list(); }
export async function putView(v: MissionView, port: MissionViewPort = defaultPort()): Promise<void> { v.updatedAt = Date.now(); await port.put(v); }
export async function deleteView(id: string, port: MissionViewPort = defaultPort()): Promise<void> { await port.del(id); }
