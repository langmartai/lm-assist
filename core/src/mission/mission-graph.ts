/** Pure mission relationship validation + tag merge/normalize. No IO. */
import type { Mission } from './mission-model';

export function normalizeTags(tags: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [dim, vals] of Object.entries(tags ?? {})) {
    const k = String(dim).trim().toLowerCase();
    if (!k) continue;
    const cleaned = Array.from(new Set((vals ?? []).map((v) => String(v).trim()).filter(Boolean)));
    if (cleaned.length) out[k] = cleaned;
  }
  return out;
}

export interface TagOps { add?: Record<string, string[]>; remove?: Record<string, string[]>; set?: Record<string, string[]>; }

export function mergeTags(current: Record<string, string[]>, ops: TagOps): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [d, v] of Object.entries(current ?? {})) next[d] = [...v];
  if (ops.set) for (const [d, v] of Object.entries(ops.set)) next[d] = [...v];
  if (ops.add) for (const [d, v] of Object.entries(ops.add)) next[d] = [...(next[d] ?? []), ...v];
  if (ops.remove) for (const [d, v] of Object.entries(ops.remove)) next[d] = (next[d] ?? []).filter((x) => !v.includes(x));
  return normalizeTags(next);
}

export type RelValidation = { ok: true } | { ok: false; code: 'INVALID_RELATIONSHIP' | 'CYCLE'; message: string };

export function validateParent(missionId: string, parentId: string | null, all: Mission[]): RelValidation {
  if (parentId == null || parentId === '') return { ok: true };
  if (parentId === missionId) return { ok: false, code: 'CYCLE', message: 'a mission cannot be its own parent' };
  const byId = new Map(all.map((m) => [m.id, m]));
  if (!byId.has(parentId)) return { ok: false, code: 'INVALID_RELATIONSHIP', message: `parent ${parentId} does not exist` };
  let cur: string | null = parentId;
  const seen = new Set<string>();
  while (cur != null) {
    if (cur === missionId) return { ok: false, code: 'CYCLE', message: 'parent chain would cycle' };
    if (seen.has(cur)) break;
    seen.add(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return { ok: true };
}

export function validateDependsOn(missionId: string, deps: string[], all: Mission[]): RelValidation {
  const byId = new Map(all.map((m) => [m.id, m]));
  for (const d of deps) {
    if (d === missionId) return { ok: false, code: 'CYCLE', message: 'a mission cannot depend on itself' };
    if (!byId.has(d)) return { ok: false, code: 'INVALID_RELATIONSHIP', message: `dependency ${d} does not exist` };
  }
  const depsOf = (id: string): string[] => (id === missionId ? deps : (byId.get(id)?.dependsOn ?? []));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const dfs = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (done.has(id)) return false;
    visiting.add(id);
    for (const n of depsOf(id)) if (dfs(n)) return true;
    visiting.delete(id);
    done.add(id);
    return false;
  };
  return dfs(missionId) ? { ok: false, code: 'CYCLE', message: 'dependsOn would create a cycle' } : { ok: true };
}
