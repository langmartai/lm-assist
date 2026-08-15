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
  workerGetRaw,
  workerPost,
  workerPostRaw,
  workerPut,
  workerDelete,
  isCwdAllowed,
  type McpToolResult,
} from './_passthrough';
import { CONVERSATION_OPS_TOOL_DEFS, CONVERSATION_OPS_HANDLERS } from './conversation-ops';
import { RENAME_SESSION_TOOL_DEFS, RENAME_SESSION_HANDLERS } from './rename-session';
import { planOpenTab } from './open-tab-plan';
import { ccSessionSummary, claudeaiPluginSummary, detailLevel, intArg, paginate } from './projections';
import * as os from 'os';
import { handleListNodes } from './list-nodes';
import { GITHUB_TOOL_DEFS, GITHUB_HANDLERS } from './github';
import { PORT_FORWARD_TOOL_DEFS, PORT_FORWARD_HANDLERS } from './port-forward';
import { TRANSFER_TOOL_DEFS, TRANSFER_HANDLERS } from './transfer';
import { FS_INSPECT_TOOL_DEFS, FS_INSPECT_HANDLERS } from './fs-inspect';
import { UI_PAGES_TOOL_DEFS, UI_PAGES_HANDLERS } from './ui-pages';
import { SESSION_MESSAGING_TOOL_DEFS, SESSION_MESSAGING_HANDLERS } from './session-messaging';
import { DATA_TOOL_DEFS, DATA_HANDLERS } from './data-tools';
import { AUTH_STATUS_TOOL_DEFS, AUTH_STATUS_HANDLERS } from './auth-status';
import { resolveCallerCandidates } from '../mcp-session-resolver';
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
import { repoOfCached } from '../../utils/repo-id';
import { WORKER_ROLE_TOOL_DEFS, WORKER_ROLE_HANDLERS } from './worker-role';
import { MISSION_TOOL_DEFS, MISSION_HANDLERS } from './mission';
import { MISSION_QUERY_TOOL_DEFS, MISSION_QUERY_HANDLERS } from './mission-query';
import { MISSION_SCHEDULE_TOOL_DEFS, MISSION_SCHEDULE_HANDLERS } from './mission-schedule';
import { MISSION_WORKFLOW_TOOL_DEFS, MISSION_WORKFLOW_HANDLERS } from './mission-workflow';
import { BACKLOG_TOOL_DEFS, BACKLOG_HANDLERS } from './backlog';
import { CLAUDEAI_LOGIN_TOOL_DEFS, CLAUDEAI_LOGIN_HANDLERS } from './claudeai-login';
import { NODE_BUILDS_TOOL_DEFS, NODE_BUILDS_HANDLERS } from './node-builds';
import { NODE_UPGRADE_TOOL_DEFS, NODE_UPGRADE_HANDLERS } from './node-upgrade';
import { CLUSTER_TOOL_DEFS, CLUSTER_HANDLERS } from './cluster';
import { MACHINE_ACCESS_TOOL_DEFS, MACHINE_ACCESS_HANDLERS } from './machine-access';
import { NODE_PROFILE_TOOL_DEFS, NODE_PROFILE_HANDLERS } from './node-profile';
import { NODE_STATUS_TOOL_DEFS, NODE_STATUS_HANDLERS } from './node-status';
import { FABRIC_PROBE_TOOL_DEFS, FABRIC_PROBE_HANDLERS } from './fabric-probe';
import { BUS_TOOL_DEFS, BUS_HANDLERS } from './bus';
import { sessionFootprintsToolDef, handleSessionFootprints } from './session-footprints';
import { nodeLifecycleToolDef, handleNodeLifecycle } from './lifecycle';
import { WHATSAPP_TOOL_DEFS, WHATSAPP_HANDLERS } from './whatsapp';
import { LINKEDIN_TOOL_DEFS, LINKEDIN_HANDLERS } from './linkedin';
import { GMAIL_TOOL_DEFS, GMAIL_HANDLERS } from './gmail';
import { DESKTOP_TOOL_DEFS, DESKTOP_HANDLERS } from './desktop';
import { BACKUP_TOOL_DEFS, BACKUP_HANDLERS } from './backup';
import { ELEVATED_TOOL_DEFS, ELEVATED_HANDLERS } from './elevated';
import { VM_TOOL_DEFS, VM_HANDLERS } from './vm';
import { CONTAINER_TOOL_DEFS, CONTAINER_HANDLERS } from './container';
import { coworkCreateTaskDef, handleCoworkCreateTask } from './cowork';

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

export const windowsTerminalRestartToolDef = {
  name: 'windows_terminal_restart',
  description:
    'Restart a Windows Claude Code session IN PLACE: kill it, verify it is gone, then relaunch with ' +
    '`--resume` so its transcript continues. This is the supported way to recycle a LIVE session — ' +
    'picking up new MCP tools, clearing a wedged context — which `ccr_connect` refuses, because a second ' +
    '`--resume` against a transcript a live process still owns double-writes and corrupts it. Safe here ' +
    'only because the old writer is removed and OBSERVED dead first. Refuses a mid-turn session unless ' +
    '`force`. WRITE — destructive to the running process (the transcript is preserved).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      sessionId: { type: 'string', description: 'Session id from windows_terminal_list.' },
      force: { type: 'boolean', description: 'Restart even if mid-turn, losing the in-flight turn (default false).' },
    },
    required: ['sessionId'],
  },
};

export const windowsTerminalSendToolDef = {
  name: 'windows_terminal_send',
  description:
    'Type text and/or press SPECIAL KEYS in a Windows Claude Code session — the Windows counterpart of ' +
    'terminal_send. Order per call: `text` is pasted, then `keys` are pressed, then `submit` presses ' +
    'Enter. `keys` (e.g. ["Escape"] to dismiss a dialog, ["Down","Down","Enter"] to pick a menu item) ' +
    'go through the focus-free console-input path, so they drive a background window without stealing ' +
    'foreground — this is the only way to reach a menu/dialog here (before, only text+Enter was possible). ' +
    'Allowed keys: Enter, Escape, Up, Down, Left, Right, Tab, Space (Ctrl-C is windows_terminal_state\'s ' +
    'interrupt sibling, not here). Pass `sessionId` from windows_terminal_list. Either text or keys is ' +
    'required. WRITE — drives the session.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      sessionId: { type: 'string', description: 'Session id from windows_terminal_list.' },
      text: { type: 'string', description: 'Text to type (optional if keys given).' },
      keys: { type: 'array', items: { type: 'string' }, description: 'Named keys pressed after text: Enter, Escape, Up, Down, Left, Right, Tab, Space.' },
      submit: { type: 'boolean', description: 'Press Enter after text+keys (default false).' },
    },
    required: ['sessionId'],
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

