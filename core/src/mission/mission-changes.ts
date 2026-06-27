// Pure surfacing of recent EXTERNAL (non-controller) mission edits, newest-first.
import { Mission, MissionActor } from './mission-model';

export interface ExternalChange {
  missionId: string;
  rev: number;
  at: number;
  actor: MissionActor;
  changedFields: string[];
}

export function recentExternalChanges(
  missions: Mission[],
  opts: { sinceRev?: Record<string, number>; sinceTs?: number; excludeChannel?: string } = {},
): ExternalChange[] {
  const excludeChannel = opts.excludeChannel ?? 'controller';
  const out: ExternalChange[] = [];
  for (const m of missions) {
    const since = opts.sinceRev?.[m.id];
    for (const ch of m.history ?? []) {
      if (ch.actor?.channel === excludeChannel) continue;
      if (since != null && ch.rev <= since) continue;
      if (opts.sinceTs != null && ch.at <= opts.sinceTs) continue;
      out.push({
        missionId: m.id,
        rev: ch.rev,
        at: ch.at,
        actor: ch.actor,
        changedFields: Object.keys(ch.changes ?? {}),
      });
    }
  }
  out.sort((a, b) => b.at - a.at || b.rev - a.rev);
  return out;
}
