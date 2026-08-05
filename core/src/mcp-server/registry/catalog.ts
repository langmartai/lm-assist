/** Code-derived MCP tool catalog (spec §4.3): name → { def, scope, category, module,
 *  protected } + handler source for the read-only Implementation view.
 *
 *  Category/module are a curated static map (the TOOL_SCOPES precedent — one exact
 *  entry per tool) rather than runtime imports of every tools/* def array; the
 *  completeness test in mcp-tool-catalog.test.ts fails the suite the moment a tool
 *  is advertised without an entry here, exactly like assertScopesCoverTools().
 *
 *  Imported by routes only (core process) — configure.ts/stdio must NOT import this
 *  (it pulls every handler module for String(handler)).
 */
import { LM_ASSIST_TOOL_DEFS, TOOL_SCOPES, type ToolScope } from '../configure';
import { PROTECTED_TOOLS } from './model';
import { EXPANDED_HANDLERS } from '../tools/expanded';
import { handleSearch } from '../tools/search';
import { handleDetail } from '../tools/detail';
import { handleFeedback } from '../tools/feedback';
import { handleListRecentSessions } from '../tools/list-recent-sessions';
import { handleListProjects } from '../tools/list-projects';
import { handleSearchMemory } from '../tools/search-memory';
import { handleListClaudeaiConversations } from '../tools/list-claudeai-conversations';
import { handleReadConversation } from '../tools/read-conversation';

export interface ToolCatalogEntry {
  name: string;
  def: (typeof LM_ASSIST_TOOL_DEFS)[number];
  scope: ToolScope;
  category: string;
  module: string;
  protected: boolean;
}

/** Display order for category groups (page left list). Alphabetical-ish by theme,
 *  orientation first. Kept exhaustive by the catalog test. */
export const CATEGORY_ORDER: string[] = [
  'core', 'session', 'mission', 'backlog', 'worker', 'agent', 'terminal', 'memory', 'data',
  'transfer', 'fleet', 'cluster', 'machine-access', 'ccr', 'claudeai', 'auth',
  'github', 'whatsapp', 'linkedin', 'gmail', 'backup', 'elevated', 'vm',
];

const T = 'core/src/mcp-server/tools';
type Meta = { category: string; module: string };
const META: Record<string, Meta> = {};
function mod(module: string, category: string, names: string[]): void {
  for (const n of names) META[n] = { category, module: `${T}/${module}` };
}