export const terminalSendToolDef = {
  name: 'terminal_send',
  description:
    'Press SPECIAL KEYS and/or type text in a tmux session on a LINUX host — the tmux counterpart of ' +
    'windows_terminal_send, and the only tool here that can press Escape/arrows/Tab (terminal_prompt ' +
    'only types text + Enter, so menus and dialogs were undriveable). Order per call: `text` is typed ' +
    'literally (multiline lands as ONE bracketed paste, not line-by-line submits), then `keys` are ' +
    'pressed (named keys: Enter, Escape, Tab, BTab, Space, BSpace, Delete, Insert, Up/Down/Left/Right, ' +
    'Home, End, PageUp, PageDown, F1-F12, M-Enter, C-a…C-z minus C-c/C-d/C-z — Ctrl-C is ' +
    'terminal_interrupt\'s job), then `enter` presses Enter last. WRITE — drives a live session.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'tmux session name from terminal_list.' },
      text: { type: 'string', description: 'Literal text to type (newlines do not submit).' },
      keys: { type: 'array', items: { type: 'string' }, description: 'Named keys pressed after text, e.g. ["Escape"] or ["Up","Up","Enter"].' },
      enter: { type: 'boolean', description: 'Press Enter last (default false).' },
    },
    required: ['name'],
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

export const renameConversationToolDef = {
  name: 'rename_conversation',
  description:
    'Rename a claude.ai WEB conversation — set the chat title shown in the sidebar. WRITE, reversible.\n' +
    'Pass `conversation_uuid` whenever you know it. If you OMIT it the tool targets the ' +
    'most-recently-updated conversation on the account, which is a RECENCY GUESS, not your ' +
    'verified identity: the MCP connector does not tell a tool which claude.ai conversation ' +
    'called it. That guess is usually right for "rename this chat" (your own turn just made ' +
    'this conversation the most recent) but it is WRONG if another chat was touched more ' +
    'recently. The result always reports `resolution` (explicit|recency-guess), the ' +
    '`previousName` it replaced, and the uuid it hit — check them, and rename back with the ' +
    'reported `previousName` if it targeted the wrong chat.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'The new chat title. Non-empty, <= 200 chars; whitespace is collapsed to one line.' },
      conversation_uuid: { type: 'string', description: 'Conversation uuid to rename. Omit ONLY to accept the recency guess described above.' },
    },
    required: ['title'],
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
    'List the live Claude Code sessions on this host (from the ~/.claude/sessions registry), each with an ownership verdict (connectStrategy: attach-existing | create-tmux | refuse | none, plus safeToCreateTmux). Returns a SUMMARY projection by default; pass detail:"full" for every field. Read-only. {detail?:"summary"|"full", limit?, offset?}.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      detail: { type: 'string' as const, enum: ['summary', 'full'], description: 'summary (default) | full' },
      limit: { type: 'number' as const, description: 'page size (default 100 summary / 20 full)' },
      offset: { type: 'number' as const, description: 'page offset (default 0)' },
    },
  },
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
export const ccrLocalBridgesToolDef = {
  name: 'ccr_local_bridges',
  description:
    'DIAGNOSTIC — NODE-LOCAL: the local CCR bridge list for ONE node (NOT account-wide, NOT "what sessions exist"). Inspects the local bridge REGISTRY — bookkeeping rows for bridges lm-assist ' +
    'itself spawned via ccr_load/ccr_mirror/ccr_connect. To LIST CCR sessions use ccr_live_list (the ' +
    'account-wide source of truth); to answer "what sessions are running" use cc_sessions (this host) or ' +
    'session_footprints (cross-fleet). This registry exists so ccr_drive/ccr_restart/ccr_remote_stop can ' +
    'find and manage their bridge processes — it cannot see natively /remote-control\'d sessions and its ' +
    'rows go stale. Each entry is cross-checked against live session/tmux state: `alive` = the SESSION is ' +
    'live, `bridgeAlive` = the relay helper process is up (a live session with a dead bridge just needs ' +
    'reconnecting), and `unverified` marks an entry nothing could be checked against — never read it as ' +
    'proof the session is gone. The result also reports which node/cluster it searched; an empty list ' +
    'means empty ON THAT NODE only. (Formerly ccr_remote_list / ccr_bridge_registry.)',
  inputSchema: { type: 'object' as const, properties: {} },
};
export const ccrLiveListToolDef = {
  name: 'ccr_live_list',
  description:
    'THE tool for LISTING CCR sessions — the SOURCE OF TRUTH for what remote-control / cloud Claude Code ' +
    'sessions exist right now, read from the ACCOUNT (claude.ai `GET /v1/sessions`), not from any local ' +
    'registry. Use this to answer "list ccr" / "what is connected to claude.ai/code". Contrast with ' +
    'ccr_bridge_registry (a diagnostic), which lists only the bridges lm-assist itself spawned ON ONE ' +
    'NODE and therefore CANNOT see a session connected by a native ' +
    '`/remote-control` inject; this tool can, and is account-wide rather than node-scoped. ' +
    'Each row carries `kind` (local-remote-control = a Claude Code process on a real machine, driven ' +
    'from the web | cloud = a container Anthropic runs) and `via` (native-inject | lm-assist-bridge). ' +
    '`live` combines BOTH liveness axes — an archived session often still reports connection_status ' +
    'connected, so never read `connection` alone as proof it is running. Defaults to live sessions only; ' +
    'pass include_archived to see finished ones. NOTE: upstream leaves `cwd` empty on every row, so the ' +
    'location is reported as repo/branch instead. The result is an OBJECT reporting returned/matched/' +
    'scanned and a `note` whenever the answer is partial — a short list is not proof there is no more.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      kind: {
        type: 'string',
        enum: ['any', 'local-remote-control', 'cloud'],
        description: 'Restrict to one class. Default any.',
      },
      include_archived: {
        type: 'boolean',
        description: 'Include finished/archived sessions. Default false (live only).',
      },
      limit: { type: 'number', description: 'Max rows returned. Default 25, ceiling 40 (a ceiling set by measured result size, not taste).' },
      pages: {
        type: 'number',
        description: 'Upstream pages (100 rows each) to scan, newest first. Default 1, ceiling 5. Raise only when hunting an older session.',
      },
    },
  },
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
  description: 'Stop a running CCR remote by id (from ccr_local_bridges or a ccr_* result).',
  inputSchema: {
    type: 'object' as const,
    properties: { id: { type: 'string', description: 'CCR remote id, e.g. ccr-xxxxxxxx.' } },
    required: ['id'],
  },
};
export const ccrRestartToolDef = {
  name: 'ccr_restart',
  description:
    'RESTART a LOCAL Claude Code session\'s process so it re-fetches its MCP tool list (Claude Code loads MCP tools at process start ONLY — no in-place reload exists; run refresh_connector_tools/sync-connector FIRST so the refreshed list is what the new process fetches). Corruption-safe by construction: stops existing CCR bridges for the session → KILLS the live owner (SIGTERM→verify→SIGKILL→verify) → an independent re-check must confirm NOTHING still owns the session → only then spawns the fresh `claude --resume`. RETURNS THE SCREEN: every result carries `screen` — the session\'s visible tmux pane, read until it stops changing (`screenStable`) — plus `tmuxSession`, so you can SEE what the session is showing and act on it with terminal_send/terminal_capture. READ IT: "restarted" means a fresh process spawned, NOT that it is usable — a resume RE-OPENS modals (resume-from-summary; on a just-upgraded CLI, that version\'s first-run prompts), so expect a chain of dialogs and drive them ONE key per call, re-capturing between (a combined Down+Enter has mis-landed and silently flipped a live session\'s permission mode). A session idle at its prompt restarts immediately. A session that reads actively-BUSY is REFUSED IMMEDIATELY (CONFLICT, busy:true) with its screen attached and nothing killed — because a session FROZEN ON A MODAL reads identical to one mid-turn, and only the pane tells them apart: if `screen` shows a blocking dialog and screenStable is true, there is no work to lose, so answer it with terminal_send or call again with force:true. Pass wait_ms>0 to opt into WAITING for genuine in-flight work instead (restart proceeds the moment the turn ends). A kill that does not verify dead ABORTS (CONFLICT kill-failed, screen attached) — it never resumes over a live process. Same session id, same history, fresh process + fresh tools.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: { type: 'string', description: 'Claude Code session UUID to restart.' },
      force: { type: 'boolean', description: 'Kill IMMEDIATELY even if it reads as actively mid-turn. Default false. Safe on a session frozen on a modal — confirm from `screen`/screenStable that the pane is not changing.' },
      wait_ms: { type: 'number', description: 'Opt in to WAITING for an in-flight turn: when the session reads actively-busy, wait up to this long (ms) for its current work to finish, then restart. Default 0 = do not wait — refuse immediately and return the screen so you can judge whether it is really working. Cap 600000. A session idle at its prompt restarts right away regardless.' },
    },
    required: ['session_id'],
  },
};
export const ccrCloudRestartToolDef = {
  name: 'ccr_cloud_restart',
  description:
    'RESTART a CLOUD CCR session so it boots with the CURRENT MCP tool list (cloud sessions fetch tools at container boot; no in-place reload). STOPS (kills) the old session FIRST, then starts a NEW session seeded the same way — repo/branch/model/title recovered from the old session (pass repo/branch/model/title to override; repo is REQUIRED if unrecoverable). ⚠️ Returns a NEW session id; the fresh container CLONES the repo — UNCOMMITTED work in the old container is LOST (committed+pushed is safe) and conversation history is not carried over. Only for kind:cloud sessions — a bridge (remote) session\'s process is local: use ccr_restart with its Claude session id instead. Run refresh_connector_tools/sync-connector first so the new boot fetches the refreshed list.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      sid: { type: 'string', description: 'Cloud session id (session_… or cse_…).' },
      prompt: { type: 'string', description: 'Optional first user turn for the new session.' },
      repo: { type: 'string', description: 'Override/provide the GitHub repo seed (owner/name). Required if the old session\'s repo cannot be recovered.' },
      branch: { type: 'string', description: 'Override the branch.' },
      model: { type: 'string', description: 'Override the model.' },
      title: { type: 'string', description: 'Override the title.' },
    },
    required: ['sid'],
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
    'account-marketplace plugins use `claudeai_list_marketplace_plugins` instead. Returns a ' +
    'SUMMARY projection by default (capability arrays collapsed to a "provides" count map); ' +
    'pass detail:"full" for whole entries — ~12KB EACH, so page it. Read-only. ' +
    '{enabled_only?, detail?:"summary"|"full", limit?, offset?}.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      enabled_only: { type: 'boolean', description: 'Return only enabled plugins (default false).' },
      detail: { type: 'string', enum: ['summary', 'full'], description: 'summary (default) | full' },
      limit: { type: 'number', description: 'page size (default 50 summary / 10 full)' },
      offset: { type: 'number', description: 'page offset (default 0)' },
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
      limit: { type: 'number', description: 'Max records to return. DEFAULT 60 — the full map is 1,300+ records / ~800KB and grows forever. Narrow with q/projects/nodes/since instead of raising this; 0 = all (subject to the per-result byte ceiling).' },
      offset: { type: 'number', description: 'Page offset (default 0). The response reports total/shown/hasMore and, when more remain, the exact next call.' },
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
    'and always (load-always rules only). Pass stats=true for count summary. ' +
    'Records carry os/osDependent/active and source (live vs repo:<host>); filter with ' +
    'scope, paths, always, os, os_dependent, active. Read-only.',
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
      limit: { type: 'number', description: 'Max records to return. DEFAULT 60; 0 = all (subject to the per-result byte ceiling).' },
      offset: { type: 'number', description: 'Page offset (default 0). The response reports total/shown/hasMore and, when more remain, the exact next call.' },
      stats: { type: 'boolean', description: 'Return count/stats summary only instead of records.' },
      os: { type: 'string', description: 'Filter to rules matching this OS slug (e.g. windows, linux, macos).' },
      os_dependent: { type: 'boolean', description: 'If true, only return rules that declare an os constraint.' },
      active: { type: 'boolean', description: 'If true, only return rules active on the current OS.' },
    },
  },
};

