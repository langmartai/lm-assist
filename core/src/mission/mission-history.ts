/** Pure version-history engine for missions: tracked-field diffing + inline append. No IO. */
import type { Mission, MissionChange, FieldDiff, MissionActor } from './mission-model';

/** Semantic fields whose change is versioned. Controller telemetry is intentionally excluded. */
export const TRACKED_FIELDS = [
  'title', 'objective', 'plan', 'nextSteps', 'projects', 'tags', 'parentId', 'dependsOn', 'status', 'env',
] as const;

const MAX_STR = 500;
function trunc(v: unknown): unknown {
  if (typeof v === 'string' && v.length > MAX_STR) return v.slice(0, MAX_STR) + `…(len ${v.length})`;
  return v;
}
function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Compute the per-field diff between a previous mission (or null on create) and the next. */
export function diffMission(old: Mission | null, next: Mission): Record<string, FieldDiff> {
  const changes: Record<string, FieldDiff> = {};
  for (const f of TRACKED_FIELDS) {
    if (f === 'tags') {
      const ot = (old?.tags ?? {}) as Record<string, string[]>;
      const nt = (next.tags ?? {}) as Record<string, string[]>;
      for (const d of new Set([...Object.keys(ot), ...Object.keys(nt)])) {
        if (!eq(ot[d] ?? [], nt[d] ?? [])) changes[`tags.${d}`] = { from: ot[d] ?? null, to: nt[d] ?? null };
      }
      continue;
    }
    const ov = (old as Record<string, unknown> | null)?.[f];
    const nv = (next as unknown as Record<string, unknown>)[f];
    if (!eq(ov, nv)) changes[f] = { from: trunc(ov ?? null), to: trunc(nv ?? null) };
  }
  return changes;
}

/** Unattributed internal write actor (a direct store call that supplies no actor). */
export function defaultActor(): MissionActor {
  return { kind: 'controller', channel: 'controller', node: null, at: Date.now() };
}

/**
 * If `next` changes a tracked field vs `old`, bump rev, append a MissionChange to the
 * inline slice (trimmed to inlineCap), set lastUpdatedBy, and return the change to spill
 * durably. Otherwise no-op (change=null). Mutates and returns `next`.
 */
export function appendHistory(
  next: Mission,
  old: Mission | null,
  actor: MissionActor | undefined,
  inlineCap = 50,
): { mission: Mission; change: MissionChange | null } {
  const changes = diffMission(old, next);
  if (Object.keys(changes).length === 0) return { mission: next, change: null };
  const who = actor ?? defaultActor();
  const change: MissionChange = { rev: (old?.rev ?? 0) + 1, at: Date.now(), actor: who, changes };
  next.rev = change.rev;
  next.history = [...(next.history ?? []), change].slice(-inlineCap);
  next.lastUpdatedBy = who;
  return { mission: next, change };
}
