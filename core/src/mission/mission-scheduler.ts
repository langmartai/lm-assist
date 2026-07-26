// Pure deterministic mission scheduler. Computes a Schedule from the mission set; never writes.
import { Mission, MissionStatus, place } from './mission-model';

export type BlockReason = 'dependency' | 'parent' | 'resource' | 'serialize';
export interface BlockedEntry { id: string; reason: BlockReason; waitOn?: string[]; }
export interface SerializeGroup { group: string; missionIds: string[]; running: string | null; }
export interface EpicRollup { parentId: string; status: MissionStatus; progressPercent: number; childCount: number; doneCount: number; }
export interface Schedule {
  ready: string[];
  blocked: BlockedEntry[];
  serializeGroups: SerializeGroup[];
  epicRollups: EpicRollup[];
  containers: string[];
}

/** Reserved controller-owned tag dimension: missions sharing a value run one-at-a-time. */
export const CTL_SERIALIZE_DIM = 'ctl:serialize-group';
/** Statuses that are candidates to START now (active=running, paused=held, done/failed=terminal are excluded). */
const SCHEDULABLE = new Set<MissionStatus>(['draft', 'waiting', 'blocked']);

/**
 * THE status filter — exported so every surface answers "would the controller start this?"
 * from ONE definition. `mission_place` used to re-derive placement WITHOUT it and so
 * returned `go:true` for missions the controller would never look at (bl_28543c78); that
 * false confirmation is what hid the born-`active` bug for as long as it did.
 */
export function isSchedulableStatus(s: MissionStatus): boolean {
  return SCHEDULABLE.has(s);
}

export function computeSchedule(missions: Mission[]): Schedule {
  const byId = new Map(missions.map((m) => [m.id, m]));

  // Containers + children: a container is any id referenced by an existing child's parentId.
  const childrenByParent = new Map<string, Mission[]>();
  for (const m of missions) {
    if (m.parentId && byId.has(m.parentId)) {
      const arr = childrenByParent.get(m.parentId);
      if (arr) arr.push(m); else childrenByParent.set(m.parentId, [m]);
    }
  }
  const containers = [...childrenByParent.keys()];
  const containerSet = new Set(containers);

  // Epic rollups — computed only; the controller applies them via mission_update.
  const epicRollups: EpicRollup[] = containers.map((parentId) => {
    const children = childrenByParent.get(parentId)!;
    const childCount = children.length;
    const doneCount = children.filter((c) => c.status === 'done').length;
    let status: MissionStatus;
    if (children.every((c) => c.status === 'done')) status = 'done';
    else if (children.some((c) => c.status === 'active')) status = 'active';
    else if (children.some((c) => c.status === 'blocked')) status = 'blocked';
    else status = 'waiting';
    return { parentId, status, progressPercent: Math.round((100 * doneCount) / childCount), childCount, doneCount };
  });

  // Serialize groups — missions sharing a ctl:serialize-group tag value.
  const members = new Map<string, Mission[]>();
  for (const m of missions) {
    for (const g of m.tags?.[CTL_SERIALIZE_DIM] ?? []) {
      const arr = members.get(g);
      if (arr) arr.push(m); else members.set(g, [m]);
    }
  }
  const serializeGroups: SerializeGroup[] = [...members.entries()].map(([group, ms]) => ({
    group,
    missionIds: ms.map((m) => m.id),
    running: ms.find((m) => m.status === 'active')?.id ?? null,
  }));
  // A mission is serialize-blocked iff it is a non-terminal, non-running member of a group that HAS a running member.
  const serializeBlocked = new Set<string>();
  for (const grp of serializeGroups) {
    if (!grp.running) continue;
    for (const id of grp.missionIds) {
      if (id === grp.running) continue;
      const m = byId.get(id);
      if (m && m.status !== 'done' && m.status !== 'failed') serializeBlocked.add(id);
    }
  }

  const ready: string[] = [];
  const blocked: BlockedEntry[] = [];
  for (const m of missions) {
    if (m.origin === 'onboarded') continue;     // already bound to its session — never spawn-ready
    if (containerSet.has(m.id)) continue;       // epic container — rolled up, not executed
    if (!SCHEDULABLE.has(m.status)) continue;   // active/paused/done/failed
    if (m.parentId && !byId.has(m.parentId)) { blocked.push({ id: m.id, reason: 'parent', waitOn: [m.parentId] }); continue; }
    if (serializeBlocked.has(m.id)) { blocked.push({ id: m.id, reason: 'serialize' }); continue; }
    const p = place(m, missions);
    if (p.go) ready.push(m.id);
    else if (p.reason === 'dependency') blocked.push({ id: m.id, reason: 'dependency', waitOn: p.waitOn });
    else blocked.push({ id: m.id, reason: 'resource' });
  }

  return { ready, blocked, serializeGroups, epicRollups, containers };
}