export const ruleRecordToolDef = {
  name: 'rule_record',
  description:
    'Fetch one complete RULE record by its recordId (from rule_map output) — the full rule text ' +
    'plus its scope, os/active, and load condition. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: { recordId: { type: 'string', description: 'The record id from a prior rule_map result.' } },
    required: ['recordId'],
  },
};

export const ruleSyncStatusToolDef = {
  name: 'rule_sync_status',
  description:
    "Show this node's cross-node RULE-sync state: whether rule auto-sync is enabled, the node mode " +
    '(persistent vs ephemeral), and the live rule-autosync daemon status (mode + counts of ' +
    'reconciles/applied/removed/errors). Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const ruleCrossHostToolDef = {
  name: 'rule_cross_host',
  description:
    'Search user + project rules across ALL hosts (this node\'s own rules plus every synced/mirrored peer rule), ' +
    'ranked by query, each tagged with `active` (applies to this OS) and `presentLocally` (this host ' +
    'authors an equivalent rule). Use for "what rule does any of my machines have about X". Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: { query: { type: 'string', description: 'Relevance query over rule title+brief+complete+paths.' } },
    required: ['query'],
  },
};

export const ruleImportCandidatesToolDef = {
  name: 'rule_import_candidates',
  description:
    'List user + project rules from OTHER hosts (synced or inert mirror copies) that this host does not itself author — ' +
    'a preview of what auto-sync brings in (it usually already applied them). Optionally ranked by a ' +
    'query. Read-only (suggests; does not import).',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: { query: { type: 'string', description: 'Optional relevance query to rank candidates.' } },
  },
};

export const ruleProjectsToolDef = {
  name: 'rule_projects',
  description:
    'Summarize where rules live across the fleet — counts by host (node), scope (user/project), ' +
    'load condition, and category. The rules analog of memory_projects. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
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

export const memoryFileToolDef = {
  name: 'memory_file',
  description:
    'Read one memory file raw (body + hash). The hash is the expected_hash for memory_write ' +
    'update — read before you write. Needs `project_id` from memory_projects and a `filename` ' +
    '(from memory_map, or MEMORY.md itself). `source` defaults to "live" (this host\'s working ' +
    'copy); pass a repo mirror source (e.g. "repo:<host-id>", from memory_cross_host) to read ' +
    "another host's copy read-only. Read-only.",
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      project_id: { type: 'string', description: 'Project slug from memory_projects.' },
      filename: { type: 'string', description: 'Memory file name, e.g. "MEMORY.md" or "some-topic.md".' },
      source: { type: 'string', description: 'Defaults to "live". Or a mirror source like "repo:<host-id>" (read-only).' },
    },
    required: ['project_id', 'filename'],
  },
};

