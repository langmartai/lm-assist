/**
 * Expanded MCP tool catalog (read tier) — see docs/plans mcp-full-exposure.
 *
 * These tools surface lm-assist's broader read surface (agent executions,
 * curated memory cross-host, terminal capture) over MCP. They are all
 * READ-ONLY and map 1:1 to existing internal lm-assist GET routes, reached
 * in-process via the loopback passthrough helper so each route stays the
 * single source of truth for its behavior + formatting.
 *
 * Wiring: both transports (StreamableHTTP `mcp.routes.ts` and stdio
 * `index.ts`) fall back to `EXPANDED_HANDLERS[name]` for any tool not in
 * their explicit switch, so adding a tool here needs only:
 *   1. a def in EXPANDED_TOOL_DEFS (advertised via configure.ts)
 *   2. a scope in TOOL_SCOPES (configure.ts)
 *   3. a handler in EXPANDED_HANDLERS (below)
 */

import * as childProcess from 'child_process';
import * as nodePath from 'path';
import {
  ok,
  err,
  workerGet,
  workerPost,
  workerPut,
  workerDelete,
  isCwdAllowed,
  type McpToolResult,
} from './_passthrough';
import { handleListNodes } from './list-nodes';
import { GITHUB_TOOL_DEFS, GITHUB_HANDLERS } from './github';
import { PORT_FORWARD_TOOL_DEFS, PORT_FORWARD_HANDLERS } from './port-forward';

// ─── Tool definitions ────────────────────────────────────────────

export const listExecutionsToolDef = {
  name: 'list_executions',
  description:
    'List background agent executions lm-assist has launched (Claude Code sessions started ' +
    'via the agent-execution API — analysis pipelines, scheduled jobs, etc.), most-recent ' +
    'first. Trigger words: "running agents", "agent executions", "what jobs are running", ' +
    '"background executions". Each entry shows id, status, command/prompt summary, and ' +
    'timestamps. Follow up with `get_execution(id=...)`. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

export const getExecutionToolDef = {
  name: 'get_execution',
  description:
    'Get the full detail of one background agent execution by id — status, result, session ' +
    'URL, duration. Pass the id from `list_executions`. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Execution id from list_executions.' },
    },
    required: ['id'],
  },
};

export const memoryProjectsToolDef = {
  name: 'memory_projects',
  description:
    'List the projects that have curated Claude memory directories, with each project\'s ' +
    'stable `projectId` slug, real path, file count, and whether a repo mirror / other-host ' +
    'mirrors exist. Use this to get the `project_id` that `memory_cross_host` and ' +
    '`memory_import_candidates` need. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const memoryCrossHostToolDef = {
  name: 'memory_cross_host',
  description:
    'Search a project\'s curated memory across ALL hosts (the live dir plus every host ' +
    'mirror in the repo), ranked by relevance, with `presentLocally` / staleness flags per ' +
    'file. Use for "what does any of my machines remember about X". Needs the project\'s ' +
    '`project_id` slug from `memory_projects`. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      project_id: { type: 'string', description: 'Project slug from memory_projects (e.g. "C--home-lm-unified-trade").' },
      query: { type: 'string', description: 'Relevance query over memory file bodies + frontmatter.' },
    },
    required: ['project_id', 'query'],
  },
};

export const memoryImportCandidatesToolDef = {
  name: 'memory_import_candidates',
  description:
    'List memory files from OTHER hosts\' mirrors that are project-domain and not present ' +
    '(or are newer than) the local copy — candidates to import to this host. Optionally ' +
    'ranked by a query. Needs `project_id` from `memory_projects`. Read-only (suggests; does ' +
    'not import).',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      project_id: { type: 'string', description: 'Project slug from memory_projects.' },
      query: { type: 'string', description: 'Optional relevance query to rank candidates.' },
    },
    required: ['project_id'],
  },
};

export const terminalListToolDef = {
  name: 'terminal_list',
  description:
    'List the tmux sessions lm-assist can observe on the host (name + window/pane info). ' +
    'Linux hosts only — returns platformSupported:false elsewhere. Use to find a session ' +
    'name for `terminal_capture`. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const terminalCaptureToolDef = {
  name: 'terminal_capture',
  description:
    'Capture the current visible buffer of a named tmux session (read-only snapshot of what ' +
    'is on screen). Use to watch a long-running job\'s output without driving it. Pass the ' +
    'session `name` from `terminal_list`. Read-only — does NOT send keystrokes.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'tmux session name from terminal_list.' },
    },
    required: ['name'],
  },
};

