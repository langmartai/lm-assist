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

import {
  ok,
  err,
  workerGet,
  workerPost,
  workerPostRaw,
  workerDelete,
  isCwdAllowed,
  type McpToolResult,
} from './_passthrough';
import { handleListNodes } from './list-nodes';
import { GITHUB_TOOL_DEFS, GITHUB_HANDLERS } from './github';

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

// ─── ccr: Claude Code remote support ─────────────────────────────
export const ccSessionsToolDef = {
  name: 'cc_sessions',
  description:
    'List the live Claude Code sessions on this host (from the ~/.claude/sessions registry), each with an ownership verdict (connectStrategy: attach-existing | create-tmux | refuse | none, plus safeToCreateTmux). Read-only.',
  inputSchema: { type: 'object' as const, properties: {} },
};
export const ccrPreflightToolDef = {
  name: 'ccr_preflight',
  description:
    'Ownership verdict for one Claude Code session id, WITHOUT side effects — is it live, in a tmux, and is it safe to spawn a new `claude --resume` tmux. Call before ccr_connect.',
  inputSchema: {
    type: 'object' as const,
    properties: { session_id: { type: 'string', description: 'Claude Code session UUID.' } },
    required: ['session_id'],
  },
};
export const ccrRemoteListToolDef = {
  name: 'ccr_remote_list',
  description: 'List running CCR remotes (load/mirror/connect bridges started via ccr_*), with liveness.',
  inputSchema: { type: 'object' as const, properties: {} },
};
export const ccrLoadToolDef = {
  name: 'ccr_load',
  description:
    'Load an existing Claude Code session into a fresh claude.ai/code session as a READ-ONLY replay (disconnected). Returns the web URL. Provide session_id (resolves the transcript) or an explicit jsonl path.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: { type: 'string', description: 'Claude Code session UUID (transcript resolved automatically).' },
      jsonl: { type: 'string', description: 'Explicit transcript .jsonl path (alternative to session_id).' },
    },
  },
};
export const ccrMirrorToolDef = {
  name: 'ccr_mirror',
  description:
    'Start a ONE-WAY live mirror of a Claude Code session to claude.ai/code (updates as the session grows; not drivable). Returns the web URL.',
  inputSchema: {
    type: 'object' as const,
    properties: { session_id: { type: 'string', description: 'Claude Code session UUID.' } },
    required: ['session_id'],
  },
};
export const ccrConnectToolDef = {
  name: 'ccr_connect',
  description:
    'Connect a Claude Code session for TWO-WAY remote control via claude.ai/code. Enforces the safety gate: attaches an existing tmux, or spawns a new `claude --resume` tmux ONLY when no live process owns the session storage; refuses (CONFLICT) otherwise to avoid corrupting the append-only transcript. Returns the web URL.',
  inputSchema: {
    type: 'object' as const,
    properties: { session_id: { type: 'string', description: 'Claude Code session UUID.' } },
    required: ['session_id'],
  },
};
export const ccrRemoteStopToolDef = {
  name: 'ccr_remote_stop',
  description: 'Stop a running CCR remote by id (from ccr_remote_list or a ccr_* result).',
  inputSchema: {
    type: 'object' as const,
    properties: { id: { type: 'string', description: 'CCR remote id, e.g. ccr-xxxxxxxx.' } },
    required: ['id'],
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
  // write
  claudeaiCreateConversationToolDef,
  claudeaiCompletionToolDef,
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
  // ccr — Claude Code remote support
  ccSessionsToolDef,
  ccrPreflightToolDef,
  ccrRemoteListToolDef,
  ccrLoadToolDef,
  ccrMirrorToolDef,
  ccrConnectToolDef,
  ccrRemoteStopToolDef,
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

// ─── ccr handlers ────────────────────────────────────────────────
async function handleCcSessions(): Promise<McpToolResult> {
  try { return ok(pretty(await workerGet('/terminal/cc-sessions'))); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
async function handleCcrPreflight(args: Record<string, unknown>): Promise<McpToolResult> {
  const sid = String(args.session_id || '').trim();
  if (!sid) return err('session_id is required.');
  try { return ok(pretty(await workerGet(`/ccr/preflight/${enc(sid)}`))); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
async function handleCcrRemoteList(): Promise<McpToolResult> {
  try { return ok(pretty(await workerGet('/ccr/remote'))); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
// load/mirror/connect spawn processes and can poll up to ~90s, so use the
// raw helper (120s timeout, full envelope) — a refuse surfaces as the body's
// error.code=CONFLICT rather than a transport timeout.
async function handleCcrLoad(args: Record<string, unknown>): Promise<McpToolResult> {
  const body: Record<string, unknown> = {};
  if (args.session_id) body.sessionId = String(args.session_id);
  if (args.jsonl) body.jsonl = String(args.jsonl);
  if (!body.sessionId && !body.jsonl) return err('session_id or jsonl is required.');
  try { return ok(pretty(await workerPostRaw('/ccr/load', body))); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
async function handleCcrMirror(args: Record<string, unknown>): Promise<McpToolResult> {
  const sid = String(args.session_id || '').trim();
  if (!sid) return err('session_id is required.');
  try { return ok(pretty(await workerPostRaw('/ccr/mirror', { sessionId: sid }))); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
async function handleCcrConnect(args: Record<string, unknown>): Promise<McpToolResult> {
  const sid = String(args.session_id || '').trim();
  if (!sid) return err('session_id is required.');
  try { return ok(pretty(await workerPostRaw('/ccr/connect', { sessionId: sid }))); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
async function handleCcrRemoteStop(args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.id || '').trim();
  if (!id) return err('id is required.');
  try { return ok(pretty(await workerPost(`/ccr/remote/${enc(id)}/stop`, {}))); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
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
  // write
  claudeai_create_conversation: handleClaudeaiCreateConversation,
  claudeai_completion: handleClaudeaiCompletion,
  agent_abort: handleAgentAbort,
  agent_resume: handleAgentResume,
  terminal_prompt: handleTerminalPrompt,
  terminal_slash: handleTerminalSlash,
  // admin
  agent_execute: handleAgentExecute,
  terminal_interrupt: handleTerminalInterrupt,
  terminal_open_tab: handleTerminalOpenTab,
  delete_conversation: handleDeleteConversation,
  // multi-node (worker-side fallback; hub answers the full list when connected)
  list_nodes: async () => handleListNodes(),
  // github (read: github_query, write: github_mutate) — dispatch to /github/<action>
  ...GITHUB_HANDLERS,
  // ccr — Claude Code remote support
  cc_sessions: () => handleCcSessions(),
  ccr_preflight: handleCcrPreflight,
  ccr_remote_list: () => handleCcrRemoteList(),
  ccr_load: handleCcrLoad,
  ccr_mirror: handleCcrMirror,
  ccr_connect: handleCcrConnect,
  ccr_remote_stop: handleCcrRemoteStop,
};
