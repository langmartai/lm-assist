/**
 * Worker Role MCP tools — 5 tools that proxy the /worker/* REST routes.
 *
 * Tools:
 *   set_role        — take or update the WORKER role + declare a task (POST /worker/role)
 *   report_status   — worker reports progress on a task (POST /worker/status)
 *   worker_status   — read a worker's record (stamps orchestrator only if orchestrator= given) (GET /worker/:id)
 *   list_workers    — list all worker records on this node (GET /worker)
 *   decide_gate     — resolve an open agree-gate (POST /worker/:id/gate)
 *
 * Wiring: registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts),
 * scoped in configure.ts TOOL_SCOPES.
 */
import type { McpToolResult } from '../configure';
import { ok, err, workerGet, workerPost } from './_passthrough';

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object' as const,
  properties: props,
  required,
});
const S = { type: 'string' as const };

export const WORKER_ROLE_TOOL_DEFS = [
  {
    name: 'set_role',
    description:
      'Take (or update) the WORKER role for a session and declare a worker-OWNED task. ' +
      'Self- or other-assigned; one active role. Pass role:"none" to clear.',
    inputSchema: obj(
      {
        sessionId: S,
        role: { ...S, enum: ['worker', 'none'] },
        task: {
          type: 'object',
          properties: { title: S, group: S, parentId: S, id: S },
          required: ['title'],
        },
        orchestrator: S,
      },
      ['sessionId'],
    ),
  },
  {
    name: 'report_status',
    description:
      'A worker reports progress on one of its own tasks (status/progress/detail). ' +
      'status:"need_approval" with a reason raises an agree-gate and the worker must STOP until decided.',
    inputSchema: obj(
      {
        sessionId: S,
        taskId: S,
        status: {
          ...S,
          enum: ['todo', 'working', 'blocked', 'need_approval', 'done', 'skipped'],
        },
        progress: S,
        detail: S,
        reason: S,
      },
      ['sessionId', 'taskId'],
    ),
  },
  {
    name: 'worker_status',
    description:
      "Read a worker's role, task tree (with statuses + open gates), and orchestrator liveness. " +
      'Pass orchestrator=<yourSessionId> to stamp yourself as the active orchestrator ' +
      '(refreshes lastContact); omit it for a read-only fetch.',
    annotations: { readOnlyHint: false },
    inputSchema: obj({ sessionId: S, orchestrator: S }, ['sessionId']),
  },
  {
    name: 'list_workers',
    description: 'List all worker records on this node (sessionId, tasks, orchestrator liveness).',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'decide_gate',
    description:
      'Resolve a worker\'s open agree-gate: decision "agree" unblocks the gated task, ' +
      '"reject" halts it. The orchestrator/human "agree" action.',
    inputSchema: obj(
      {
        sessionId: S,
        taskId: S,
        decision: { ...S, enum: ['agree', 'reject'] },
        by: S,
        note: S,
      },
      ['sessionId', 'taskId', 'decision'],
    ),
  },
] as const;

const pretty = (v: unknown) => ok(JSON.stringify(v, null, 2));

export const WORKER_ROLE_HANDLERS: Record<
  string,
  (args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  set_role: async (a) => {
    try {
      return pretty(await workerPost('/worker/role', a));
    } catch (e) {
      return err((e as Error).message);
    }
  },

  report_status: async (a) => {
    try {
      return pretty(await workerPost('/worker/status', a));
    } catch (e) {
      return err((e as Error).message);
    }
  },

  worker_status: async (a) => {
    try {
      const q = a.orchestrator
        ? `?orchestrator=${encodeURIComponent(String(a.orchestrator))}`
        : '';
      return pretty(await workerGet(`/worker/${encodeURIComponent(String(a.sessionId))}${q}`));
    } catch (e) {
      return err((e as Error).message);
    }
  },

  list_workers: async () => {
    try {
      return pretty(await workerGet('/worker'));
    } catch (e) {
      return err((e as Error).message);
    }
  },

  decide_gate: async (a) => {
    try {
      return pretty(
        await workerPost(`/worker/${encodeURIComponent(String(a.sessionId))}/gate`, a),
      );
    } catch (e) {
      return err((e as Error).message);
    }
  },
};
