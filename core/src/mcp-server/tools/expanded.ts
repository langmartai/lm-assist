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
  workerPostRaw,
  workerPut,
  workerDelete,
  isCwdAllowed,
  type McpToolResult,
} from './_passthrough';
import { planOpenTab } from './open-tab-plan';
import * as os from 'os';
import { handleListNodes } from './list-nodes';
import { GITHUB_TOOL_DEFS, GITHUB_HANDLERS } from './github';
import { PORT_FORWARD_TOOL_DEFS, PORT_FORWARD_HANDLERS } from './port-forward';
import { TRANSFER_TOOL_DEFS, TRANSFER_HANDLERS } from './transfer';
import { FS_INSPECT_TOOL_DEFS, FS_INSPECT_HANDLERS } from './fs-inspect';
import { SESSION_MESSAGING_TOOL_DEFS, SESSION_MESSAGING_HANDLERS } from './session-messaging';
import { DATA_TOOL_DEFS, DATA_HANDLERS } from './data-tools';
import { AUTH_STATUS_TOOL_DEFS, AUTH_STATUS_HANDLERS } from './auth-status';
import { CLAUDE_CODE_ACCOUNT_TOOL_DEFS, CLAUDE_CODE_ACCOUNT_HANDLERS } from './claude-code-account';
import { CLAUDEAI_ACCOUNT_TOOL_DEFS, CLAUDEAI_ACCOUNT_HANDLERS } from './claudeai-account';
import { SESSION_DAG_TOOL_DEFS, SESSION_DAG_HANDLERS } from './session-dag-tool';
import { CLAUDE_CODE_USAGE_TOOL_DEFS, CLAUDE_CODE_USAGE_HANDLERS } from './claude-code-usage';
import { CLAUDEAI_ACTIVE_SESSIONS_TOOL_DEFS, CLAUDEAI_ACTIVE_SESSIONS_HANDLERS } from './claudeai-active-sessions';
import { BROWSER_TASK_TOOL_DEFS, BROWSER_TASK_HANDLERS } from './browser-task';
import { REFRESH_CONNECTOR_TOOL_DEFS, REFRESH_CONNECTOR_HANDLERS } from './refresh-connector';
import { SCHEDULER_TOOL_DEFS, SCHEDULER_HANDLERS } from './scheduler';
import { GUIDE_TOOL_DEFS, GUIDE_HANDLERS } from './guide';
import { SESSION_STATUS_TOOL_DEFS, SESSION_STATUS_HANDLERS } from '../mcp-session-resolver';
import { WORKER_ROLE_TOOL_DEFS, WORKER_ROLE_HANDLERS } from './worker-role';
import { MISSION_TOOL_DEFS, MISSION_HANDLERS } from './mission';
import { CLAUDEAI_LOGIN_TOOL_DEFS, CLAUDEAI_LOGIN_HANDLERS } from './claudeai-login';

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
    'Get the full detail of one background agent execution by id — status, the agent\'s ' +
    'result/output once complete, session id + URL, and start/end timestamps. Pass the id ' +
    'from `list_executions` (or the executionId returned by `agent_execute`). Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Execution id from list_executions.' },
    },
    required: ['id'],
  },
};

export const stallStatusToolDef = {
  name: 'stall_status',
  description: 'Auto-resume monitor status: whether this node is the elected stall-monitor, and the per-session retry/gave-up state for sessions stalled on server errors. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
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

// ─── Windows terminal (Windows hosts only — tmux substitute) ─────────────

export const windowsTerminalListToolDef = {
  name: 'windows_terminal_list',
  description:
    'List live Claude Code sessions on a WINDOWS host with their Windows Terminal window/tab mapping ' +
    'and a `driveable` verdict (the Windows equivalent of terminal_list — Windows has no tmux). ' +
    'Returns NOT_SUPPORTED on non-Windows hosts. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const windowsTerminalCaptureToolDef = {
  name: 'windows_terminal_capture',
  description:
    'Read the visible terminal text of a Windows Claude Code session (capture-pane equivalent). ' +
    'Pass `sessionId` (from windows_terminal_list) OR a raw `pid` (reaches a session stuck at the ' +
    'folder-trust prompt that has not registered yet). Read-only — no keystrokes.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      sessionId: { type: 'string', description: 'Session id from windows_terminal_list.' },
      pid: { type: 'number', description: 'Raw process id (alternative to sessionId).' },
    },
  },
};

export const windowsTerminalStateToolDef = {
  name: 'windows_terminal_state',
  description:
    'Classify what a Windows Claude Code session is showing: folder_trust, await_question, ' +
    'rate_limit_user, rate_limit_server, overloaded, server_error, auth_error, busy, idle, unknown ' +
    '(with detail/options). Pass `sessionId` OR raw `pid`. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      sessionId: { type: 'string', description: 'Session id from windows_terminal_list.' },
      pid: { type: 'number', description: 'Raw process id (alternative to sessionId).' },
    },
  },
};