// ─── write tier (scope: write — gateway requires per-call approval) ──────

export const claudeaiCreateConversationToolDef = {
  name: 'claudeai_create_conversation',
  description:
    'Create a new (empty) claude.ai web conversation. Returns its uuid. Use before ' +
    '`claudeai_completion`, which needs an existing conversation. WRITE — changes the ' +
    'user\'s claude.ai account state.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Optional title for the new conversation.' },
    },
  },
};

export const claudeaiCompletionToolDef = {
  name: 'claudeai_completion',
  description:
    'Send a prompt to an existing claude.ai web conversation and get the assistant reply. ' +
    'SPENDS TOKENS on the user\'s claude.ai account. The conversation must already exist — ' +
    'create one first with `claudeai_create_conversation`. WRITE.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      conversation_uuid: { type: 'string', description: 'Target conversation uuid.' },
      prompt: { type: 'string', description: 'The message to send.' },
      model: { type: 'string', description: 'Optional model override.' },
    },
    required: ['conversation_uuid', 'prompt'],
  },
};

export const agentAbortToolDef = {
  name: 'agent_abort',
  description:
    'Abort a running background agent execution by id (from `list_executions`). WRITE — ' +
    'stops an in-flight job.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: { id: { type: 'string', description: 'Execution id to abort.' } },
    required: ['id'],
  },
};

export const agentResumeToolDef = {
  name: 'agent_resume',
  description:
    'Resume a finished/failed background agent execution from its session, optionally with a ' +
    'follow-up prompt (default "continue"). WRITE — starts new work on the host.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: { type: 'string', description: 'The session id of the execution to resume.' },
      prompt: { type: 'string', description: 'Optional follow-up prompt (default "continue").' },
    },
    required: ['session_id'],
  },
};

export const terminalPromptToolDef = {
  name: 'terminal_prompt',
  description:
    'Type a prompt into a running Claude Code terminal session (drives it). Single line — no ' +
    'newlines unless allow_newlines. WRITE — sends input to a live session.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Claude Code terminal session name.' },
      text: { type: 'string', description: 'The prompt text to type + submit.' },
      allow_newlines: { type: 'boolean', description: 'Permit newlines in text (default false).' },
    },
    required: ['name', 'text'],
  },
};

export const terminalSlashToolDef = {
  name: 'terminal_slash',
  description:
    'Send a slash command (e.g. /clear, /compact) to a running Claude Code terminal session. ' +
    'WRITE — drives a live session.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Claude Code terminal session name.' },
      cmd: { type: 'string', description: 'Slash command identifier without the leading slash (e.g. "clear").' },
      args: { type: 'string', description: 'Optional single-line arguments.' },
    },
    required: ['name', 'cmd'],
  },
};

// ─── admin tier (scope: admin — gateway requires out-of-band confirm) ────

export const agentExecuteToolDef = {
  name: 'agent_execute',
  description:
    'Start a NEW autonomous Claude Code session on the host with an arbitrary prompt. ' +
    'ADMIN / high-risk — runs real code. cwd is restricted to directories under ' +
    '/home/ubuntu. Requires out-of-band confirmation before it executes.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: { type: 'string', description: 'The task for the Claude Code session.' },
      cwd: { type: 'string', description: 'Working directory — MUST be under /home/ubuntu.' },
      model: { type: 'string', description: 'Optional model (opus|sonnet|haiku or full id).' },
    },
    required: ['prompt', 'cwd'],
  },
};

export const terminalInterruptToolDef = {
  name: 'terminal_interrupt',
  description:
    'Send Ctrl-C to a running Claude Code terminal session. ADMIN — interrupts a live ' +
    'session. Requires out-of-band confirmation.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: { name: { type: 'string', description: 'Session name to interrupt.' } },
    required: ['name'],
  },
};