// --- orientation / core search surface ---
mod('search.ts', 'core', ['search']);
mod('detail.ts', 'core', ['detail']);
mod('feedback.ts', 'core', ['feedback']);
mod('guide.ts', 'core', ['bootstrap', 'guide']);
META['session_status'] = { category: 'core', module: 'core/src/mcp-server/mcp-session-resolver.ts' };
// --- sessions / projects ---
mod('list-recent-sessions.ts', 'session', ['list_recent_sessions']);
mod('list-projects.ts', 'session', ['list_projects']);
mod('expanded.ts', 'session', ['stall_status']);
mod('session-dag-tool.ts', 'session', ['session_dag']);
mod('session-footprints.ts', 'session', ['session_footprints']);
mod('session-messaging.ts', 'session', ['send_session_message', 'list_session_messages', 'get_message_status']);
// --- mission control ---
mod('mission.ts', 'mission', [
  'mission_create', 'mission_list', 'mission_update', 'mission_control_status', 'mission_place',
  'mission_spawn', 'mission_executor_status', 'mission_sessions', 'mission_session_read',
  'mission_session_drive', 'mission_session_answer', 'mission_session_control',
  'mission_session_resume', 'mission_tag', 'mission_history', 'mission_onboard',
]);
mod('mission-query.ts', 'mission', [
  'mission_query', 'mission_neighbors', 'mission_graph',
  'mission_view_set', 'mission_view_list', 'mission_view_get', 'mission_view_delete',
]);
mod('mission-schedule.ts', 'mission', ['mission_schedule', 'mission_changes']);
mod('mission-workflow.ts', 'mission', [
  'mission_workflow_list', 'mission_workflow_get', 'mission_workflow_set',
  'mission_workflow_history', 'mission_workflow_rollback',
]);
// --- backlog / feature-idea graph ---
mod('backlog.ts', 'backlog', [
  'backlog_list', 'backlog_get', 'backlog_create', 'backlog_update', 'backlog_link',
  'backlog_unlink', 'backlog_review', 'backlog_discuss', 'backlog_remove', 'backlog_graph',
]);
// --- worker role protocol ---
mod('worker-role.ts', 'worker', ['set_role', 'report_status', 'worker_status', 'list_workers', 'decide_gate']);
// --- agent executions / automation ---
mod('expanded.ts', 'agent', ['list_executions', 'get_execution', 'agent_execute', 'agent_abort', 'agent_resume']);
mod('browser-task.ts', 'agent', ['browser_task']);
// --- terminal driving ---
mod('expanded.ts', 'terminal', [
  'terminal_list', 'terminal_capture', 'terminal_prompt', 'terminal_slash', 'terminal_send', 'terminal_interrupt', 'terminal_open_tab',
  'windows_terminal_list', 'windows_terminal_capture', 'windows_terminal_state', 'windows_terminal_launch',
  'windows_terminal_create', 'windows_terminal_send', 'windows_terminal_restart', 'windows_terminal_auto_handle', 'windows_terminal_close',
]);
// --- memory + rules ---
mod('search-memory.ts', 'memory', ['search_memory']);
mod('expanded.ts', 'memory', [
  'memory_projects', 'memory_sync_status', 'memory_cross_host', 'memory_import_candidates', 'memory_file',
  'memory_map', 'memory_record', 'memory_write',
  'rule_map', 'rule_record', 'rule_sync_status', 'rule_cross_host', 'rule_import_candidates', 'rule_projects',
]);
// --- data service ---
mod('data-tools.ts', 'data', [
  'data_catalog', 'data_request_access', 'data_get', 'data_query', 'data_put', 'data_delete', 'data_search',
  'data_admin', 'data_create_dataset', 'data_drop_dataset', 'data_keys', 'data_revoke_key', 'data_sync', 'data_sync_status',
]);
// --- file transfer / remote fs / port-forward ---
mod('transfer.ts', 'transfer', [
  'transfer_send_file', 'transfer_list_remote', 'transfer_stats', 'transfer_queue', 'transfer_cancel', 'transfer_status',
]);
mod('fs-inspect.ts', 'transfer', ['fs_drives', 'fs_list', 'fs_stat', 'fs_read']);
mod('port-forward.ts', 'transfer', ['open_port_forward', 'list_port_forwards', 'close_port_forward', 'port_forward_stats']);
// --- fleet / node ops ---
mod('list-nodes.ts', 'fleet', ['list_nodes']);
mod('node-status.ts', 'fleet', ['node_status']);
mod('lifecycle.ts', 'fleet', ['node_lifecycle']);
mod('node-builds.ts', 'fleet', ['node_builds']);
mod('node-upgrade.ts', 'fleet', ['node_upgrade']);
// Placement selection sits with the other node_* tools: 'nodes' is a guide TOPIC,
// not a catalog CATEGORY (CATEGORY_ORDER above is the closed set).
mod('node-profile.ts', 'fleet', ['node_profile', 'node_select']);
mod('fabric-probe.ts', 'fleet', ['fabric_probe']);
mod('bus.ts', 'fleet', ['bus_publish', 'bus_read', 'bus_topics']);
mod('scheduler.ts', 'fleet', ['scheduler_jobs']);
// --- clusters ---
mod('cluster.ts', 'cluster', ['cluster_list', 'cluster_assign', 'cluster_unassign', 'cluster_describe']);
// --- machine access profiles ---
mod('machine-access.ts', 'machine-access', ['machine_access']);

// --- ccr / cloud Claude Code ---
mod('expanded.ts', 'ccr', [
  'cc_sessions', 'ccr_preflight', 'ccr_bridge_registry', 'ccr_live_list', 'ccr_load', 'ccr_mirror', 'ccr_connect', 'ccr_drive',
  'ccr_remote_stop', 'ccr_restart', 'ccr_cloud_start', 'ccr_cloud_repos', 'ccr_cloud_drive', 'ccr_cloud_answer',
  'ccr_cloud_read', 'ccr_cloud_stop', 'ccr_cloud_restart', 'ccr_cloud_list',
]);
// --- claude.ai web ---
mod('list-claudeai-conversations.ts', 'claudeai', ['list_claudeai_conversations']);
mod('read-conversation.ts', 'claudeai', ['read_conversation']);
mod('conversation-ops.ts', 'claudeai', ['conversation_tokens', 'conversation_fork']);
mod('expanded.ts', 'claudeai', [
  'claudeai_list_marketplaces', 'claudeai_list_marketplace_plugins', 'claudeai_list_plugins',
  'claudeai_create_conversation', 'claudeai_completion', 'claudeai_add_marketplace', 'claudeai_remove_marketplace',
  'claudeai_set_plugin_enabled', 'delete_conversation', 'rename_conversation',
]);
mod('refresh-connector.ts', 'claudeai', [
  'list_claudeai_connectors', 'refresh_connector_tools', 'set_connector_tool_access', 'set_connector_auto_approve',
]);
mod('claudeai-active-sessions.ts', 'claudeai', ['claudeai_active_sessions']);
mod('cowork.ts', 'claudeai', ['cowork_create_task']);
// --- credentials / accounts ---
mod('auth-status.ts', 'auth', ['auth_status']);
mod('claude-code-account.ts', 'auth', ['claude_code_account']);
mod('claudeai-account.ts', 'auth', ['claudeai_account']);
mod('claude-code-usage.ts', 'auth', ['claude_code_usage']);
mod('claudeai-login.ts', 'auth', ['claudeai_login']);
// --- github ---
mod('github.ts', 'github', ['github_query', 'github_mutate']);
// --- linkedin ---
mod('linkedin.ts', 'linkedin', [
  'linkedin_status', 'linkedin_login', 'linkedin_list_conversations', 'linkedin_read_messages',
  'linkedin_search', 'linkedin_send_message', 'linkedin_read_feed', 'linkedin_read_notifications',
  'linkedin_post', 'linkedin_publish_article', 'linkedin_search_people', 'linkedin_follow',
  'linkedin_connect', 'linkedin_message_profile', 'linkedin_comment', 'linkedin_delete_post',
]);

