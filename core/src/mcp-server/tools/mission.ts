/**
 * Mission MCP tools — 4 tools that proxy the /mission REST routes.
 *
 * Tools:
 *   mission_create         — create a new mission (POST /mission)
 *   mission_list           — list all missions (GET /mission)
 *   mission_update         — update a mission (POST /mission/:id)
 *   mission_control_status — elected controller + last tick (GET /mission/controller)
 *
 * Wiring: registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts),
 * scoped in configure.ts TOOL_SCOPES.
 */
import type { McpToolResult } from '../configure';
import { ok, err, workerGet, workerPost } from './_passthrough';
import { currentMcpContext } from '../principal-context';

export function withActorHint(args: Record<string, unknown>, toolUseId: string | undefined): Record<string, unknown> {
  return { ...args, _actor: { channel: 'mcp', toolUseId: toolUseId ?? null } };
}

const S = { type: 'string' as const };
const SARR = { type: 'array' as const, items: { type: 'string' as const } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object' as const,
  properties: props,
  required,
});
const pretty = (v: unknown): McpToolResult => ok(JSON.stringify(v, null, 2));

export const MISSION_TOOL_DEFS = [
  {
    name: 'mission_create',
    description:
      'Create a Mission (durable WHAT-to-achieve). The fleet-elected Mission Controller will ' +
      'place an executor and push it to done. Spans any project(s).',
    inputSchema: obj(
      {
        title: S,
        objective: S,
        projects: SARR,
        dependsOn: SARR,
        plan: S,
        nextSteps: SARR,
        env: obj({
          isolation: { ...S, enum: ['cloud', 'worktree', 'shared'] },
          host: S,
          repo: S,
          branch: S,
          resources: SARR,
          exclusive: { type: 'boolean' as const },
        }),
      },
      ['title', 'objective'],
    ),
  },
  {
    name: 'mission_list',
    description: 'List all missions and their status/progress/binding.',
    inputSchema: obj({}),
  },
  {
    name: 'mission_update',
    description:
      'Update a mission (objective/title/plan/nextSteps/status/env/dependsOn). ' +
      'Use to refine, pause, or unblock.',
    inputSchema: obj(
      {
        id: S,
        title: S,
        objective: S,
        plan: S,
        status: {
          ...S,
          enum: ['draft', 'active', 'waiting', 'paused', 'blocked', 'done', 'failed'],
        },
        nextSteps: SARR,
        dependsOn: SARR,
        projects: SARR,
      },
      ['id'],
    ),
  },
  {
    name: 'mission_control_status',
    description: 'Who is the elected Mission Controller right now + its last tick result.',
    inputSchema: obj({}),
  },
] as const;

export const MISSION_HANDLERS: Record<
  string,
  (args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  mission_create: async (a) => {
    try {
      return pretty(await workerPost('/mission', withActorHint(a, currentMcpContext()?.toolUseId)));
    } catch (e) { return err((e as Error).message); }
  },

  mission_list: async () => {
    try {
      return pretty(await workerGet('/mission'));
    } catch (e) {
      return err((e as Error).message);
    }
  },

  mission_update: async (a) => {
    try {
      const id = String(a.id || '');
      if (!id) return err('id is required');
      return pretty(await workerPost(`/mission/${encodeURIComponent(id)}`, withActorHint(a, currentMcpContext()?.toolUseId)));
    } catch (e) { return err((e as Error).message); }
  },

  mission_control_status: async () => {
    try {
      return pretty(await workerGet('/mission/controller'));
    } catch (e) {
      return err((e as Error).message);
    }
  },
};
