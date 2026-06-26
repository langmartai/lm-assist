/** Pure mission-view model: a saved query + display hints the dashboard renders. No IO. */
import type { MissionActor } from './mission-model';
import type { MissionFilter } from './mission-filter';
import type { Direction } from './mission-traverse';

export interface MissionView {
  id: string;
  name: string;
  query: { filter?: MissionFilter[]; expand?: { direction?: Direction; depth?: number } };
  display: { groupBy?: string; highlight?: MissionFilter[]; layout?: 'tree' | 'dag'; nodeFields?: string[] };
  createdBy: MissionActor;
  lastUpdatedBy: MissionActor;
  createdAt: number;
  updatedAt: number;
}

const LAYOUTS = new Set(['tree', 'dag']);
const DIRS = new Set(['parents', 'children', 'dependencies', 'dependents', 'all']);

export interface NewViewInput { name: string; query?: MissionView['query']; display?: MissionView['display']; createdBy: MissionActor; }

export function newView(input: NewViewInput, now: number, genId: () => string): MissionView {
  return normalizeView({
    id: genId(), name: input.name, query: input.query ?? {}, display: input.display ?? {},
    createdBy: input.createdBy, lastUpdatedBy: input.createdBy, createdAt: now, updatedAt: now,
  });
}

/** Trim name, coerce display enums, keep only known display keys. */
export function normalizeView(v: MissionView): MissionView {
  const d = v.display ?? {};
  return {
    ...v,
    name: String(v.name ?? '').trim(),
    query: v.query ?? {},
    display: {
      groupBy: typeof d.groupBy === 'string' ? d.groupBy : undefined,
      highlight: Array.isArray(d.highlight) ? d.highlight : undefined,
      layout: LAYOUTS.has(d.layout as string) ? d.layout : undefined,
      nodeFields: Array.isArray(d.nodeFields) ? d.nodeFields.filter((x) => typeof x === 'string') : undefined,
    },
  };
}

export function validateView(v: MissionView): { ok: true } | { ok: false; message: string } {
  if (!v.name || !String(v.name).trim()) return { ok: false, message: 'view name is required' };
  const dir = v.query?.expand?.direction;
  if (dir != null && !DIRS.has(dir)) return { ok: false, message: `invalid expand direction "${dir}"` };
  if (v.display?.layout != null && !LAYOUTS.has(v.display.layout)) return { ok: false, message: `invalid layout "${v.display.layout}"` };
  return { ok: true };
}
