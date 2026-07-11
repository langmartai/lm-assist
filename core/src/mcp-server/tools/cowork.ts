/**
 * MCP tool: cowork_create_task
 *
 * Thin wrapper over `POST /cowork/tasks` (core/src/routes/core/cowork.routes.ts)
 * — creates a Claude Cowork session (cloud or local bridge) and sends the
 * initial prompt. Reached on loopback via `workerPost` so the route stays the
 * single source of truth for validation, environment resolution, and error
 * shaping (see core/src/cowork/cowork-tasks.ts).
 */

import { ok, err, workerPost, type McpToolResult } from './_passthrough';

export const coworkCreateTaskDef = {
  name: 'cowork_create_task',
  description:
    'Create a Claude Cowork task: creates a cowork session (cloud by default, or on a local ' +
    'device) and sends the initial prompt, running in the background. Use for "create a cowork ' +
    'task", "start a cowork session", "dispatch a background task to Claude". Returns the session ' +
    'id + URL. For target="local" you must pass environmentId (a bridge device env id). WRITE — ' +
    'starts a real background session.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: { type: 'string', description: 'The task prompt to send.' },
      target: { type: 'string', description: '"cloud" (default) or "local".' },
      environmentId: { type: 'string', description: 'Bridge env id — required when target="local".' },
      model: { type: 'string', description: 'Model id, default claude-sonnet-5.' },
      effort: { type: 'string', description: 'low|medium|high|max, default medium.' },
      title: { type: 'string', description: 'Optional session title.' },
    },
    required: ['prompt'],
  },
};

export async function handleCoworkCreateTask(args: Record<string, unknown>): Promise<McpToolResult> {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) return err('prompt is required.');
  const body: Record<string, unknown> = { prompt };
  if (args.target) body.target = String(args.target);
  if (args.environmentId) body.environmentId = String(args.environmentId);
  if (args.model) body.model = String(args.model);
  if (args.effort) body.effort = String(args.effort);
  if (args.title) body.title = String(args.title);
  try {
    return ok(pretty(await workerPost('/cowork/tasks', body)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

function pretty(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}