export const terminalOpenTabToolDef = {
  name: 'terminal_open_tab',
  description:
    'Open a real GUI terminal window on the host running a command. ADMIN — spawns a host ' +
    'process. Requires out-of-band confirmation.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Window title.' },
      cwd: { type: 'string', description: 'Working directory (under /home/ubuntu).' },
      command: { type: 'string', description: 'Command to run in the new terminal.' },
      kind: { type: 'string', description: 'Terminal kind (e.g. "gnome").' },
    },
    required: ['command'],
  },
};

export const deleteConversationToolDef = {
  name: 'delete_conversation',
  description:
    'Permanently delete a claude.ai web conversation by uuid. ADMIN / irreversible. ' +
    'Requires out-of-band confirmation.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: { conversation_uuid: { type: 'string', description: 'Conversation uuid to delete.' } },
    required: ['conversation_uuid'],
  },
};

// ─── claude.ai marketplace + plugin management ───────────────────────────
//
// Mirror the cookie-path /claude-ai/marketplaces + /claude-ai/plugins routes
// (loopback). list_* are reads; add/remove/set are writes against the account.

export const claudeaiListMarketplacesToolDef = {
  name: 'claudeai_list_marketplaces',
  description:
    'List the plugin marketplaces registered on the user\'s claude.ai account. A marketplace ' +
    'is a GitHub repo (with .claude-plugin/marketplace.json) that publishes plugins. ' +
    'scope="account" (default) lists the user\'s added marketplaces; "default" the built-in ' +
    'one; "org" the organization\'s. Each entry has id, name, source, source_url, sync_status. ' +
    'Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      scope: { type: 'string', enum: ['account', 'default', 'org'], description: 'Which marketplace set to list (default "account").' },
    },
  },
};

export const claudeaiAddMarketplaceToolDef = {
  name: 'claudeai_add_marketplace',
  description:
    'Register a new plugin marketplace on the user\'s claude.ai account from a public GitHub ' +
    'repo. source_url accepts "owner/repo" or a full github.com URL (normalized to ' +
    'https://github.com/owner/repo). claude.ai git-clones the repo\'s default branch and ' +
    'requires .claude-plugin/marketplace.json at its root; the clone+sync is async (poll ' +
    '`claudeai_list_marketplaces` for sync_status="success"). WRITE — changes account state.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Display name for the marketplace.' },
      source_url: { type: 'string', description: 'GitHub "owner/repo" or full github.com URL.' },
    },
    required: ['name', 'source_url'],
  },
};

export const claudeaiRemoveMarketplaceToolDef = {
  name: 'claudeai_remove_marketplace',
  description:
    'Remove a plugin marketplace from the user\'s claude.ai account by its marketplace id ' +
    '(from `claudeai_list_marketplaces`). WRITE — unregisters the marketplace and its plugins. ' +
    'Verify removal by re-listing (the upstream 200 alone is unreliable).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      marketplace_id: { type: 'string', description: 'Marketplace id from claudeai_list_marketplaces.' },
    },
    required: ['marketplace_id'],
  },
};

export const claudeaiListMarketplacePluginsToolDef = {
  name: 'claudeai_list_marketplace_plugins',
  description:
    'List the plugins published by one ACCOUNT marketplace (by marketplace id from ' +
    '`claudeai_list_marketplaces`). Account-marketplace plugins are NOT returned by ' +
    '`claudeai_list_plugins` (which only covers the default marketplace). Each entry has ' +
    'id, name, enabled, skills. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      marketplace_id: { type: 'string', description: 'Marketplace id from claudeai_list_marketplaces.' },
    },
    required: ['marketplace_id'],
  },
};

export const claudeaiListPluginsToolDef = {
  name: 'claudeai_list_plugins',
  description:
    'List the plugins in the user\'s claude.ai DEFAULT marketplace, with each plugin\'s id, ' +
    'name, and enabled state. Pass enabled_only=true to return only enabled plugins. For ' +
    'account-marketplace plugins use `claudeai_list_marketplace_plugins` instead. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      enabled_only: { type: 'boolean', description: 'Return only enabled plugins (default false).' },
    },
  },
};

export const claudeaiSetPluginEnabledToolDef = {
  name: 'claudeai_set_plugin_enabled',
  description:
    'Enable or disable a claude.ai plugin by its plugin id (from a list_*_plugins tool). ' +
    'WRITE — toggles whether the plugin\'s skills/tools are active on the account.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      plugin_id: { type: 'string', description: 'Plugin id (from claudeai_list_plugins or claudeai_list_marketplace_plugins).' },
      enabled: { type: 'boolean', description: 'true to enable, false to disable.' },
    },
    required: ['plugin_id', 'enabled'],
  },
};