export const windowsTerminalLaunchToolDef = {
  name: 'windows_terminal_launch',
  description:
    'Launch ANY command in a new Windows Terminal window/tab (GENERIC — Claude Code is just one ' +
    'consumer of the Windows terminal driver). Returns the new tab RuntimeId. For a Claude session ' +
    'use windows_terminal_create instead. WRITE — spawns a process.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      command: { type: 'string', description: 'Command to run (launched as `cmd /k <command>`).' },
      cwd: { type: 'string', description: 'Working directory.' },
      mode: { type: 'string', description: "'window' (default) or 'tab'." },
    },
    required: ['command'],
  },
};

export const windowsTerminalCreateToolDef = {
  name: 'windows_terminal_create',
  description:
    'Launch a NEW Claude Code session in a Windows Terminal window (or tab). Auto-accepts the ' +
    'folder-trust prompt by default. Returns the new sessionId once it registers. WRITE — spawns a ' +
    'real process.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      cwd: { type: 'string', description: 'Working directory for the new session.' },
      mode: { type: 'string', description: "'window' (default) or 'tab'." },
      resume: { type: 'string', description: 'Resume a non-live sessionId (continues its transcript).' },
      autoTrust: { type: 'boolean', description: 'Auto-accept folder-trust prompt (default true).' },
    },
  },
};

export const windowsTerminalSendToolDef = {
  name: 'windows_terminal_send',
  description:
    'Type text into a Windows Claude Code session (focus its tab + paste). Set `submit` to also press ' +
    'Enter. Pass `sessionId` from windows_terminal_list. WRITE — drives the session.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      sessionId: { type: 'string', description: 'Session id from windows_terminal_list.' },
      text: { type: 'string', description: 'Text to type.' },
      submit: { type: 'boolean', description: 'Press Enter after typing (default false).' },
    },
    required: ['sessionId', 'text'],
  },
};

export const windowsTerminalAutoHandleToolDef = {
  name: 'windows_terminal_auto_handle',
  description:
    "Detect a Windows session's screen state and advance it: auto-accept folder trust (default), or " +
    'answer a numbered prompt with `answer`. Other states (rate limits, server/auth errors) are ' +
    'reported, not actioned. Pass `sessionId` OR raw `pid`. WRITE.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      sessionId: { type: 'string', description: 'Session id from windows_terminal_list.' },
      pid: { type: 'number', description: 'Raw process id (e.g. a stuck, unregistered session).' },
      trust: { type: 'boolean', description: 'Accept folder-trust prompt (default true).' },
      answer: { type: 'number', description: 'Digit to answer a numbered question (1-9).' },
    },
  },
};

export const windowsTerminalCloseToolDef = {
  name: 'windows_terminal_close',
  description:
    'Terminate a Windows Claude Code session. With `closeTab` (default true) also closes its Windows ' +
    'Terminal tab/window. Pass `sessionId` from windows_terminal_list. WRITE — destructive.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      sessionId: { type: 'string', description: 'Session id from windows_terminal_list.' },
      closeTab: { type: 'boolean', description: 'Also close the tab/window (default true).' },
    },
    required: ['sessionId'],
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
      auto_delete_hours: {
        type: 'number',
        description: 'Mark the conversation for auto-deletion after this many hours (tags its name with ' +
          'a TTL marker; the scheduled cleanup-test sweep deletes it once expired). Good for throwaway chats.',
      },
    },
  },
};