// --- gmail ---
mod('gmail.ts', 'gmail', [
  'gmail_status', 'gmail_summary', 'gmail_drafts', 'gmail_forward', 'gmail_triage', 'gmail_login', 'gmail_list_threads', 'gmail_read_thread',
  'gmail_search', 'gmail_search_local', 'gmail_sync', 'gmail_sync_status',
  'gmail_attachments', 'gmail_attachment_download', 'gmail_labels', 'gmail_selfcheck', 'gmail_aliases', 'gmail_send',
  'gmail_reply', 'gmail_draft', 'gmail_archive', 'gmail_trash', 'gmail_untrash', 'gmail_mark_read',
  'gmail_star', 'gmail_spam', 'gmail_apply_label', 'gmail_remove_label',
  'gmail_create_label', 'gmail_rename_label', 'gmail_delete_label', 'gmail_move_to',
  'gmail_schedule_send', 'gmail_settings', 'gmail_draft_send', 'gmail_draft_delete', 'gmail_schedule_cancel', 'gmail_bulk',
]);

// --- backup ---
mod('backup.ts', 'backup', [
  'backup_run', 'backup_status', 'backup_list', 'backup_search', 'backup_read', 'backup_remove',
]);

// --- whatsapp ---
mod('whatsapp.ts', 'whatsapp', [
  'whatsapp_send', 'whatsapp_get_media', 'whatsapp_list_chats', 'whatsapp_read_messages', 'whatsapp_search', 'whatsapp_status',
]);
// --- windows elevated worker ---
mod('elevated.ts', 'elevated', ['elevated_status', 'elevated_exec', 'elevated_grant', 'elevated_revoke']);
// --- vm management (Hyper-V / KVM) ---
mod('vm.ts', 'vm', ['vm_status', 'vm_create', 'vm_power', 'vm_snapshot', 'vm_delete']);

let _catalog: Map<string, ToolCatalogEntry> | null = null;

/** name → entry for every ADVERTISED tool. Names without META fall back to
 *  category 'other' / module expanded.ts — the completeness test turns any such
 *  fallback into a failure, so drift is caught at test time, not hidden. */
export function getToolCatalog(): ReadonlyMap<string, ToolCatalogEntry> {
  if (_catalog) return _catalog;
  const m = new Map<string, ToolCatalogEntry>();
  for (const def of LM_ASSIST_TOOL_DEFS) {
    const meta = META[def.name];
    m.set(def.name, {
      name: def.name,
      def,
      scope: TOOL_SCOPES[def.name] ?? 'admin',
      category: meta?.category ?? 'other',
      module: meta?.module ?? `${T}/expanded.ts`,
      protected: PROTECTED_TOOLS.has(def.name),
    });
  }
  _catalog = m;
  return m;
}

const BASE_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  search: handleSearch,
  detail: handleDetail,
  feedback: handleFeedback,
  list_recent_sessions: handleListRecentSessions,
  list_projects: handleListProjects,
  search_memory: handleSearchMemory,
  list_claudeai_conversations: handleListClaudeaiConversations,
  read_conversation: handleReadConversation,
};

/** The registered in-process handler's source (String(fn)) + its defining module —
 *  the read-only Implementation view. Null when the tool has no in-process handler
 *  (unknown name). Some expanded entries are thin arrow wrappers; the module
 *  pointer is the primary navigation aid, the source is best-effort per spec. */
export function handlerSourceFor(name: string): { module: string; source: string } | null {
  const fn = BASE_HANDLERS[name] ?? EXPANDED_HANDLERS[name];
  if (!fn) return null;
  const meta = META[name];
  return { module: meta?.module ?? `${T}/expanded.ts`, source: String(fn) };
}
