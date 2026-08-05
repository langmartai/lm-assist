// Which PLAYBOOK governs which tool — the single source of truth for the tool→topic
// mapping, deliberately free of dependencies (no prose, no store, no config).
//
// Two consumers, which is why it lives here rather than inside guide.ts:
//   1. `guide.ts` folds it into ALIASES, so guide(topic="data_get") resolves a TOOL name
//      to its topic.
//   2. `result-origin.ts` folds it into the per-result trailer, so a result names the
//      playbook that governs the tool that produced it (design layer 2).
//
// Keeping the map here means the trailer cannot drift from the playbooks it points at,
// and the trailer does not drag the whole guide content module into its import graph.
export const TOPIC_TOOLS: Record<string, string[]> = {
  sessions: ['list_recent_sessions', 'list_session_messages', 'session_dag', 'list_executions', 'get_execution', 'list_projects'],
  knowledge: ['search', 'detail', 'search_memory', 'memory_projects', 'memory_map', 'memory_cross_host', 'memory_record', 'memory_file', 'memory_write', 'memory_import_candidates', 'memory_sync_status', 'rule_map', 'feedback'],
  data: ['data_catalog', 'data_request_access', 'data_get', 'data_query', 'data_search', 'data_put', 'data_delete', 'data_create_dataset', 'data_drop_dataset', 'data_keys', 'data_revoke_key', 'data_sync', 'data_sync_status', 'data_admin'],
  agents: ['agent_execute', 'agent_resume', 'agent_abort', 'get_execution', 'list_executions', 'browser_task'],
  terminals: ['terminal_open_tab', 'terminal_list', 'terminal_capture', 'terminal_prompt', 'terminal_slash', 'terminal_send', 'terminal_interrupt', 'send_session_message', 'get_message_status', 'cc_sessions', 'windows_terminal_create', 'windows_terminal_list', 'windows_terminal_send', 'windows_terminal_restart', 'windows_terminal_capture', 'windows_terminal_state', 'windows_terminal_launch', 'windows_terminal_close', 'windows_terminal_auto_handle'],
  ccr: ['ccr_preflight', 'ccr_load', 'ccr_mirror', 'ccr_connect', 'ccr_bridge_registry', 'ccr_remote_list', 'ccr_live_list', 'ccr_remote_stop', 'cc_sessions'],
  // node_profile/node_select join the NODES playbook: choosing WHERE work runs is a
  // cross-node concern, and a tool maps to exactly ONE topic.
  nodes: ['list_nodes', 'open_port_forward', 'close_port_forward', 'list_port_forwards', 'port_forward_stats', 'node_profile', 'node_select'],
  'claude-ai': ['list_claudeai_conversations', 'read_conversation', 'conversation_tokens', 'conversation_fork', 'claudeai_create_conversation', 'claudeai_completion', 'delete_conversation', 'rename_conversation', 'claudeai_list_marketplaces', 'claudeai_list_marketplace_plugins', 'claudeai_list_plugins', 'claudeai_add_marketplace', 'claudeai_remove_marketplace', 'claudeai_set_plugin_enabled', 'list_claudeai_connectors', 'refresh_connector_tools', 'set_connector_tool_access'],
  account: ['auth_status', 'claude_code_usage', 'claude_code_account', 'claudeai_account', 'claudeai_active_sessions'],
  github: ['github_query', 'github_mutate'],
  files: ['fs_drives', 'fs_list', 'fs_stat', 'fs_read', 'transfer_queue', 'transfer_send_file', 'transfer_list_remote', 'transfer_stats', 'transfer_cancel', 'transfer_status'],
  roles: ['set_role', 'report_status', 'worker_status', 'list_workers', 'decide_gate'],
  // `mission_place`/`mission_schedule` live HERE, not on mission-controller: their trap
  // (go:true / ready is NOT placement) is documented in the missions playbook, and that
  // topic — unlike mission-controller — is part of bootstrap. A tool maps to ONE topic.
  missions: ['mission_create', 'mission_list', 'mission_query', 'mission_update', 'mission_control_status', 'mission_schedule', 'mission_place', 'mission_spawn'],
  'mission-controller': ['mission_executor_status', 'mission_sessions', 'mission_session_read', 'mission_session_drive', 'mission_session_control'],
  clusters: ['cluster_list', 'cluster_assign', 'cluster_unassign', 'cluster_describe'],
  'machine-access': ['machine_access'],
  backup: ['backup_run', 'backup_status', 'backup_list', 'backup_search', 'backup_read', 'backup_remove'],
};

/** tool name → topic, built once from TOPIC_TOOLS. A tool listed under two topics
 *  (e.g. `cc_sessions` under terminals AND ccr) resolves to the LAST one declared —
 *  the more specific playbook, which is the one worth pointing a caller at. */
const TOOL_TO_TOPIC: Record<string, string> = {};
for (const [topic, tools] of Object.entries(TOPIC_TOOLS)) for (const t of tools) TOOL_TO_TOPIC[t] = topic;

/**
 * PURE — the playbook topic governing `tool`, or null when the tool has no playbook
 * (bootstrap/guide themselves, plugin `ext__*` tools, anything unmapped). Callers treat
 * null as "say nothing": an unmapped tool must never produce a broken pointer.
 */
export function playbookTopicForTool(tool: string): string | null {
  if (!tool) return null;
  return TOOL_TO_TOPIC[tool] ?? null;
}