export const claudeaiCompletionToolDef = {
  name: 'claudeai_completion',
  description:
    'Send a prompt to an existing claude.ai web conversation and get the assistant reply. ' +
    'SPENDS TOKENS on the user\'s claude.ai account. The conversation must already exist — ' +
    'create one first with `claudeai_create_conversation`. WRITE.\n' +
    'To DRIVE the claude.ai conversation to CALL lm-assist connector tools (not just chat), set ' +
    '`enable_connector_tools` (true = all the langmart connector\'s tools, or a list of tool names). ' +
    'lm-assist builds the tool definitions for that turn and — with `auto_approve_tools` (default ON ' +
    'when enabling) — releases claude.ai\'s per-tool approval gates so the calls actually run. The ' +
    'response includes an `approvals` summary of any tool calls made.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      conversation_uuid: { type: 'string', description: 'Target conversation uuid.' },
      prompt: { type: 'string', description: 'The message to send.' },
      model: { type: 'string', description: 'Optional model override.' },
      enable_connector_tools: {
        description: 'Expose lm-assist connector tools to the claude.ai model on this turn so it can CALL them. ' +
          'Pass true for all the connector\'s tools, or an array of tool names ' +
          '(e.g. ["data_catalog","list_nodes"]). Omit for a plain text reply.',
        oneOf: [{ type: 'boolean' }, { type: 'array', items: { type: 'string' } }],
      },
      auto_approve_tools: {
        type: 'boolean',
        description: 'Auto-release claude.ai\'s per-tool approval gates so the driven calls run ' +
          '(default true when enable_connector_tools is set).',
      },
      tools: {
        type: 'array',
        description: 'Advanced: an explicit claude.ai SPA tools array (overrides enable_connector_tools). ' +
          'Most callers should use enable_connector_tools instead.',
        items: { type: 'object' },
      },
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
    "ADMIN / high-risk — runs real code. cwd is restricted to directories under the " +
    "worker's own home dir. Requires out-of-band confirmation before it executes. " +
    'Runs in the BACKGROUND — returns immediately with an executionId; poll ' +
    '`get_execution(id=...)` for status and the result. ' +
    '🚫 NOT for running a MISSION worker/executor: this is a one-shot SDK agent — you CANNOT ' +
    'see or answer an AskUserQuestion it raises, so any worker that must ask a question is ' +
    'unreachable. To run a mission executor use `ccr_cloud_start` (a monitorable session) + ' +
    '`mission_update({binding})`, and answer its questions with `mission_session_answer`. ' +
    'Use agent_execute only for a fire-and-forget side task with NO interaction.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: { type: 'string', description: 'The task for the Claude Code session.' },
      cwd: { type: 'string', description: "Working directory — MUST be under the worker's home dir." },
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
    'Open a terminal on the host running a command. Omit `kind` to use the platform-neutral ' +
    'local terminal (tmux on Linux, wt on Windows) — this is what works on a Windows node. ' +
    'ADMIN — spawns a host process. Requires out-of-band confirmation.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Window title (advanced kinds only).' },
      cwd: { type: 'string', description: "Working directory (under the worker's home dir)." },
      command: { type: 'string', description: 'Command to run in the new terminal.' },
      kind: { type: 'string', description: 'Optional. Omit for the platform-neutral local terminal (recommended; works on Windows). Or one of gnome|wt-ssh|tmux for the advanced tab spawner — wt-ssh needs sshTarget, tmux needs tmuxSession.' },
      sshTarget: { type: 'string', description: 'For kind=wt-ssh: ssh target (user@host or host).' },
      tmuxSession: { type: 'string', description: 'For kind=tmux: tmux session name to open the tab in.' },
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
    'Connect a Claude Code session for TWO-WAY remote control via claude.ai/code. For a LIVE session it injects /remote-control to connect in place; if the input is unreachable (headless) it kill-and-resumes only when idle or force:true. For a DEAD session it spawns a new `claude --resume` tmux ONLY when no live process owns the session storage. Returns the web URL.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: { type: 'string', description: 'Claude Code session UUID.' },
      force: { type: 'boolean', description: 'Kill-and-resume a live, unreachable, actively-busy session (idle sessions auto-kill). Default false.' },
    },
    required: ['session_id'],
  },
};
export const ccrDriveToolDef = {
  name: 'ccr_drive',
  description:
    'Send a prompt (a user turn) INTO a two-way connected Claude Code session via the claude.ai cloud endpoint — works even when you are NOT on the session\'s host (remote agent / connector / phone). Requires a live ccr_connect bridge for the target. Resolve the target by session_id (preferred — finds its live bridge), the ccr remote id (ccr-xxxxxxxx), or an explicit cse_… id. Same-host callers may pass prefer_tmux to skip the cloud round-trip and type directly into the local tmux. Returns which path delivered it (cloud|tmux) plus the cloud event id.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: { type: 'string', description: 'Claude Code session UUID — resolves its live two-way bridge.' },
      id: { type: 'string', description: 'CCR remote id (ccr-xxxxxxxx), alternative to session_id.' },
      cse: { type: 'string', description: 'Explicit claude.ai code-session id (cse_…), alternative to session_id/id.' },
      text: { type: 'string', description: 'The prompt text to deliver as a user turn.' },
      prefer_tmux: { type: 'boolean', description: 'Same-host shortcut: drive the local tmux directly instead of the cloud endpoint.' },
    },
    required: ['text'],
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
// ─── Cloud CCR (BYOC cloud-run): claude runs in an Anthropic-cloud container ──
export const ccrCloudStartToolDef = {
  name: 'ccr_cloud_start',
  description:
    'Start a CLOUD CCR session — claude runs in an Anthropic-cloud container (NO local machine/tmux/bridge needed). Distinct from ccr_connect (which bridges a LOCAL session). The standard seed is a GitHub repo the container CLONES: pass repo="owner/name" (or a github.com URL) and optional branch (defaults to the repo\'s default branch); works for public and the org\'s private repos. Returns the session id (session_…) + claude.ai/code URL; it boots async, so poll ccr_cloud_read for the first reply. Use ccr_cloud_repos to list available repos. (Fallback seeds: cwd = upload a LOCAL repo\'s committed HEAD <=50 MiB; omit everything for an empty scratch workspace.) Spends cloud compute/quota — use deliberately.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: { type: 'string', description: 'OPTIONAL initial user turn. Omit to just boot (clone the repo) and drive it later with ccr_cloud_drive.' },
      repo: { type: 'string', description: 'GitHub repo to clone: "owner/name" or a github.com URL.' },
      branch: { type: 'string', description: 'Branch/revision (default: the repo\'s default branch).' },
      cwd: { type: 'string', description: 'Fallback: local git repo to bundle+upload instead of a GitHub clone (<=50 MiB).' },
      model: { type: 'string', description: 'Model id (default claude-opus-4-8[1m]).' },
      title: { type: 'string', description: 'Optional session title.' },
      setup: { type: 'boolean', description: 'Seed a bootstrap/self-heal instruction into the first turn: the container ensures lm-assist runs LOCALLY (restart if just down, install/clone if missing) before its task. No hub key embedded; connecting to the hub is a separate in-session step. Default false.' },
      role: { type: 'string', enum: ['worker', 'orchestrator'], description: 'With setup: give the session a role contract (worker → set_role + ⟦WORKER-STATUS⟧ + report/agree-gate; orchestrator → read/drive/decide workers), per guide("roles").' },
      primaryRepo: { type: 'string', description: 'With setup: the session\'s working repo (defaults to `repo`). If it is NOT lm-assist, the bootstrap tells the agent lm-assist is a SEPARATE tool to install independently (npm install -g github:langmartai/lm-assist), then return to this repo.' },
    },
    required: [],
  },
};
export const ccrCloudReposToolDef = {
  name: 'ccr_cloud_repos',
  description: 'List GitHub repos available to seed a cloud session (gh, most-recently-pushed first) with their default branch and private/public flag. Pass one as ccr_cloud_start repo=.',
  inputSchema: { type: 'object' as const, properties: {} },
};
export const ccrCloudDriveToolDef = {
  name: 'ccr_cloud_drive',
  description: 'Send a follow-up user turn to a running CLOUD CCR session (from ccr_cloud_start). Then poll ccr_cloud_read for the reply. Set reBootstrap=true when RESUMING a possibly-inactive session so it self-heals lm-assist (restart/install) before the turn.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      sid: { type: 'string', description: 'Cloud session id (session_…).' },
      text: { type: 'string', description: 'The prompt to send as a user turn.' },
      reBootstrap: { type: 'boolean', description: 'Prepend the bootstrap/self-heal instruction (ensure lm-assist is running locally) — use on RESUME of an inactive container. Default false.' },
      role: { type: 'string', enum: ['worker', 'orchestrator'], description: 'With reBootstrap: the role contract to re-assert.' },
      primaryRepo: { type: 'string', description: 'With reBootstrap: the session\'s working repo (for the lm-assist-vs-separate-tool branch).' },
    },
    required: ['sid', 'text'],
  },
};
export const ccrCloudAnswerToolDef = {
  name: 'ccr_cloud_answer',
  description: 'Answer a PENDING question the cloud claude is blocked on — an AskUserQuestion (surfaced as `pendingQuestion` by ccr_cloud_read when the worker is awaiting input). Sends a tool_result keyed to the question. `answer` = an option\'s LABEL (a "click") OR any free TEXT (a custom reply) — both supported. The pending tool_use_id auto-resolves (or pass tool_use_id). NOTE: this is distinct from ccr_cloud_drive, which sends a NEW user turn — the wrong shape for a pending tool_use.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      sid: { type: 'string', description: 'Cloud session id (session_…).' },
      answer: { type: 'string', description: 'An option label (click) or free-text reply (input).' },
      tool_use_id: { type: 'string', description: 'Optional explicit AskUserQuestion tool_use id (else auto-resolved from the pending question).' },
    },
    required: ['sid', 'answer'],
  },
};
export const ccrCloudReadToolDef = {
  name: 'ccr_cloud_read',
  description: 'Read the transcript (role + text + tool names) of a CLOUD CCR session — the cloud claude\'s replies. ALSO returns `pendingQuestion` (an AskUserQuestion the session is blocked on, with its options) — when present, answer it with ccr_cloud_answer, not ccr_cloud_drive. last_n limits to the most recent N messages.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      sid: { type: 'string', description: 'Cloud session id (session_…).' },
      last_n: { type: 'number', description: 'Return only the most recent N messages.' },
    },
    required: ['sid'],
  },
};
export const ccrCloudStopToolDef = {
  name: 'ccr_cloud_stop',
  description: 'Stop (delete) a CLOUD CCR session and free its container.',
  inputSchema: {
    type: 'object' as const,
    properties: { sid: { type: 'string', description: 'Cloud session id (session_…).' } },
    required: ['sid'],
  },
};
export const ccrCloudListToolDef = {
  name: 'ccr_cloud_list',
  description: 'List CLOUD CCR sessions started via ccr_cloud_start (from this host\'s registry).',
  inputSchema: { type: 'object' as const, properties: {} },
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

export const memorySyncStatusToolDef = {
  name: 'memory_sync_status',
  description:
    "Show this node's cross-node memory-sync state: its mode (persistent home node vs ephemeral " +
    'cloud worker), the home node + project it syncs with, and the live autosync daemon status ' +
    '(observe/on, counts of pushed/refreshed/errors). Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const EXPANDED_TOOL_DEFS = [
  // read
  listExecutionsToolDef,
  getExecutionToolDef,
  stallStatusToolDef,
  memoryProjectsToolDef,
  memorySyncStatusToolDef,
  memoryCrossHostToolDef,
  memoryImportCandidatesToolDef,
  terminalListToolDef,
  terminalCaptureToolDef,
  windowsTerminalListToolDef,
  windowsTerminalCaptureToolDef,
  windowsTerminalStateToolDef,
  windowsTerminalLaunchToolDef,
  windowsTerminalCreateToolDef,
  windowsTerminalSendToolDef,
  windowsTerminalAutoHandleToolDef,
  windowsTerminalCloseToolDef,
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
  // ccr — Claude Code remote support
  ccSessionsToolDef,
  ccrPreflightToolDef,
  ccrRemoteListToolDef,
  ccrLoadToolDef,
  ccrMirrorToolDef,
  ccrConnectToolDef,
  ccrDriveToolDef,
  ccrRemoteStopToolDef,
  ccrCloudStartToolDef,
  ccrCloudReposToolDef,
  ccrCloudDriveToolDef,
  ccrCloudAnswerToolDef,
  ccrCloudReadToolDef,
  ccrCloudStopToolDef,
  ccrCloudListToolDef,
  // port forward (node-to-node TCP tunnel)
  ...PORT_FORWARD_TOOL_DEFS,
  ...TRANSFER_TOOL_DEFS,
  ...FS_INSPECT_TOOL_DEFS,
  // session-to-session messaging (send: write/admin; list+status: read)
  ...SESSION_MESSAGING_TOOL_DEFS,
  // data service (read: catalog/request_access/get/query; write: put/delete)
  ...DATA_TOOL_DEFS,
  // credential health — claude.ai cookie + Claude Code OAuth (read, no secrets)
  ...AUTH_STATUS_TOOL_DEFS,
  ...CLAUDE_CODE_ACCOUNT_TOOL_DEFS,
  ...CLAUDEAI_ACCOUNT_TOOL_DEFS,
  ...SESSION_DAG_TOOL_DEFS,
  ...CLAUDE_CODE_USAGE_TOOL_DEFS,
  ...CLAUDEAI_ACTIVE_SESSIONS_TOOL_DEFS,
  ...BROWSER_TASK_TOOL_DEFS,
  ...REFRESH_CONNECTOR_TOOL_DEFS,
  ...SCHEDULER_TOOL_DEFS,
  ...GUIDE_TOOL_DEFS,
  ...SESSION_STATUS_TOOL_DEFS,
  // worker role — set_role / report_status / worker_status / list_workers / decide_gate
  ...WORKER_ROLE_TOOL_DEFS,
  // mission controller — mission_create / mission_list / mission_update / mission_control_status
  ...MISSION_TOOL_DEFS,
  // auth: guided re-login for cookie + OAuth
  ...CLAUDEAI_LOGIN_TOOL_DEFS,
] as const;

// ─── Handlers ────────────────────────────────────────────────────

function pretty(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

/**
 * Render a RAW `{success,data,error}` envelope (from workerPostRaw, which does
 * NOT throw on success:false) as a tool result. A `success:false` body becomes
 * a proper isError result instead of being wrapped as success — otherwise a
 * CONFLICT refusal (ccr_connect) or a failed write (windows_terminal_*) reads
 * to the LLM as if it had worked. Mirrors github.ts's envelope handling.
 */
function renderRaw(body: Record<string, unknown>): McpToolResult {
  if (body && body.success === false) {
    const e = body.error as { message?: string; code?: string } | string | undefined;
    const msg = typeof e === 'string' ? e : e?.message || e?.code || 'request failed';
    return err(msg);
  }
  return ok(pretty(body));
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

async function handleStallStatus(): Promise<McpToolResult> {
  try {
    return ok(pretty(await workerGet('/monitor/stalls')));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
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
    const status = (await workerGet(`/agent/execution/${enc(id)}`)) as Record<string, unknown>;
    // The status route omits the agent's actual output. Also pull the
    // (non-waiting) result so a completed run is readable through this tool —
    // otherwise nothing exposes what the agent produced. Result is optional:
    // a still-running execution has none, and a fetch failure must not sink
    // the status we already have.
    let merged = status;
    try {
      const result = (await workerGet(`/agent/execution/${enc(id)}/result?wait=false`)) as Record<string, unknown>;
      if (result && (result.result !== undefined || result.error !== undefined)) {
        merged = {
          ...status,
          completed: result.completed,
          result: result.result,
          error: result.error ?? status.error,
        };
      }
    } catch { /* result optional — status alone is still useful */ }
    return ok(pretty(merged));
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

async function handleMemorySyncStatus(): Promise<McpToolResult> {
  // Prefer the live Core view (config + running daemon); fall back to the on-disk config if Core is down.
  try {
    return ok(pretty(await workerGet('/memory/sync/status')));
  } catch {
    try {
      const { readMemorySyncConfig } = await import('../../memory/node-mode');
      return ok(pretty({ config: readMemorySyncConfig(), daemon: null, note: 'Core unreachable — on-disk config only' }));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
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

// ─── Windows terminal handlers ───────────────────────────────────────────
const winSid = (a: Record<string, unknown>): string => String(a.sessionId || '').trim();
const winPid = (a: Record<string, unknown>): number => Number(a.pid || 0);

async function handleWindowsTerminalList(): Promise<McpToolResult> {
  try {
    return ok(pretty(await workerGet('/terminal/cc-sessions')));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
async function handleWindowsTerminalCapture(a: Record<string, unknown>): Promise<McpToolResult> {
  const sid = winSid(a);
  const pid = winPid(a);
  if (!sid && !pid) return err('sessionId or pid is required.');
  try {
    const path = sid ? `/terminal/cc-sessions/${enc(sid)}/screen` : `/terminal/local/${pid}/capture`;
    return ok(pretty(await workerGet(path)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
async function handleWindowsTerminalState(a: Record<string, unknown>): Promise<McpToolResult> {
  const sid = winSid(a);
  const pid = winPid(a);
  if (!sid && !pid) return err('sessionId or pid is required.');
  try {
    const path = sid ? `/terminal/cc-sessions/${enc(sid)}/screen` : `/terminal/local/${pid}/capture`;
    return ok(pretty(await workerGet(path)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
async function handleWindowsTerminalLaunch(a: Record<string, unknown>): Promise<McpToolResult> {
  const command = String(a.command || '').trim();
  if (!command) return err('command is required.');
  const body: Record<string, unknown> = { command };
  if (a.cwd) body.cwd = String(a.cwd);
  if (a.mode) body.mode = String(a.mode);
  try {
    return renderRaw(await workerPostRaw('/terminal/local', body));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
async function handleWindowsTerminalCreate(a: Record<string, unknown>): Promise<McpToolResult> {
  const body: Record<string, unknown> = {};
  if (a.cwd) body.cwd = String(a.cwd);
  if (a.mode) body.mode = String(a.mode);
  if (a.resume) body.resume = String(a.resume);
  if (typeof a.autoTrust === 'boolean') body.autoTrust = a.autoTrust;
  try {
    return renderRaw(await workerPostRaw('/terminal/cc-sessions', body));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
async function handleWindowsTerminalSend(a: Record<string, unknown>): Promise<McpToolResult> {
  const sid = winSid(a);
  const text = String(a.text || '');
  if (!sid) return err('sessionId is required.');
  if (!text) return err('text is required.');
  try {
    return renderRaw(await workerPostRaw(`/terminal/cc-sessions/${enc(sid)}/prompt`, { text, submit: a.submit === true }));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
async function handleWindowsTerminalAutoHandle(a: Record<string, unknown>): Promise<McpToolResult> {
  const sid = winSid(a);
  if (!sid) return err('sessionId is required.');
  const body: Record<string, unknown> = {};
  if (typeof a.trust === 'boolean') body.trust = a.trust;
  if (typeof a.answer === 'number') body.answer = a.answer;
  try {
    const path = `/terminal/cc-sessions/${enc(sid)}/auto-handle`;
    return renderRaw(await workerPostRaw(path, body));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
async function handleWindowsTerminalClose(a: Record<string, unknown>): Promise<McpToolResult> {
  const sid = winSid(a);
  if (!sid) return err('sessionId is required.');
  const closeTab = a.closeTab !== false;
  try {
    return ok(pretty(await workerDelete(`/terminal/cc-sessions/${enc(sid)}?closeTab=${closeTab}`)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// ─── write handlers ──────────────────────────────────────────────

async function handleClaudeaiCreateConversation(args: Record<string, unknown>): Promise<McpToolResult> {
  const body: Record<string, unknown> = {};
  if (args.name) body.name = String(args.name);
  // auto_delete_hours: mark the conv for auto-deletion after N hours (coerce — MCP args arrive as strings)
  const adh = typeof args.auto_delete_hours === 'number' ? args.auto_delete_hours
    : (typeof args.auto_delete_hours === 'string' && args.auto_delete_hours.trim() !== '' && Number.isFinite(Number(args.auto_delete_hours)) ? Number(args.auto_delete_hours) : undefined);
  if (adh !== undefined) body.autoDeleteHours = adh;
  try {
    return ok(pretty(await workerPost('/claude-ai/conversations', body)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

/** Coerce enable_connector_tools (bool | string[] | "true"/"false" | JSON-array-string | "name").
 *  MCP args arrive as STRINGS over the connector, so normalize here. */
function parseEnableConnectorTools(v: unknown): boolean | string[] | undefined {
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === 'true') return true;
    if (s === 'false' || s === '') return s === 'false' ? false : undefined;
    if (s.startsWith('[')) { try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map(String); } catch { /* */ } }
    return [s]; // a single tool name
  }
  return undefined;
}

async function handleClaudeaiCompletion(args: Record<string, unknown>): Promise<McpToolResult> {
  const uuid = String(args.conversation_uuid || '').trim();
  const prompt = String(args.prompt || '').trim();
  if (!uuid || !prompt) return err('conversation_uuid and prompt are required.');
  const body: Record<string, unknown> = { prompt };
  if (args.model) body.model = String(args.model);
  // Drive connector tool calls: forward the convenience + raw passthrough to the REST route, which
  // builds the SPA tools array + auto-approves. Coerce connector string-typed args.
  const enable = parseEnableConnectorTools(args.enable_connector_tools);
  if (enable !== undefined) body.enableConnectorTools = enable;
  const aat = typeof args.auto_approve_tools === 'boolean' ? args.auto_approve_tools
    : (args.auto_approve_tools === 'true' ? true : args.auto_approve_tools === 'false' ? false : undefined);
  if (aat !== undefined) body.autoApproveTools = aat;
  if (Array.isArray(args.tools)) body.tools = args.tools;
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
  // The description promises a default of "continue"; supply it so a resume
  // with only session_id doesn't hit the route's MISSING_PROMPT rejection.
  const body: Record<string, unknown> = { prompt: args.prompt ? String(args.prompt) : 'continue' };
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
    return err(`cwd "${cwd}" is not permitted; agent_execute is restricted to ${os.homedir()} and below.`);
  }
  const body: Record<string, unknown> = { prompt, cwd, background: true };
  if (args.model) {
    const model = String(args.model);
    if (!/^(opus|sonnet|haiku)$/i.test(model) && !/^claude-/.test(model)) {
      return err(`model must be opus|sonnet|haiku or a full claude-* id; got "${model}".`);
    }
    body.model = model;
  }
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
  const plan = planOpenTab(args);
  if ('error' in plan) return err(plan.error);
  try {
    return ok(pretty(await workerPost(plan.route, plan.body)));
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
  try { return renderRaw(await workerPostRaw('/ccr/load', body)); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
async function handleCcrMirror(args: Record<string, unknown>): Promise<McpToolResult> {
  const sid = String(args.session_id || '').trim();
  if (!sid) return err('session_id is required.');
  try { return renderRaw(await workerPostRaw('/ccr/mirror', { sessionId: sid })); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
async function handleCcrConnect(args: Record<string, unknown>): Promise<McpToolResult> {
  const sid = String(args.session_id || '').trim();
  if (!sid) return err('session_id is required.');
  const body: Record<string, unknown> = { sessionId: sid };
  // Connector bool args can arrive as strings — coerce.
  if (args.force === true || args.force === 'true') body.force = true;
  try { return renderRaw(await workerPostRaw('/ccr/connect', body)); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
async function handleCcrRemoteStop(args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.id || '').trim();
  if (!id) return err('id is required.');
  try { return ok(pretty(await workerPost(`/ccr/remote/${enc(id)}/stop`, {}))); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
async function handleCcrDrive(args: Record<string, unknown>): Promise<McpToolResult> {
  const text = String(args.text || '').trim();
  if (!text) return err('text is required.');
  const body: Record<string, unknown> = { text };
  if (args.session_id) body.sessionId = String(args.session_id);
  if (args.id) body.id = String(args.id);
  if (args.cse) body.cse = String(args.cse);
  // Connector bool args can arrive as strings — coerce.
  if (args.prefer_tmux === true || args.prefer_tmux === 'true') body.preferTmux = true;
  if (!body.sessionId && !body.id && !body.cse) return err('one of session_id, id, or cse is required.');
  try { return renderRaw(await workerPostRaw('/ccr/drive', body)); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
async function handleCcrCloudStart(args: Record<string, unknown>): Promise<McpToolResult> {
  const body: Record<string, unknown> = {};
  const prompt = String(args.prompt || '').trim();
  if (prompt) body.prompt = prompt;
  if (args.repo) body.repo = String(args.repo);
  if (args.branch) body.branch = String(args.branch);
  if (args.cwd) body.cwd = String(args.cwd);
  if (args.model) body.model = String(args.model);
  if (args.title) body.title = String(args.title);
  if (args.setup === true || args.setup === 'true') body.setup = true;
  if (args.role === 'worker' || args.role === 'orchestrator') body.role = args.role;
  if (args.primaryRepo) body.primaryRepo = String(args.primaryRepo);
  if (!body.prompt && !body.repo && !body.cwd && !body.setup) return err('provide a repo or a prompt to start a cloud session.');
  try { return renderRaw(await workerPostRaw('/ccr/cloud/start', body)); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
async function handleCcrCloudRepos(): Promise<McpToolResult> {
  try { return ok(pretty(await workerGet('/ccr/cloud/repos'))); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
async function handleCcrCloudDrive(args: Record<string, unknown>): Promise<McpToolResult> {
  const sid = String(args.sid || '').trim();
  const text = String(args.text || '').trim();
  if (!sid) return err('sid is required.');
  if (!text) return err('text is required.');
  const driveBody: Record<string, unknown> = { text };
  if (args.reBootstrap === true || args.reBootstrap === 'true') driveBody.reBootstrap = true;
  if (args.role === 'worker' || args.role === 'orchestrator') driveBody.role = args.role;
  if (args.primaryRepo) driveBody.primaryRepo = String(args.primaryRepo);
  try { return renderRaw(await workerPostRaw(`/ccr/cloud/${enc(sid)}/drive`, driveBody)); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
async function handleCcrCloudAnswer(args: Record<string, unknown>): Promise<McpToolResult> {
  const sid = String(args.sid || '').trim();
  const answer = String(args.answer || '').trim();
  if (!sid) return err('sid is required.');
  if (!answer) return err('answer is required.');
  const body: Record<string, unknown> = { answer };
  if (args.tool_use_id) body.toolUseId = String(args.tool_use_id);
  try { return renderRaw(await workerPostRaw(`/ccr/cloud/${enc(sid)}/answer`, body)); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
async function handleCcrCloudRead(args: Record<string, unknown>): Promise<McpToolResult> {
  const sid = String(args.sid || '').trim();
  if (!sid) return err('sid is required.');
  // connector numeric args can arrive as strings — coerce.
  const lastN = Number(args.last_n);
  const qs = Number.isFinite(lastN) && lastN > 0 ? `?lastN=${Math.floor(lastN)}` : '';
  try { return ok(pretty(await workerGet(`/ccr/cloud/${enc(sid)}${qs}`))); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
async function handleCcrCloudStop(args: Record<string, unknown>): Promise<McpToolResult> {
  const sid = String(args.sid || '').trim();
  if (!sid) return err('sid is required.');
  try { return renderRaw(await workerPostRaw(`/ccr/cloud/${enc(sid)}/stop`, {})); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
async function handleCcrCloudList(): Promise<McpToolResult> {
  try { return ok(pretty(await workerGet('/ccr/cloud'))); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
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
  stall_status: () => handleStallStatus(),
  memory_projects: () => handleMemoryProjects(),
  memory_sync_status: () => handleMemorySyncStatus(),
  memory_cross_host: handleMemoryCrossHost,
  memory_import_candidates: handleMemoryImportCandidates,
  terminal_list: () => handleTerminalList(),
  terminal_capture: handleTerminalCapture,
  windows_terminal_list: () => handleWindowsTerminalList(),
  windows_terminal_capture: handleWindowsTerminalCapture,
  windows_terminal_state: handleWindowsTerminalState,
  windows_terminal_launch: handleWindowsTerminalLaunch,
  windows_terminal_create: handleWindowsTerminalCreate,
  windows_terminal_send: handleWindowsTerminalSend,
  windows_terminal_auto_handle: handleWindowsTerminalAutoHandle,
  windows_terminal_close: handleWindowsTerminalClose,
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
  // ccr — Claude Code remote support
  cc_sessions: () => handleCcSessions(),
  ccr_preflight: handleCcrPreflight,
  ccr_remote_list: () => handleCcrRemoteList(),
  ccr_load: handleCcrLoad,
  ccr_mirror: handleCcrMirror,
  ccr_connect: handleCcrConnect,
  ccr_drive: handleCcrDrive,
  ccr_remote_stop: handleCcrRemoteStop,
  ccr_cloud_start: handleCcrCloudStart,
  ccr_cloud_repos: () => handleCcrCloudRepos(),
  ccr_cloud_drive: handleCcrCloudDrive,
  ccr_cloud_answer: handleCcrCloudAnswer,
  ccr_cloud_read: handleCcrCloudRead,
  ccr_cloud_stop: handleCcrCloudStop,
  ccr_cloud_list: () => handleCcrCloudList(),
  // port forward (open/list/close node-to-node TCP tunnel)
  ...PORT_FORWARD_HANDLERS,
  ...TRANSFER_HANDLERS,
  ...FS_INSPECT_HANDLERS,
  // session-to-session messaging
  ...SESSION_MESSAGING_HANDLERS,
  // data service
  ...DATA_HANDLERS,
  ...AUTH_STATUS_HANDLERS,
  ...CLAUDE_CODE_ACCOUNT_HANDLERS,
  ...CLAUDEAI_ACCOUNT_HANDLERS,
  ...SESSION_DAG_HANDLERS,
  ...CLAUDE_CODE_USAGE_HANDLERS,
  ...CLAUDEAI_ACTIVE_SESSIONS_HANDLERS,
  ...BROWSER_TASK_HANDLERS,
  ...REFRESH_CONNECTOR_HANDLERS,
  ...SCHEDULER_HANDLERS,
  ...GUIDE_HANDLERS,
  ...SESSION_STATUS_HANDLERS,
  // worker role
  ...WORKER_ROLE_HANDLERS,
  // mission controller
  ...MISSION_HANDLERS,
  // auth: guided re-login for cookie + OAuth
  ...CLAUDEAI_LOGIN_HANDLERS,
};