export const memoryWriteToolDef = {
  name: 'memory_write',
  description:
    'Create, update, or delete a memory file — the write half of the discipline: list ' +
    '(memory_map) -> read (memory_file) -> write with `expected_hash`. `action` is "create" ' +
    '(needs `content`, optional `index_line` to append a MEMORY.md index bullet), "update" ' +
    '(needs `content`, and `expected_hash` from a prior memory_file read — STRONGLY recommended, ' +
    'omitting it overwrites blind), or "delete" (optional `expected_hash`; `remove_index_line` ' +
    'defaults true and strips any matching MEMORY.md index bullet). Always targets the LIVE copy ' +
    "on the node the call runs on — pass `node` (per existing hub routing) to edit THAT node's " +
    'memory, not this one\'s. Server-side validation applies automatically (bad filenames, ' +
    'protected files like _cross-project.md/_hosts.md are refused, hash-guarded writes). On a ' +
    'HASH_MISMATCH error, the file changed on disk since your last read — call memory_file again ' +
    'to get the current hash and retry. Non-goal: rules stay read-only over MCP (no rule_write). WRITE.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'delete'], description: 'Which operation to perform.' },
      project_id: { type: 'string', description: 'Project slug from memory_projects.' },
      filename: { type: 'string', description: 'Memory file name, e.g. "some-topic.md".' },
      content: { type: 'string', description: 'Full file content. Required for create/update.' },
      expected_hash: { type: 'string', description: 'Hash from a prior memory_file read. Recommended for update/delete — omitting overwrites/deletes blind.' },
      index_line: { type: 'string', description: 'create only: a MEMORY.md index bullet to append (optional).' },
      remove_index_line: { type: 'boolean', description: 'delete only: strip matching MEMORY.md index bullet(s). Defaults true.' },
    },
    required: ['action', 'project_id', 'filename'],
  },
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
  memoryFileToolDef,
  terminalListToolDef,
  terminalCaptureToolDef,
  windowsTerminalListToolDef,
  windowsTerminalCaptureToolDef,
  windowsTerminalStateToolDef,
  windowsTerminalLaunchToolDef,
  windowsTerminalCreateToolDef,
  windowsTerminalSendToolDef,
  windowsTerminalRestartToolDef,
  windowsTerminalAutoHandleToolDef,
  windowsTerminalCloseToolDef,
  claudeaiListMarketplacesToolDef,
  claudeaiListMarketplacePluginsToolDef,
  claudeaiListPluginsToolDef,
  // memory map + rules map (read — shell out to CLIs)
  memoryMapToolDef,
  memoryRecordToolDef,
  ruleMapToolDef,
  ruleRecordToolDef,
  ruleSyncStatusToolDef,
  ruleCrossHostToolDef,
  ruleImportCandidatesToolDef,
  ruleProjectsToolDef,
  // write
  memoryWriteToolDef,
  claudeaiCreateConversationToolDef,
  claudeaiCompletionToolDef,
  claudeaiAddMarketplaceToolDef,
  claudeaiRemoveMarketplaceToolDef,
  claudeaiSetPluginEnabledToolDef,
  renameConversationToolDef,
  ...RENAME_SESSION_TOOL_DEFS,
  ...CONVERSATION_OPS_TOOL_DEFS,
  agentAbortToolDef,
  agentResumeToolDef,
  terminalPromptToolDef,
  terminalSlashToolDef,
  terminalSendToolDef,
  // admin
  agentExecuteToolDef,
  terminalInterruptToolDef,
  terminalOpenTabToolDef,
  deleteConversationToolDef,
  // github (read: github_query, write: github_mutate)
  ...GITHUB_TOOL_DEFS,
  // elevated worker (Windows-only: status read; exec/grant/revoke admin)
  ...ELEVATED_TOOL_DEFS,
  // vm management (Hyper-V / KVM: status+list read; create/start/stop/snapshot write; delete admin)
  ...VM_TOOL_DEFS,
  // container management (Docker: status+logs read; run/power write; delete admin)
  ...CONTAINER_TOOL_DEFS,
  // ccr — Claude Code remote support
  ccSessionsToolDef,
  ccrPreflightToolDef,
  ccrLocalBridgesToolDef,
  ccrLiveListToolDef,
  ccrLoadToolDef,
  ccrMirrorToolDef,
  ccrConnectToolDef,
  ccrDriveToolDef,
  ccrRemoteStopToolDef,
  ccrRestartToolDef,
  ccrCloudRestartToolDef,
  ccrCloudStartToolDef,
  ccrCloudReposToolDef,
  ccrCloudDriveToolDef,
  ccrCloudAnswerToolDef,
  ccrCloudReadToolDef,
  ccrCloudStopToolDef,
  ccrCloudListToolDef,
  // port forward (node-to-node TCP tunnel)
  ...PORT_FORWARD_TOOL_DEFS,
  // whatsapp cloud-api connector (send: write; chats/messages/search/status: read)
  ...WHATSAPP_TOOL_DEFS,
  ...LINKEDIN_TOOL_DEFS,
  ...GMAIL_TOOL_DEFS,
  ...DESKTOP_TOOL_DEFS,
  ...BACKUP_TOOL_DEFS,
  ...TRANSFER_TOOL_DEFS,
  ...FS_INSPECT_TOOL_DEFS,
  // pluggable-UI pages (status/list/grants: read; register/control/release/unregister: write)
  ...UI_PAGES_TOOL_DEFS,
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
  // mission graph-query — mission_query / mission_neighbors / mission_graph
  ...MISSION_QUERY_TOOL_DEFS,
  // mission scheduling intelligence — mission_schedule / mission_changes
  ...MISSION_SCHEDULE_TOOL_DEFS,
  // mission workflow registry — mission_workflow_list/get/set/history/rollback
  ...MISSION_WORKFLOW_TOOL_DEFS,
  // backlog / feature-idea graph — backlog_list/get/create/update/link/unlink/review/discuss/remove/graph
  ...BACKLOG_TOOL_DEFS,
  // auth: guided re-login for cookie + OAuth
  ...CLAUDEAI_LOGIN_TOOL_DEFS,
  // fleet build/upgrade tracking — per-node build version (read, pull)
  ...NODE_BUILDS_TOOL_DEFS,
  // fleet upgrade — trigger a per-node upgrade to a specified prebuilt source (admin)
  ...NODE_UPGRADE_TOOL_DEFS,
  // cluster management (list:read, assign/unassign/describe:write)
  ...CLUSTER_TOOL_DEFS,
  // machine access profiles — how to reach other machines FROM this node (read)
  ...MACHINE_ACCESS_TOOL_DEFS,
  ...NODE_PROFILE_TOOL_DEFS,
  // general per-node status — every subsystem in one call (read)
  ...NODE_STATUS_TOOL_DEFS,
  // on-demand measured fabric throughput + RTT to a peer (read, T5)
  ...FABRIC_PROBE_TOOL_DEFS,
  // durable cross-node bus — publish / long-poll read / topics (spec §5 S1)
  ...BUS_TOOL_DEFS,
  // fleet session footprints (read — cross-fleet survey)
  sessionFootprintsToolDef,
  // node lifecycle (admin — graceful exit/restart, no force-kill)
  nodeLifecycleToolDef,
  // cowork task creation (create + send a Claude Cowork session — cloud or local)
  coworkCreateTaskDef,
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
    // Per-resource project/repo provenance from the execution's cwd (additive).
    if (typeof merged.cwd === 'string' && merged.cwd) {
      const rid = repoOfCached(merged.cwd);
      if (rid) merged = { ...merged, project: rid.project, ...(rid.repo ? { repo: rid.repo } : {}) };
    }
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

