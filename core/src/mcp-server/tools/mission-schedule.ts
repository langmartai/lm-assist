/** Mission scheduling-intelligence read tools (proxy the /mission/schedule + /mission/changes routes). */
import type { McpToolResult } from '../configure';
import { ok, err, workerPost } from './_passthrough';

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
    inputSchema: obj({ sinceRev: { type: 'object' as const }, sinceTs: { type: 'number' as const } }),
  },
] as const;

export const MISSION_SCHEDULE_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  mission_schedule: async () => { try { return pretty(await workerPost('/mission/schedule', {})); } catch (e) { return err((e as Error).message); } },
  mission_changes: async (a) => { try { return pretty(await workerPost('/mission/changes', a)); } catch (e) { return err((e as Error).message); } },
};