export const memoryMapToolDef = {
  name: 'memory_map',
  description:
    'Query the cross-project/node MEMORY map (record-level, brief/complete, with optional ' +
    'filters). Returns ACTUAL memory records from disk — never fabricated. Use level="brief" ' +
    '(default) for a quick overview; level="complete" for full record text. Filter by ' +
    'projects, nodes, types, category, keyword query (q), or time (since). Pass stats=true ' +
    'for a count-only summary. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      level: { type: 'string', enum: ['brief', 'complete'], description: 'Detail level — brief (default) or complete.' },
      projects: { type: 'string', description: 'Comma-separated project id substrings.' },
      nodes: { type: 'string', description: 'Comma-separated host ids.' },
      types: { type: 'string', description: 'Comma-separated memory types.' },
      category: { type: 'string', description: 'Comma-separated categories.' },
      q: { type: 'string', description: 'Keyword query — all terms must appear in title+brief+complete.' },
      since: { type: 'number', description: 'Only records modified after this Unix ms timestamp.' },
      limit: { type: 'number', description: 'Max records to return (0 = all).' },
      stats: { type: 'boolean', description: 'Return count/stats summary only instead of records.' },
    },
  },
};

export const memoryRecordToolDef = {
  name: 'memory_record',
  description:
    'Fetch one complete MEMORY record by its recordId (from memory_map output). Returns the ' +
    'full record text. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      recordId: { type: 'string', description: 'The record id from a prior memory_map result.' },
    },
    required: ['recordId'],
  },
};

export const ruleMapToolDef = {
  name: 'rule_map',
  description:
    'Query the cross-project/node RULES map (.claude/rules/ path-scoped rules). Returns ' +
    'ACTUAL rule records from disk — never fabricated. Supports the same brief/complete ' +
    'levels and filters as memory_map, plus scope (user/project), paths (glob substring), ' +
    'and always (load-always rules only). Pass stats=true for count summary. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      level: { type: 'string', enum: ['brief', 'complete'], description: 'Detail level — brief (default) or complete.' },
      scope: { type: 'string', enum: ['user', 'project'], description: 'Filter to user-level or project-level rules.' },
      paths: { type: 'string', description: 'Substring to match against rule path globs.' },
      always: { type: 'boolean', description: 'If true, only return rules with loadCondition=always.' },
      category: { type: 'string', description: 'Comma-separated categories to filter.' },
      q: { type: 'string', description: 'Keyword query over rule title+brief+complete+paths.' },
      limit: { type: 'number', description: 'Max records to return (0 = all).' },
      stats: { type: 'boolean', description: 'Return count/stats summary only instead of records.' },
    },
  },
};

export const EXPANDED_TOOL_DEFS = [
  // read
  listExecutionsToolDef,
  getExecutionToolDef,
  memoryProjectsToolDef,
  memoryCrossHostToolDef,
  memoryImportCandidatesToolDef,
  terminalListToolDef,
  terminalCaptureToolDef,
  claudeaiListMarketplacesToolDef,
  claudeaiListMarketplacePluginsToolDef,
  claudeaiListPluginsToolDef,
  // memory map + rules map (read — shell out to CLIs)
  memoryMapToolDef,
  memoryRecordToolDef,
  ruleMapToolDef,
  // write
  claudeaiCreateConversationToolDef,
  claudeaiCompletionToolDef,
  claudeaiAddMarketplaceToolDef,
  claudeaiRemoveMarketplaceToolDef,
  claudeaiSetPluginEnabledToolDef,
  agentAbortToolDef,
  agentResumeToolDef,
  terminalPromptToolDef,
  terminalSlashToolDef,
  // admin
  agentExecuteToolDef,
  terminalInterruptToolDef,
  terminalOpenTabToolDef,
  deleteConversationToolDef,
  // github (read: github_query, write: github_mutate)
  ...GITHUB_TOOL_DEFS,
  // port forward (node-to-node TCP tunnel)
  ...PORT_FORWARD_TOOL_DEFS,
] as const;