/**
 * How long a single memory-file read may take before it is called a timeout.
 *
 * Deliberately left at workerGet's default: measurement, not guesswork. A
 * 200KB body round-trips through this path in milliseconds and the real
 * MEMORY.md (~20KB) in single-digit ms, so 15s is orders of magnitude of
 * headroom. Raising it would only make a wedged Core take longer to say so.
 */
const MEMORY_FILE_TIMEOUT_MS = 15000;

/**
 * Name the failure class of a read that never produced an envelope.
 *
 * Mirrors the backlog write-path fix's ORIGIN_TIMEOUT vs ORIGIN_UNREACHABLE:
 * "it failed" is not actionable, and a caller that cannot tell a wedged Core
 * from a dead one — or from a bad argument — retries the same doomed call.
 * Each branch says what it means AND whether retrying is what helps.
 */
export function classifyMemoryReadFailure(e: unknown, route: string): string {
  const name = (e as { name?: string } | null)?.name;
  const msg = e instanceof Error ? e.message : String(e);
  if (name === 'TimeoutError' || name === 'AbortError' || /timed? ?out|aborted/i.test(msg)) {
    return `[READ_TIMEOUT] ${route} did not answer within ${MEMORY_FILE_TIMEOUT_MS}ms. Core is reachable but slow or wedged — the read MAY have been served and lost, so a retry is safe (this is a read). A different project_id will not help.`;
  }
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH|ECONNRESET|socket hang up|network/i.test(msg)) {
    return `[CORE_UNREACHABLE] could not reach lm-assist Core on loopback (${msg}). NOTHING was read. Start Core (\`lm-assist start\`) and retry — a different project_id will not help.`;
  }
  return `[MEMORY_FILE_ERROR] ${msg}`;
}

async function handleMemoryFile(args: Record<string, unknown>): Promise<McpToolResult> {
  const pid = String(args.project_id || '').trim();
  const filename = String(args.filename || '').trim();
  if (!pid || !filename) return err('project_id and filename are required.');
  const source = String(args.source || 'live').trim() || 'live';
  const route = `/memory/by-project/${enc(pid)}/file/${enc(filename)}?source=${enc(source)}`;
  try {
    // Raw envelope: the API's error.code (PROJECT_NOT_FOUND, PROJECT_AMBIGUOUS,
    // FILE_NOT_FOUND, SOURCE_NOT_FOUND) is the actionable part, and workerGet
    // would discard it — which is exactly how a 0ms bad-id refusal reached the
    // caller as a bare "MCP tool call failed" and got read as a transport fault.
    const body = await workerGetRaw(route, MEMORY_FILE_TIMEOUT_MS);
    if (body && body.success === false) {
      const e = (body.error || {}) as { code?: string; message?: string };
      return err(`[${e.code || 'MEMORY_FILE_ERROR'}] ${e.message || 'memory_file failed.'}`);
    }
    return ok(pretty(body?.data ?? body));
  } catch (e) {
    return err(classifyMemoryReadFailure(e, route));
  }
}

const MEMORY_WRITE_ACTIONS = ['create', 'update', 'delete'] as const;
type MemoryWriteAction = (typeof MEMORY_WRITE_ACTIONS)[number];

/**
 * Connector clients (claude.ai, other MCP hosts) deliver MCP tool args as
 * STRINGS even for boolean-typed schema fields — normalize before use.
 * Recognizes bool | "true"/"false" | "1"/"0" (case/whitespace-insensitive).
 * Anything else (including undefined) falls through to `def`.
 */
function coerceBool(v: unknown, def: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return def;
}

/**
 * Pure request-mapping for memory_write: {action, args} -> the {method, path,
 * body} to send to the existing /memory/by-project/:id/file... routes (or a
 * validation `error` string). No I/O — factored out so the action/query/body
 * construction (incl. string-coerced booleans and URI encoding) is unit
 * testable without stubbing fetch. Mirrors the web editor's own contract
 * exactly: PUT (update) / POST (create) / DELETE (delete).
 */
export function buildMemoryWriteRequest(
  args: Record<string, unknown>,
): { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; body?: Record<string, unknown> } | { error: string } {
  const action = String(args.action || '').trim() as MemoryWriteAction | '';
  if (!(MEMORY_WRITE_ACTIONS as readonly string[]).includes(action)) {
    return { error: `memory_write action must be one of: ${MEMORY_WRITE_ACTIONS.join(', ')}` };
  }
  const projectId = String(args.project_id || '').trim();
  const filename = String(args.filename || '').trim();
  if (!projectId || !filename) return { error: 'project_id and filename are required.' };
  const base = `/memory/by-project/${enc(projectId)}/file`;
  const expectedHash = typeof args.expected_hash === 'string' && args.expected_hash.trim() ? args.expected_hash.trim() : undefined;

  if (action === 'create') {
    const content = args.content;
    if (typeof content !== 'string') return { error: 'content is required for action="create".' };
    const body: Record<string, unknown> = { filename, content };
    const indexLine = args.index_line;
    if (typeof indexLine === 'string' && indexLine.trim()) body.indexLine = indexLine;
    return { method: 'POST', path: base, body };
  }

  if (action === 'update') {
    const content = args.content;
    if (typeof content !== 'string') return { error: 'content is required for action="update".' };
    const body: Record<string, unknown> = { content };
    if (expectedHash) body.expectedHash = expectedHash;
    return { method: 'PUT', path: `${base}/${enc(filename)}`, body };
  }

  // action === 'delete'
  const removeIndexLine = coerceBool(args.remove_index_line, true);
  const qs = new URLSearchParams();
  qs.set('removeIndexLine', removeIndexLine ? 'true' : 'false');
  if (expectedHash) qs.set('expectedHash', expectedHash);
  return { method: 'DELETE', path: `${base}/${enc(filename)}?${qs.toString()}` };
}

/** HASH_MISMATCH is server-validated on update/delete — turn it into an actionable retry hint. */
function memoryWriteErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith('HASH_MISMATCH')) {
    return `${msg} — file changed on disk since your last read. Call memory_file to get the current hash and retry.`;
  }
  return msg;
}

