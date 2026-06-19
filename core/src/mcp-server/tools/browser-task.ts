/**
 * browser_task MCP tool — REMOTE browser control. Runs a natural-language
 * browser task on a node's own Chrome (the Claude-in-Chrome extension) by
 * launching `claude --chrome --dangerously-skip-permissions -p "<task>"` there
 * — the same delegation the connector-reconnect uses. lm-assist relays the task
 * to the node; the node's Claude+Chrome does the DOM work and returns a result.
 *
 * (Local browser control is already the Claude-in-Chrome MCP. This fills the
 * gap of driving a browser on ANOTHER node, over the hub.)
 *
 * ADMIN tier: it drives the node's AUTHENTICATED browser and runs with
 * skip-permissions, so every call is approval + out-of-band confirmed by the
 * gateway. Runs in the background (browser tasks take a while) and returns an
 * executionId — poll get_execution(id) for progress + the result.
 *
 * Registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts), scoped
 * admin in configure.ts TOOL_SCOPES.
 */
import { ok, err, workerPost, type McpToolResult } from './_passthrough';

export const browserTaskToolDef = {
  name: 'browser_task',
  description:
    'Drive a node\'s Chrome browser with a natural-language task — remote browser ' +
    'control. Trigger words: "open the browser", "navigate to", "in chrome", "log into ' +
    '<website>", "click", "fill the form on", "scrape the page", "control the browser on ' +
    'my other machine". The target node runs `claude --chrome` against its OWN Chrome ' +
    '(needs the Claude-in-Chrome extension installed + Chrome logged in where relevant); ' +
    'use the `node` selector to pick which machine. Describe the GOAL in plain language ' +
    '(e.g. "go to news.ycombinator.com and list the top 5 titles"). Runs in the BACKGROUND ' +
    '— returns an executionId; poll get_execution(id=...) for progress and the result. ' +
    'ADMIN / high-risk: it operates the node\'s authenticated browser and runs with ' +
    'skip-permissions, so it requires out-of-band confirmation. NOTE: for the LOCAL ' +
    'browser, the Claude-in-Chrome tools are more direct — use this for a REMOTE node.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: 'The browser task in natural language (the goal, not raw DOM steps).',
      },
    },
    required: ['prompt'],
  },
};

export const BROWSER_TASK_TOOL_DEFS = [browserTaskToolDef] as const;

async function handleBrowserTask(args: Record<string, unknown>): Promise<McpToolResult> {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) return err('prompt is required (describe the browser task in natural language).');
  const body = {
    prompt,
    chrome: true,
    background: true,
    permissionMode: 'bypassPermissions',
  };
  try {
    const r = (await workerPost('/agent/execute', body)) as { executionId?: string };
    const id = r.executionId || '(unknown)';
    return ok(
      `Browser task started on this node's Chrome (executionId ${id}). ` +
        `It runs in the background — poll get_execution(id="${id}") for progress and the result. ` +
        `If it stalls, the node may be missing the Claude-in-Chrome extension or not be logged in.`,
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const BROWSER_TASK_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  browser_task: handleBrowserTask,
};
