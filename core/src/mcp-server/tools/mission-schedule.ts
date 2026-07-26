/** Mission scheduling-intelligence read tools (proxy the /mission/schedule + /mission/changes routes). */
import type { McpToolResult } from '../configure';
import { ok, err, workerPost } from './_passthrough';
import { detailLevel, intArg, paginate, missionChangeSummary } from './projections';

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties: props, required });
const pretty = (v: unknown): McpToolResult => ok(JSON.stringify(v, null, 2));

export const MISSION_SCHEDULE_TOOL_DEFS = [
  {
    name: 'mission_schedule',
    description:
      'Deterministic mission schedule (hard constraints). Returns {ready[], blocked[{id,reason}], serializeGroups[], epicRollups[], containers[]}. ' +
      'ready = startable now (deps done, no resource/serialize conflict, not an epic container). Always defer dependency/resource/serialize/epic gating to THIS tool — do not re-derive it.',
    inputSchema: obj({}),
  },
  {
    name: 'mission_changes',
    description:
      'Recent EXTERNAL mission edits (changes by anyone other than the controller) newest-first, so you can react to human/other-node edits before acting. ' +
      'Optional {sinceRev:{<missionId>:<rev>}, sinceTs} to only see changes after a point. Returns {changes:[{missionId,rev,at,actor,changedFields}]}.',
    inputSchema: obj({
      sinceRev: { type: 'object' as const },
      sinceTs: { type: 'number' as const },
      detail: { type: 'string' as const, enum: ['summary', 'full'], description: 'summary (default) | full' },
      limit: { type: 'number' as const, description: 'page size (default 100 summary / 25 full)' },
      offset: { type: 'number' as const, description: 'page offset (default 0)' },
    }),
  },
] as const;

export const MISSION_SCHEDULE_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  mission_schedule: async () => { try { return pretty(await workerPost('/mission/schedule', {})); } catch (e) { return err((e as Error).message); } },
  // SUMMARY + paging. Measured 117,769 B for 252 changes, where the embedded 7-field
  // MissionActor was the fattest field on every row; it collapses to `kind:id8`.
  mission_changes: async (a) => {
    try {
      const { limit: _l, offset: _o, detail: _d, ...forward } = a || {};
      const res = await workerPost('/mission/changes', forward) as Record<string, unknown>;
      const all = Array.isArray(res?.changes) ? res.changes as Array<Record<string, unknown>> : [];
      const detail = detailLevel((a || {}).detail);
      const { rows, meta } = paginate(all, intArg((a || {}).limit, detail === 'full' ? 25 : 100), intArg((a || {}).offset, 0));
      return pretty({
        ...res,
        detail,
        ...meta,
        ...(detail === 'summary' ? { hint: 'SUMMARY projection (default) — the per-change actor is collapsed to kind:id. Call mission_changes({detail:"full"}) for full actor objects.' } : {}),
        changes: detail === 'full' ? rows : rows.map(missionChangeSummary),
      });
    } catch (e) { return err((e as Error).message); }
  },
};