async function handleMemoryWrite(args: Record<string, unknown>): Promise<McpToolResult> {
  const req = buildMemoryWriteRequest(args);
  if ('error' in req) return err(req.error);
  try {
    let data: unknown;
    if (req.method === 'POST') data = await workerPost(req.path, req.body!);
    else if (req.method === 'PUT') data = await workerPut(req.path, req.body!);
    else data = await workerDelete(req.path);
    const warnings = (data as { warnings?: unknown } | null)?.warnings;
    const hint = Array.isArray(warnings) && warnings.length > 0 ? `\n\nNote: ${warnings.join('; ')}` : '';
    return ok(pretty(data) + hint);
  } catch (e) {
    return err(memoryWriteErrorText(e));
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
  const text = typeof a.text === 'string' && a.text.length > 0 ? a.text : null;
  const keys = Array.isArray(a.keys) ? (a.keys as unknown[]).map((k) => String(k)) : null;
  if (!sid) return err('sessionId is required.');
  if (text === null && !(keys && keys.length > 0)) {
    return err('nothing to send: pass text, keys (e.g. ["Escape"]), or both.');
  }
  const body: Record<string, unknown> = { submit: a.submit === true };
  if (text !== null) body.text = text;
  if (keys && keys.length > 0) body.keys = keys;
  try {
    return renderRaw(await workerPostRaw(`/terminal/cc-sessions/${enc(sid)}/prompt`, body));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
async function handleWindowsTerminalRestart(a: Record<string, unknown>): Promise<McpToolResult> {
  const sid = winSid(a);
  if (!sid) return err('sessionId is required.');
  try {
    return renderRaw(await workerPostRaw(`/terminal/cc-sessions/${enc(sid)}/restart`, { force: a.force === true }));
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

async function handleTerminalSend(args: Record<string, unknown>): Promise<McpToolResult> {
  const name = String(args.name || '').trim();
  if (!name) return err('name is required.');
  const text = typeof args.text === 'string' && args.text.length > 0 ? args.text : null;
  const keys = Array.isArray(args.keys) ? (args.keys as unknown[]).map((k) => String(k)) : null;
  const enter = args.enter === true;
  if (text === null && !(keys && keys.length > 0) && !enter) {
    return err('nothing to send: pass text, keys (e.g. ["Escape"]), or enter:true.');
  }
  const body: Record<string, unknown> = {};
  if (text !== null) body.text = text;
  if (keys && keys.length > 0) body.keys = keys;
  if (enter) body.enter = true;
  try {
    return ok(pretty(await workerPost(`/terminal/tmux/${enc(name)}/send-keys`, body)));
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

/**
 * rename_conversation — set a claude.ai conversation's chat title.
 *
 * The uuid is the honest part of this tool. An MCP call carries no claude.ai
 * conversation id (the connector only tags `claudecode/toolUseId`, which
 * matches LOCAL Claude Code sessions), so "the current conversation" cannot be
 * resolved — only guessed from recency. We therefore act on the guess but
 * always label it and return the previous name, rather than presenting a guess
 * as a verified target.
 */
async function handleRenameConversation(args: Record<string, unknown>): Promise<McpToolResult> {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) return err('title is required — the new chat title.');

  let uuid = String(args.conversation_uuid || '').trim();
  let resolution = 'explicit';
  if (!uuid) {
    try {
      const candidates = await resolveCallerCandidates();
      if (!candidates.claudeAi?.id) {
        return err(
          'No conversation_uuid given and no claude.ai conversation could be resolved on this node. ' +
          'Pass conversation_uuid explicitly (list_claudeai_conversations shows the uuids).',
        );
      }
      uuid = candidates.claudeAi.id;
      resolution = 'recency-guess';
    } catch (e) {
      return err(`Could not resolve a conversation to rename: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  try {
    const data = await workerPut(`/claude-ai/conversations/${enc(uuid)}`, { name: title });
    const out: Record<string, unknown> = (data && typeof data === 'object')
      ? { ...(data as Record<string, unknown>) }
      : { result: data };
    out.resolution = resolution;
    if (resolution === 'recency-guess') {
      out.warning =
        'Target was NOT verified — it is the most-recently-updated conversation on this account, ' +
        'not a confirmed "you are here". If this is the wrong chat, rename it back to previousName.';
    }
    return ok(pretty(out));
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
// SUMMARY by default (measured 52,379 bytes before this change). The fat fields are the
// absolute `jsonl` path, `owner.entrypoint` and `verdict.reason` (a prose sentence) —
// none of which a "what is running" answer needs. detail:'full' restores every field.
async function handleCcSessions(args: Record<string, unknown> = {}): Promise<McpToolResult> {
  try {
    const res = await workerGet('/terminal/cc-sessions') as Record<string, unknown>;
    const all = Array.isArray(res?.sessions) ? res.sessions as Array<Record<string, unknown>> : [];
    const detail = detailLevel(args.detail);
    const limit = intArg(args.limit, detail === 'full' ? 20 : 100);
    const { rows, meta } = paginate(all, limit, intArg(args.offset, 0));
    return ok(pretty({
      backend: res?.backend,
      liveCount: res?.liveCount,
      detail,
      ...meta,
      ...(detail === 'summary'
        ? { hint: 'SUMMARY projection (default) — jsonl path, entrypoint and the verdict prose are omitted. Call cc_sessions({detail:"full"}) for every field.' }
        : {}),
      sessions: detail === 'full' ? rows : rows.map(ccSessionSummary),
    }));
  } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
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
async function handleCcrLiveList(args: Record<string, unknown>): Promise<McpToolResult> {
  const q = new URLSearchParams();
  if (typeof args.kind === 'string' && args.kind) q.set('kind', args.kind);
  if (args.include_archived === true) q.set('include_archived', '1');
  if (args.limit !== undefined) q.set('limit', String(args.limit));
  if (args.pages !== undefined) q.set('pages', String(args.pages));
  const qs = q.toString();
  try { return ok(pretty(await workerGet(`/ccr/live${qs ? `?${qs}` : ''}`))); }
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
async function handleCcrRestart(args: Record<string, unknown>): Promise<McpToolResult> {
  const sid = String(args.session_id || '').trim();
  if (!sid) return err('session_id is required.');
  const body: Record<string, unknown> = { sessionId: sid };
  // Connector bool/number args can arrive as strings — coerce.
  if (args.force === true || args.force === 'true') body.force = true;
  const w = Number(args.wait_ms);
  if (Number.isFinite(w)) body.waitMs = w;
  try {
    const raw = await workerPostRaw('/ccr/restart', body);
    // A REFUSAL is the case that most needs the screen (a frozen modal reads as
    // actively busy), and the generic renderRaw drops `error.details` — keep the
    // restart payload verbatim so `screen` actually reaches the caller.
    if (raw && raw.success === false) {
      const e = raw.error as { message?: string; code?: string; details?: { restart?: unknown } } | undefined;
      const restart = e?.details?.restart;
      if (restart) return err(`${e?.message || e?.code || 'restart refused'}\n\n${pretty(restart as Record<string, unknown>)}`);
    }
    return renderRaw(raw);
  }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}
async function handleCcrCloudRestart(args: Record<string, unknown>): Promise<McpToolResult> {
  const sid = String(args.sid || '').trim();
  if (!sid) return err('sid is required.');
  const body: Record<string, unknown> = {};
  if (args.prompt) body.prompt = String(args.prompt);
  if (args.repo) body.repo = String(args.repo);
  if (args.branch) body.branch = String(args.branch);
  if (args.model) body.model = String(args.model);
  if (args.title) body.title = String(args.title);
  try { return renderRaw(await workerPostRaw(`/ccr/cloud/${enc(sid)}/restart`, body)); }
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
  try {
    const data: any = await workerGet('/ccr/cloud');
    const empty = !data || !Array.isArray(data.sessions) || data.sessions.length === 0;
    const hint = empty
      ? '\n\nNote: cloud CCR sessions are per-node/cluster (this reply is only THIS node\'s registry). '
        + 'If you expected sessions, they may be on another node/cluster — call list_nodes / cluster_list '
        + 'and retry ccr_cloud_list with node=<a node on that cluster>.'
      : '';
    return ok(pretty(data) + hint);
  } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
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

// SUMMARY by default. Measured 1,156,396 bytes for 92 plugins — the largest result on
// the entire MCP surface (~321k tokens, more than a whole context window from one call).
// The nested capability arrays are replaced by a `provides` count map; detail:'full'
// restores them.
async function handleClaudeaiListPlugins(args: Record<string, unknown>): Promise<McpToolResult> {
  const qs = args.enabled_only ? '?enabled_only=true' : '';
  try {
    const res = await workerGet(`/claude-ai/plugins${qs}`) as Record<string, unknown>;
    const all = Array.isArray(res?.plugins) ? res.plugins as Array<Record<string, unknown>> : [];
    const detail = detailLevel(args.detail);
    const { rows, meta } = paginate(all, intArg(args.limit, detail === 'full' ? 10 : 50), intArg(args.offset, 0));
    return ok(pretty({
      ...res,
      detail,
      ...meta,
      ...(detail === 'summary'
        ? { hint: 'SUMMARY projection (default) — per-plugin skills/commands/agents/mcp_servers bodies are replaced by the "provides" counts. Call claudeai_list_plugins({detail:"full"}) for the full entries (~12KB each, so page it).' }
        : {}),
      plugins: detail === 'full' ? rows : rows.map(claudeaiPluginSummary),
    }));
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

/**
 * Default page for the `*_map` tools. These maps grow MONOTONICALLY — records are
 * never pruned, and each host mirror re-emits the whole set — so their size is a
 * function of how long the fleet has been running, not of anything the caller did.
 */
const MAP_DEFAULT_LIMIT = 60;

/**
 * Turn a `*-map.js --meta` envelope into an honest page.
 *
 * The bound alone was not enough. `memory_map` already defaulted to 60 records, but
 * it returned a BARE ARRAY: 60 rows out of 1,313 is indistinguishable from a map
 * that only HAS 60, and a model reads the short list as the complete one and
 * concludes a memory does not exist. `total`/`hasMore` plus the exact next call are
 * what make a bounded answer safe to reason from — the same rule as the truncation
 * marker: say what was dropped and how to get it.
 */
export function mapPage(raw: string, nextCall: (offset: number) => string): string {
  let env: { total?: number; shown?: number; offset?: number; limit?: number; records?: unknown[] };
  try { env = JSON.parse(raw); } catch { return raw; }   // stats/md mode — pass through
  if (!env || !Array.isArray(env.records)) return raw;
  const total = env.total ?? env.records.length;
  const offset = env.offset ?? 0;
  const shown = env.records.length;
  const hasMore = offset + shown < total;
  return JSON.stringify({
    total, shown, offset, limit: env.limit ?? 0, hasMore,
    ...(hasMore
      ? { more: `${total - offset - shown} more record(s) not shown — next page: ${nextCall(offset + shown)}` }
      : {}),
    records: env.records,
  }, null, 2);
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
  // A DEFAULT limit, not just an optional one. memory_map measured 827,724 bytes across
  // 1,313 records (~630B each) and grows monotonically forever — every memory ever
  // written on any node. Unbounded by default it is a guaranteed future incident, so the
  // caller now opts INTO a bigger page rather than opting out of an unbounded one.
  const limit = intArg(args.limit, MAP_DEFAULT_LIMIT);
  const offset = intArg(args.offset, 0);
  argv.push('--limit', String(limit));
  if (offset) argv.push('--offset', String(offset));
  if (args.stats) argv.push('--stats');
  else argv.push('--meta');   // stats has its own shape; never wrap it
  try {
    const raw = await runCli(argv);
    if (args.stats) return ok(raw);
    return ok(mapPage(raw, (next) => `memory_map({offset:${next}, limit:${limit}})`));
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
  // Was `if (args.limit)` — an optional pass-through with NO default and no clamp, so
  // a plain call returned every rule on every node. Small today (2,392 B) only because
  // the fleet has few rules; it is the same monotonic shape as memory_map, one incident
  // behind it. Same default + honest paging.
  const limit = intArg(args.limit, MAP_DEFAULT_LIMIT);
  const offset = intArg(args.offset, 0);
  argv.push('--limit', String(limit));
  if (offset) argv.push('--offset', String(offset));
  if (args.stats) argv.push('--stats');
  else argv.push('--meta');
  if (args.os) argv.push('--os', String(args.os));
  if (args.os_dependent) argv.push('--os-dependent');
  if (args.active) argv.push('--active');
  try {
    const raw = await runCli(argv);
    if (args.stats) return ok(raw);
    return ok(mapPage(raw, (next) => `rule_map({offset:${next}, limit:${limit}})`));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleRuleRecord(args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.recordId || '').trim();
  if (!id) return err('recordId is required.');
  try { return ok(await runCli([cliPath('rule-map.js'), '--port', apiPort(), '--record', id])); }
  catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}

async function handleRuleSyncStatus(): Promise<McpToolResult> {
  try {
    return ok(pretty(await workerGet('/rules/sync/status')));
  } catch {
    try {
      const { getProjectSettings } = await import('../../project-settings');
      const { readMemorySyncConfig } = await import('../../memory/node-mode');
      return ok(pretty({
        config: { ruleSyncEnabled: getProjectSettings().ruleSyncEnabled, nodeMode: readMemorySyncConfig().nodeMode },
        daemon: null,
        note: 'Core unreachable — on-disk setting only',
      }));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
}

/** Run rule-map.js and JSON-parse its record array (shared by the thin cross-host views). */
async function ruleMapRecords(extra: string[]): Promise<any[]> {
  const out = await runCli([cliPath('rule-map.js'), '--port', apiPort(), '--format', 'json', '--level', 'brief', ...extra]);
  try { const j = JSON.parse(out); return Array.isArray(j) ? j : []; } catch { return []; }
}

async function handleRuleCrossHost(args: Record<string, unknown>): Promise<McpToolResult> {
  const q = String(args.query || '').trim();
  if (!q) return err('query is required.');
  try {
    const recs = await ruleMapRecords(['--q', q]);
    const localTitles = new Set(recs.filter((r) => r.source === 'live').map((r) => String(r.title || '').toLowerCase()));
    const records = recs.map((r) => ({ ...r, presentLocally: localTitles.has(String(r.title || '').toLowerCase()) }));
    return ok(pretty({ query: q, total: records.length, records }));
  } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}

async function handleRuleImportCandidates(args: Record<string, unknown>): Promise<McpToolResult> {
  const q = String(args.query || '').trim();
  try {
    const recs = await ruleMapRecords(q ? ['--q', q] : []);
    const localTitles = new Set(recs.filter((r) => r.source === 'live').map((r) => String(r.title || '').toLowerCase()));
    const candidates = recs.filter((r) => typeof r.source === 'string' && r.source.startsWith('repo:') && !localTitles.has(String(r.title || '').toLowerCase()));
    return ok(pretty({ query: q || null, total: candidates.length, candidates }));
  } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
}

async function handleRuleProjects(): Promise<McpToolResult> {
  // F5: drop redundant --format json alongside --stats (rule-map.js ignores it for stats output)
  try { return ok(await runCli([cliPath('rule-map.js'), '--port', apiPort(), '--stats'])); }
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
  stall_status: () => handleStallStatus(),
  memory_projects: () => handleMemoryProjects(),
  memory_sync_status: () => handleMemorySyncStatus(),
  memory_cross_host: handleMemoryCrossHost,
  memory_import_candidates: handleMemoryImportCandidates,
  memory_file: handleMemoryFile,
  terminal_list: () => handleTerminalList(),
  terminal_capture: handleTerminalCapture,
  windows_terminal_list: () => handleWindowsTerminalList(),
  windows_terminal_capture: handleWindowsTerminalCapture,
  windows_terminal_state: handleWindowsTerminalState,
  windows_terminal_launch: handleWindowsTerminalLaunch,
  windows_terminal_create: handleWindowsTerminalCreate,
  windows_terminal_send: handleWindowsTerminalSend,
  windows_terminal_restart: handleWindowsTerminalRestart,
  windows_terminal_auto_handle: handleWindowsTerminalAutoHandle,
  windows_terminal_close: handleWindowsTerminalClose,
  // claude.ai marketplaces + plugins (read)
  claudeai_list_marketplaces: handleClaudeaiListMarketplaces,
  claudeai_list_marketplace_plugins: handleClaudeaiListMarketplacePlugins,
  claudeai_list_plugins: handleClaudeaiListPlugins,
  // write
  memory_write: handleMemoryWrite,
  claudeai_create_conversation: handleClaudeaiCreateConversation,
  claudeai_completion: handleClaudeaiCompletion,
  claudeai_add_marketplace: handleClaudeaiAddMarketplace,
  claudeai_remove_marketplace: handleClaudeaiRemoveMarketplace,
  claudeai_set_plugin_enabled: handleClaudeaiSetPluginEnabled,
  agent_abort: handleAgentAbort,
  agent_resume: handleAgentResume,
  terminal_prompt: handleTerminalPrompt,
  terminal_slash: handleTerminalSlash,
  terminal_send: handleTerminalSend,
  // admin
  agent_execute: handleAgentExecute,
  terminal_interrupt: handleTerminalInterrupt,
  terminal_open_tab: handleTerminalOpenTab,
  rename_conversation: handleRenameConversation,
  ...RENAME_SESSION_HANDLERS,
  ...CONVERSATION_OPS_HANDLERS,
  delete_conversation: handleDeleteConversation,
  // memory map + rules map (read — shell out to CLIs)
  memory_map: handleMemoryMap,
  memory_record: handleMemoryRecord,
  rule_map: handleRuleMap,
  rule_record: handleRuleRecord,
  rule_sync_status: () => handleRuleSyncStatus(),
  rule_cross_host: handleRuleCrossHost,
  rule_import_candidates: handleRuleImportCandidates,
  rule_projects: () => handleRuleProjects(),
  // multi-node (worker-side fallback; hub answers the full list when connected)
  list_nodes: async () => handleListNodes(),
  // github (read: github_query, write: github_mutate) — dispatch to /github/<action>
  ...GITHUB_HANDLERS,
  // elevated worker (Windows-only) — each wraps an /elevated/* loopback route
  ...ELEVATED_HANDLERS,
  // vm management — each wraps a /vm/* loopback route
  ...VM_HANDLERS,
  // container management — each wraps a /container/* loopback route
  ...CONTAINER_HANDLERS,
  // ccr — Claude Code remote support
  cc_sessions: (a) => handleCcSessions(a),
  ccr_preflight: handleCcrPreflight,
  ccr_local_bridges: () => handleCcrRemoteList(),
  ccr_bridge_registry: () => handleCcrRemoteList(), // compat alias (pre-rename)
  // compat alias: pre-rename name, still accepted (NOT advertised) so a connector
  // holding a cached tools/list keeps working until it refreshes
  ccr_remote_list: () => handleCcrRemoteList(),
  ccr_live_list: (a: Record<string, unknown>) => handleCcrLiveList(a),
  ccr_load: handleCcrLoad,
  ccr_mirror: handleCcrMirror,
  ccr_connect: handleCcrConnect,
  ccr_drive: handleCcrDrive,
  ccr_remote_stop: handleCcrRemoteStop,
  ccr_restart: handleCcrRestart,
  ccr_cloud_restart: handleCcrCloudRestart,
  ccr_cloud_start: handleCcrCloudStart,
  ccr_cloud_repos: () => handleCcrCloudRepos(),
  ccr_cloud_drive: handleCcrCloudDrive,
  ccr_cloud_answer: handleCcrCloudAnswer,
  ccr_cloud_read: handleCcrCloudRead,
  ccr_cloud_stop: handleCcrCloudStop,
  ccr_cloud_list: () => handleCcrCloudList(),
  // port forward (open/list/close node-to-node TCP tunnel)
  ...PORT_FORWARD_HANDLERS,
  // whatsapp cloud-api connector
  ...WHATSAPP_HANDLERS,
  ...LINKEDIN_HANDLERS,
  ...GMAIL_HANDLERS,
  ...DESKTOP_HANDLERS,
  ...BACKUP_HANDLERS,
  ...TRANSFER_HANDLERS,
  ...FS_INSPECT_HANDLERS,
  // pluggable-UI pages
  ...UI_PAGES_HANDLERS,
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
  // mission graph-query
  ...MISSION_QUERY_HANDLERS,
  // mission scheduling intelligence
  ...MISSION_SCHEDULE_HANDLERS,
  // mission workflow registry
  ...MISSION_WORKFLOW_HANDLERS,
  // backlog / feature-idea graph
  ...BACKLOG_HANDLERS,
  // auth: guided re-login for cookie + OAuth
  ...CLAUDEAI_LOGIN_HANDLERS,
  // fleet build/upgrade tracking
  ...NODE_BUILDS_HANDLERS,
  // fleet upgrade — trigger a per-node upgrade to a specified prebuilt source
  ...NODE_UPGRADE_HANDLERS,
  // cluster management
  ...CLUSTER_HANDLERS,
  // machine access profiles
  ...MACHINE_ACCESS_HANDLERS,
  ...NODE_PROFILE_HANDLERS,
  // general per-node status — every subsystem in one call (read)
  ...NODE_STATUS_HANDLERS,
  // on-demand measured fabric throughput + RTT to a peer (read, T5)
  ...FABRIC_PROBE_HANDLERS,
  // durable cross-node bus — publish / long-poll read / topics (spec §5 S1)
  ...BUS_HANDLERS,
  // fleet session footprints (read — cross-fleet survey)
  session_footprints: handleSessionFootprints,
  // node lifecycle (admin — graceful exit/restart, no force-kill)
  node_lifecycle: handleNodeLifecycle,
  // cowork task creation (create + send a Claude Cowork session — cloud or local)
  cowork_create_task: handleCoworkCreateTask,
};