// ─── Handlers ────────────────────────────────────────────────────

function pretty(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

async function handleListExecutions(): Promise<McpToolResult> {
  try {
    const data = await workerGet('/agent/executions');
    const arr = Array.isArray(data) ? data : [];
    if (arr.length === 0) return ok('No agent executions.');
    return ok(`Agent executions (${arr.length}):\n\n${pretty(data)}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleGetExecution(args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.id || '').trim();
  if (!id) return err('id is required.');
  try {
    return ok(pretty(await workerGet(`/agent/execution/${enc(id)}`)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleMemoryProjects(): Promise<McpToolResult> {
  try {
    return ok(pretty(await workerGet('/memory/projects')));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleMemoryCrossHost(args: Record<string, unknown>): Promise<McpToolResult> {
  const pid = String(args.project_id || '').trim();
  const q = String(args.query || '').trim();
  if (!pid || !q) return err('project_id and query are required.');
  try {
    return ok(pretty(await workerGet(`/memory/by-project/${enc(pid)}/cross-host?q=${enc(q)}`)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleMemoryImportCandidates(args: Record<string, unknown>): Promise<McpToolResult> {
  const pid = String(args.project_id || '').trim();
  const q = String(args.query || '').trim();
  if (!pid) return err('project_id is required.');
  const qs = q ? `?q=${enc(q)}` : '';
  try {
    return ok(pretty(await workerGet(`/memory/by-project/${enc(pid)}/sync/import-candidates${qs}`)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleTerminalList(): Promise<McpToolResult> {
  try {
    return ok(pretty(await workerGet('/terminal/tmux')));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleTerminalCapture(args: Record<string, unknown>): Promise<McpToolResult> {
  const name = String(args.name || '').trim();
  if (!name) return err('name is required.');
  try {
    return ok(pretty(await workerGet(`/terminal/tmux/${enc(name)}/capture`)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// ─── write handlers ──────────────────────────────────────────────

async function handleClaudeaiCreateConversation(args: Record<string, unknown>): Promise<McpToolResult> {
  const body: Record<string, unknown> = {};
  if (args.name) body.name = String(args.name);
  try {
    return ok(pretty(await workerPost('/claude-ai/conversations', body)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleClaudeaiCompletion(args: Record<string, unknown>): Promise<McpToolResult> {
  const uuid = String(args.conversation_uuid || '').trim();
  const prompt = String(args.prompt || '').trim();
  if (!uuid || !prompt) return err('conversation_uuid and prompt are required.');
  const body: Record<string, unknown> = { prompt };
  if (args.model) body.model = String(args.model);
  try {
    return ok(pretty(await workerPost(`/claude-ai/conversations/${enc(uuid)}/completion`, body)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleAgentAbort(args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.id || '').trim();
  if (!id) return err('id is required.');
  try {
    return ok(pretty(await workerPost(`/agent/execution/${enc(id)}/abort`, {})));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleAgentResume(args: Record<string, unknown>): Promise<McpToolResult> {
  const sid = String(args.session_id || '').trim();
  if (!sid) return err('session_id is required.');
  const body: Record<string, unknown> = {};
  if (args.prompt) body.prompt = String(args.prompt);
  try {
    return ok(pretty(await workerPost(`/agent/session/${enc(sid)}/resume`, body)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleTerminalPrompt(args: Record<string, unknown>): Promise<McpToolResult> {
  const name = String(args.name || '').trim();
  const text = String(args.text || '');
  if (!name || !text) return err('name and text are required.');
  const body: Record<string, unknown> = { text };
  if (args.allow_newlines) body.allowNewlines = true;
  try {
    return ok(pretty(await workerPost(`/terminal/cc/${enc(name)}/prompt`, body)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleTerminalSlash(args: Record<string, unknown>): Promise<McpToolResult> {
  const name = String(args.name || '').trim();
  const cmd = String(args.cmd || '').trim();
  if (!name || !cmd) return err('name and cmd are required.');
  const body: Record<string, unknown> = { cmd };
  if (args.args) body.args = String(args.args);
  try {
    return ok(pretty(await workerPost(`/terminal/cc/${enc(name)}/slash`, body)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// ─── admin handlers ──────────────────────────────────────────────

async function handleAgentExecute(args: Record<string, unknown>): Promise<McpToolResult> {
  const prompt = String(args.prompt || '').trim();
  const cwd = String(args.cwd || '').trim();
  if (!prompt || !cwd) return err('prompt and cwd are required.');
  // Layer-6 defense in depth: even past the gateway's admin confirm, refuse a
  // cwd outside the operator's allowlist.
  if (!isCwdAllowed(cwd)) {
    return err(`cwd "${cwd}" is not permitted; agent_execute is restricted to /home/ubuntu/*`);
  }
  const body: Record<string, unknown> = { prompt, cwd, background: true };
  if (args.model) body.model = String(args.model);
  try {
    return ok(pretty(await workerPost('/agent/execute', body)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleTerminalInterrupt(args: Record<string, unknown>): Promise<McpToolResult> {
  const name = String(args.name || '').trim();
  if (!name) return err('name is required.');
  try {
    return ok(pretty(await workerPost(`/terminal/cc/${enc(name)}/interrupt`, {})));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleTerminalOpenTab(args: Record<string, unknown>): Promise<McpToolResult> {
  const command = String(args.command || '').trim();
  if (!command) return err('command is required.');
  const cwd = args.cwd ? String(args.cwd) : '';
  if (cwd && !isCwdAllowed(cwd)) {
    return err(`cwd "${cwd}" is not permitted; restricted to /home/ubuntu/*`);
  }
  const body: Record<string, unknown> = { command };
  if (cwd) body.cwd = cwd;
  if (args.title) body.title = String(args.title);
  if (args.kind) body.kind = String(args.kind);
  try {
    return ok(pretty(await workerPost('/terminal/tabs', body)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleDeleteConversation(args: Record<string, unknown>): Promise<McpToolResult> {
  const uuid = String(args.conversation_uuid || '').trim();
  if (!uuid) return err('conversation_uuid is required.');
  try {
    return ok(pretty(await workerDelete(`/claude-ai/conversations/${enc(uuid)}`)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// ─── claude.ai marketplace + plugin handlers ─────────────────────────────

async function handleClaudeaiListMarketplaces(args: Record<string, unknown>): Promise<McpToolResult> {
  const scope = args.scope ? String(args.scope) : '';
  const qs = scope ? `?scope=${enc(scope)}` : '';
  try {
    return ok(pretty(await workerGet(`/claude-ai/marketplaces${qs}`)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleClaudeaiAddMarketplace(args: Record<string, unknown>): Promise<McpToolResult> {
  const name = String(args.name || '').trim();
  const sourceUrl = String(args.source_url || '').trim();
  if (!name || !sourceUrl) return err('name and source_url are required.');
  try {
    return ok(pretty(await workerPost('/claude-ai/marketplaces', { name, source_url: sourceUrl })));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleClaudeaiRemoveMarketplace(args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.marketplace_id || '').trim();
  if (!id) return err('marketplace_id is required.');
  try {
    return ok(pretty(await workerDelete(`/claude-ai/marketplaces/${enc(id)}`)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleClaudeaiListMarketplacePlugins(args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.marketplace_id || '').trim();
  if (!id) return err('marketplace_id is required.');
  try {
    return ok(pretty(await workerGet(`/claude-ai/marketplaces/${enc(id)}/plugins`)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleClaudeaiListPlugins(args: Record<string, unknown>): Promise<McpToolResult> {
  const qs = args.enabled_only ? '?enabled_only=true' : '';
  try {
    return ok(pretty(await workerGet(`/claude-ai/plugins${qs}`)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleClaudeaiSetPluginEnabled(args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.plugin_id || '').trim();
  if (!id) return err('plugin_id is required.');
  if (typeof args.enabled !== 'boolean') return err('enabled (boolean) is required.');
  try {
    return ok(pretty(await workerPut(`/claude-ai/plugins/${enc(id)}/enabled`, { enabled: args.enabled })));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// ─── memory map + rules map handlers (shell out to CLIs) ───────────────────

/** Resolve the path to a core/scripts/*.js CLI from anywhere in the dist tree. */
function cliPath(script: string): string {
  // At runtime __dirname is core/dist/mcp-server/tools; go up 3 to core/, then scripts/
  return nodePath.resolve(__dirname, '../../../scripts', script);
}

/** Detect the API port the same way _passthrough.ts does. */
function apiPort(): string {
  if (process.env.API_PORT) return process.env.API_PORT;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const cfgPath = nodePath.join(os.homedir(), '.claude-code-config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as { devModeEnabled?: boolean };
    if (cfg.devModeEnabled) return '3200';
  } catch { /* default */ }
  return '3100';
}

function runCli(argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      'node',
      argv,
      { maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}

async function handleMemoryMap(args: Record<string, unknown>): Promise<McpToolResult> {
  const argv: string[] = [cliPath('memory-map.js'), '--port', apiPort(), '--format', 'json'];
  if (args.level) argv.push('--level', String(args.level));
  if (args.projects) argv.push('--projects', String(args.projects));
  if (args.nodes) argv.push('--nodes', String(args.nodes));
  if (args.types) argv.push('--types', String(args.types));
  if (args.category) argv.push('--category', String(args.category));
  if (args.q) argv.push('--q', String(args.q));
  if (args.since) argv.push('--since', String(args.since));
  if (args.limit) argv.push('--limit', String(args.limit));
  if (args.stats) argv.push('--stats');
  try {
    return ok(await runCli(argv));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleMemoryRecord(args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.recordId || '').trim();
  if (!id) return err('recordId is required.');
  const argv: string[] = [cliPath('memory-map.js'), '--port', apiPort(), '--record', id];
  try {
    return ok(await runCli(argv));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleRuleMap(args: Record<string, unknown>): Promise<McpToolResult> {
  const argv: string[] = [cliPath('rule-map.js'), '--port', apiPort(), '--format', 'json'];
  if (args.level) argv.push('--level', String(args.level));
  if (args.scope) argv.push('--scope', String(args.scope));
  if (args.paths) argv.push('--paths', String(args.paths));
  if (args.always) argv.push('--always');
  if (args.category) argv.push('--category', String(args.category));
  if (args.q) argv.push('--q', String(args.q));
  if (args.limit) argv.push('--limit', String(args.limit));
  if (args.stats) argv.push('--stats');
  try {
    return ok(await runCli(argv));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Name → handler for every expanded tool. Both transports consult this map
 * as a fallback for tool names not in their explicit switch.
 */
export const EXPANDED_HANDLERS: Record<
  string,
  (args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  // read
  list_executions: () => handleListExecutions(),
  get_execution: handleGetExecution,
  memory_projects: () => handleMemoryProjects(),
  memory_cross_host: handleMemoryCrossHost,
  memory_import_candidates: handleMemoryImportCandidates,
  terminal_list: () => handleTerminalList(),
  terminal_capture: handleTerminalCapture,
  // claude.ai marketplaces + plugins (read)
  claudeai_list_marketplaces: handleClaudeaiListMarketplaces,
  claudeai_list_marketplace_plugins: handleClaudeaiListMarketplacePlugins,
  claudeai_list_plugins: handleClaudeaiListPlugins,
  // write
  claudeai_create_conversation: handleClaudeaiCreateConversation,
  claudeai_completion: handleClaudeaiCompletion,
  claudeai_add_marketplace: handleClaudeaiAddMarketplace,
  claudeai_remove_marketplace: handleClaudeaiRemoveMarketplace,
  claudeai_set_plugin_enabled: handleClaudeaiSetPluginEnabled,
  agent_abort: handleAgentAbort,
  agent_resume: handleAgentResume,
  terminal_prompt: handleTerminalPrompt,
  terminal_slash: handleTerminalSlash,
  // admin
  agent_execute: handleAgentExecute,
  terminal_interrupt: handleTerminalInterrupt,
  terminal_open_tab: handleTerminalOpenTab,
  delete_conversation: handleDeleteConversation,
  // memory map + rules map (read — shell out to CLIs)
  memory_map: handleMemoryMap,
  memory_record: handleMemoryRecord,
  rule_map: handleRuleMap,
  // multi-node (worker-side fallback; hub answers the full list when connected)
  list_nodes: async () => handleListNodes(),
  // github (read: github_query, write: github_mutate) — dispatch to /github/<action>
  ...GITHUB_HANDLERS,
  // port forward (open/list/close node-to-node TCP tunnel)
  ...PORT_FORWARD_HANDLERS,
};
