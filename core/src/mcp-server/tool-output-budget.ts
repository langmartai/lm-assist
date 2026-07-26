/**
 * Per-tool output-size budget — the standing guard against the class of failure
 * that killed a conversation on 2026-07-25.
 *
 * WHAT HAPPENED: one `mission_list` call returned 1,757 KB and consumed 58% of a
 * live 110-message conversation, leaving it permanently unable to accept input.
 * The user-visible text in that whole conversation was only ~44K chars. Nobody
 * knew a single tool could do that until the conversation died.
 *
 * WHY A BUDGET FILE AND NOT JUST A CEILING: a ceiling alone tells you a tool is
 * too big today; it cannot tell you a NEW tool arrived unclassified, and it
 * cannot stop a tool that is under the ceiling from creeping toward it. The
 * audit that produced these numbers is a snapshot, and a snapshot rots. This
 * file is the ratchet that keeps it honest:
 *
 *   - every tool on the surface must be CLASSIFIED here (see the test); a tool
 *     that appears in `tools/list` with no entry FAILS the guard, so the next
 *     person to add a tool has to state what bounds its output,
 *   - a tool may SHRINK freely, but growing past its recorded budget FAILS,
 *   - the known-unbounded offenders are recorded with their measured size and a
 *     verdict, so they are tracked debt rather than silent breakage.
 *
 * Sizes are `textBytes`: the concatenated text of the MCP `content` blocks —
 * what actually lands in a conversation's context. Image blocks are deliberately
 * NOT counted by byte length: Claude tokenizes an image by its dimensions
 * (~≤1600 tokens), so a 950 KB base64 screenshot costs far less context than
 * 950 KB of text. Byte-counting images would flag the wrong tools.
 *
 * Measured 2026-07-26 on node 117 against live fleet data (50 missions, 1,313
 * memory records, 92 claude.ai plugins, 55 sessions, 22 backlog items).
 * Full audit: docs/mcp-tool-output-audit.md
 */

/**
 * Ceilings, in bytes of result text.
 *
 * Chosen from the measured distribution, not a round number: of the 72 read-only
 * tools measured, 60 already returned under 20 KB. SOFT therefore leaves the
 * large majority untouched while flagging exactly the tools that need work.
 * HARD (~14k tokens) bounds one call to ~7% of a 200k-token context, so a
 * conversation survives several such calls.
 */
export const TOOL_OUTPUT_SOFT_BYTES = 25 * 1024;
export const TOOL_OUTPUT_HARD_BYTES = 50 * 1024;

/** What bounds a tool's output today. */
export type BoundKind =
  /** A server-enforced maximum that holds regardless of arguments. */
  | 'HARD_LIMIT'
  /** offset+limit or cursor paging, with a bounded page. */
  | 'PAGINATED'
  /** A caller `limit` arg AND a sane default applied when it is omitted. */
  | 'CALLER_LIMIT_SANE_DEFAULT'
  /** A caller `limit` arg but unbounded when omitted — a trap for the default caller. */
  | 'CALLER_LIMIT_NO_DEFAULT'
  /** Returns an ack/scalar that cannot grow with fleet data. */
  | 'SMALL_BY_CONSTRUCTION'
  /** Serialises a whole collection with no bound at all. */
  | 'NOTHING';

export type Verdict =
  /** Under the soft ceiling and structurally bounded. */
  | 'SAFE'
  /** The generic per-result ceiling is a sufficient fix. */
  | 'NEEDS-CAP'
  /** A byte cap alone leaves it useless — needs a compact projection + paging. */
  | 'NEEDS-SUMMARY';

export interface ToolBudget {
  /** Measured result text bytes on the audit fleet, or 0 for never-invoked tools. */
  measuredBytes: number;
  /** Ceiling for THIS tool. Growth past it fails the guard. */
  budgetBytes: number;
  bound: BoundKind;
  verdict: Verdict;
  /** True when the tool mutates state and is therefore never invoked by the guard. */
  write?: boolean;
  /** Why it is unbounded / what dominates the payload. */
  note?: string;
}

/**
 * Tools whose size the guard actually measures, because they are READ-ONLY and
 * safe to invoke repeatedly. `budgetBytes` is set above the measured value with
 * headroom for normal fleet drift — tight enough that a real regression trips it.
 */
export const MEASURED_BUDGETS: Record<string, ToolBudget> = {
  // ── the unbounded registry dumps (tracked debt) ─────────────────────────
  claudeai_list_plugins: {
    measuredBytes: 1_156_000, budgetBytes: 1_400_000, bound: 'NOTHING', verdict: 'NEEDS-SUMMARY',
    note: 'claude.ai marketplace catalogue, ~12.6 KB per plugin x 92. Grows with an ecosystem outside this repo.',
  },
  mission_query: {
    measuredBytes: 961_000, budgetBytes: 1_200_000, bound: 'NOTHING', verdict: 'NEEDS-SUMMARY',
    note: 'Full mission records, ~19.2 KB each. Was 168 KB at the incident; grew 5.6x.',
  },
  mission_list: {
    measuredBytes: 924_000, budgetBytes: 1_200_000, bound: 'NOTHING', verdict: 'NEEDS-SUMMARY',
    note: 'Input schema is {node} — NO limit/offset/status. A caller cannot ask for less. ~18.5 KB per mission.',
  },
  memory_map: {
    measuredBytes: 826_000, budgetBytes: 1_100_000, bound: 'NOTHING', verdict: 'NEEDS-SUMMARY',
    note: '629 B x 1,313 records. Memory grows monotonically and is never pruned.',
  },
  mission_workflow_list: {
    measuredBytes: 116_500, budgetBytes: 200_000, bound: 'NOTHING', verdict: 'NEEDS-SUMMARY',
    note: 'Full workflow doc bodies, ~2.0 KB each x 59.',
  },
  mission_changes: {
    measuredBytes: 115_000, budgetBytes: 200_000, bound: 'NOTHING', verdict: 'NEEDS-SUMMARY',
    note: 'Full change/rev feed, ~469 B per rev. Revs only accumulate.',
  },
  bootstrap: { measuredBytes: 55_600, budgetBytes: 90_000, bound: 'NOTHING', verdict: 'NEEDS-CAP', note: 'Mostly fixed onboarding prose plus a fleet-scaling tail.' },
  data_keys: { measuredBytes: 55_150, budgetBytes: 90_000, bound: 'NOTHING', verdict: 'NEEDS-SUMMARY', note: 'Schema is {node} only — its dataset arg is ignored; enumerates all keys.' },
  cc_sessions: { measuredBytes: 52_300, budgetBytes: 90_000, bound: 'NOTHING', verdict: 'NEEDS-SUMMARY', note: '~950 B per session x 55.' },
  windows_terminal_list: { measuredBytes: 52_300, budgetBytes: 90_000, bound: 'NOTHING', verdict: 'NEEDS-SUMMARY', note: '~950 B per terminal x 55.' },
  mission_graph: { measuredBytes: 42_800, budgetBytes: 80_000, bound: 'NOTHING', verdict: 'NEEDS-CAP', note: 'Nodes+edges for every mission.' },
  ccr_cloud_list: { measuredBytes: 41_500, budgetBytes: 80_000, bound: 'NOTHING', verdict: 'NEEDS-CAP', note: '~829 B per cloud session x 50.' },
  backlog_list: { measuredBytes: 19_700, budgetBytes: 45_000, bound: 'NOTHING', verdict: 'NEEDS-CAP', note: '~895 B per item x 22; unbounded but small today.' },
  session_footprints: { measuredBytes: 18_100, budgetBytes: 45_000, bound: 'NOTHING', verdict: 'NEEDS-CAP' },
  backlog_graph: { measuredBytes: 10_700, budgetBytes: 30_000, bound: 'NOTHING', verdict: 'SAFE' },
  list_session_messages: { measuredBytes: 9_500, budgetBytes: 30_000, bound: 'NOTHING', verdict: 'SAFE' },
  terminal_list: { measuredBytes: 9_000, budgetBytes: 30_000, bound: 'NOTHING', verdict: 'SAFE' },
  machine_access: { measuredBytes: 6_300, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  mission_control_status: { measuredBytes: 5_500, budgetBytes: 25_000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  memory_projects: { measuredBytes: 5_100, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  guide: { measuredBytes: 5_100, budgetBytes: 25_000, bound: 'HARD_LIMIT', verdict: 'SAFE', note: 'One topic per call; largest shipped topic is small.' },
  data_catalog: { measuredBytes: 4_600, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  search_memory: { measuredBytes: 4_300, budgetBytes: 25_000, bound: 'CALLER_LIMIT_SANE_DEFAULT', verdict: 'SAFE' },
  list_projects: { measuredBytes: 4_100, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  rule_sync_status: { measuredBytes: 3_900, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  ccr_remote_list: { measuredBytes: 3_400, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  memory_sync_status: { measuredBytes: 3_200, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  scheduler_jobs: { measuredBytes: 3_000, budgetBytes: 25_000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  rule_map: { measuredBytes: 2_400, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  mission_sessions: { measuredBytes: 2_200, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  list_recent_sessions: { measuredBytes: 2_200, budgetBytes: 25_000, bound: 'CALLER_LIMIT_SANE_DEFAULT', verdict: 'SAFE' },
  session_status: { measuredBytes: 2_100, budgetBytes: 25_000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  search: { measuredBytes: 1_800, budgetBytes: 25_000, bound: 'CALLER_LIMIT_SANE_DEFAULT', verdict: 'SAFE' },
  cluster_list: { measuredBytes: 1_200, budgetBytes: 25_000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  list_claudeai_connectors: { measuredBytes: 1_200, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  bus_topics: { measuredBytes: 1_100, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  claudeai_list_marketplaces: { measuredBytes: 1_100, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  claudeai_active_sessions: { measuredBytes: 1_000, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  list_nodes: { measuredBytes: 800, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  stall_status: { measuredBytes: 600, budgetBytes: 25_000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  claudeai_account: { measuredBytes: 600, budgetBytes: 25_000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  list_port_forwards: { measuredBytes: 500, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  rule_projects: { measuredBytes: 500, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  auth_status: { measuredBytes: 500, budgetBytes: 25_000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  claude_code_account: { measuredBytes: 500, budgetBytes: 25_000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  whatsapp_status: { measuredBytes: 400, budgetBytes: 25_000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  claude_code_usage: { measuredBytes: 400, budgetBytes: 25_000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  node_status: { measuredBytes: 400, budgetBytes: 25_000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  data_sync_status: { measuredBytes: 300, budgetBytes: 25_000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  fs_drives: { measuredBytes: 300, budgetBytes: 25_000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  elevated_status: { measuredBytes: 300, budgetBytes: 25_000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  transfer_stats: { measuredBytes: 200, budgetBytes: 25_000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  node_builds: { measuredBytes: 200, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  port_forward_stats: { measuredBytes: 200, budgetBytes: 25_000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  rule_import_candidates: { measuredBytes: 200, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  list_executions: { measuredBytes: 200, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  list_workers: { measuredBytes: 200, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  mission_view_list: { measuredBytes: 200, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },

  // ── read-only but need a target id; measured with a real id ─────────────
  fs_read: {
    measuredBytes: 66_000, budgetBytes: 90_000, bound: 'CALLER_LIMIT_SANE_DEFAULT', verdict: 'NEEDS-CAP',
    note: 'Default cap is 64 KiB (verified: a 107 KB file truncated to exactly 65,536 B of content). 64 KiB is still ~18k tokens.',
  },
  mission_neighbors: { measuredBytes: 26_300, budgetBytes: 60_000, bound: 'CALLER_LIMIT_SANE_DEFAULT', verdict: 'NEEDS-CAP', note: 'Depth arg; full records per neighbour.' },
  memory_file: { measuredBytes: 16_500, budgetBytes: 60_000, bound: 'NOTHING', verdict: 'NEEDS-CAP', note: 'Whole memory file; bounded only by the file on disk.' },
  mission_history: { measuredBytes: 13_700, budgetBytes: 40_000, bound: 'CALLER_LIMIT_SANE_DEFAULT', verdict: 'SAFE' },
  terminal_capture: { measuredBytes: 6_300, budgetBytes: 30_000, bound: 'HARD_LIMIT', verdict: 'SAFE', note: 'One pane of terminal text.' },
  backlog_get: { measuredBytes: 5_800, budgetBytes: 30_000, bound: 'NOTHING', verdict: 'SAFE', note: 'One item incl. discussion + rev history.' },
  mission_workflow_get: { measuredBytes: 5_200, budgetBytes: 30_000, bound: 'NOTHING', verdict: 'SAFE' },
  detail: { measuredBytes: 1_100, budgetBytes: 25_000, bound: 'PAGINATED', verdict: 'SAFE' },
  mission_workflow_history: { measuredBytes: 800, budgetBytes: 25_000, bound: 'CALLER_LIMIT_SANE_DEFAULT', verdict: 'SAFE' },
  session_dag: { measuredBytes: 600, budgetBytes: 25_000, bound: 'NOTHING', verdict: 'SAFE' },
  data_search: { measuredBytes: 200, budgetBytes: 25_000, bound: 'CALLER_LIMIT_SANE_DEFAULT', verdict: 'SAFE' },
  data_query: {
    measuredBytes: 960_400, budgetBytes: 1_200_000, bound: 'NOTHING', verdict: 'NEEDS-SUMMARY',
    note: 'Returns the whole named dataset. Datasets are user-extensible, so no static per-tool number is right — the row cap belongs in the data service.',
  },
};

/**
 * Tools the guard never invokes, each with the reason. Listed so coverage is a
 * checkable claim rather than an implicit gap: the test asserts every tool on
 * the live surface is either measured above or excused here.
 */
export const NOT_MEASURED: Record<string, string> = Object.fromEntries([
  // Mutating registry / state writes. NOTE: these are NOT safe by virtue of
  // being writes — a write echoes the full record plus its rev history, which
  // is exactly how backlog_create reached 63 KB in the incident. They need the
  // ceiling too; they simply cannot be measured by an automated guard.
  ...['mission_create', 'mission_update', 'mission_place', 'mission_spawn', 'mission_tag',
    'mission_onboard', 'mission_schedule', 'mission_view_set', 'mission_view_delete',
    'mission_session_drive', 'mission_session_answer', 'mission_session_control',
    'mission_session_resume', 'mission_workflow_set', 'mission_workflow_rollback',
    'backlog_create', 'backlog_update', 'backlog_link', 'backlog_unlink', 'backlog_review',
    'backlog_discuss', 'backlog_remove', 'feedback', 'memory_record', 'memory_write',
    'rule_record', 'data_put', 'data_delete', 'data_admin', 'data_create_dataset',
    'data_drop_dataset', 'data_revoke_key', 'data_sync', 'data_request_access',
    'set_role', 'report_status', 'decide_gate', 'bus_publish', 'cluster_assign',
    'cluster_unassign', 'cluster_describe', 'cowork_create_task', 'send_session_message',
  ].map((n) => [n, 'write: mutates state (echoes full record + rev history — still needs the ceiling)']),
  // Lifecycle / destructive.
  ...['agent_execute', 'agent_abort', 'agent_resume', 'node_upgrade', 'node_lifecycle',
    'ccr_load', 'ccr_mirror', 'ccr_connect', 'ccr_drive', 'ccr_remote_stop', 'ccr_restart',
    'ccr_cloud_restart', 'ccr_cloud_start', 'ccr_cloud_stop', 'ccr_cloud_drive',
    'ccr_cloud_answer', 'open_port_forward', 'close_port_forward', 'transfer_send_file',
    'transfer_queue', 'transfer_cancel', 'elevated_exec', 'elevated_grant', 'elevated_revoke',
    'terminal_prompt', 'terminal_slash', 'terminal_interrupt', 'terminal_open_tab',
    'windows_terminal_launch', 'windows_terminal_create', 'windows_terminal_send',
    'windows_terminal_auto_handle', 'windows_terminal_close', 'github_mutate',
    'refresh_connector_tools', 'set_connector_tool_access', 'set_connector_auto_approve',
    'claudeai_add_marketplace', 'claudeai_remove_marketplace', 'claudeai_set_plugin_enabled',
    'claudeai_login', 'browser_task',
  ].map((n) => [n, 'destructive/lifecycle: starts, stops or reconfigures real resources']),
  // Third-party side effects (sends a message, creates a conversation, spends).
  ...['claudeai_create_conversation', 'claudeai_completion', 'rename_conversation',
    'delete_conversation', 'whatsapp_send', 'whatsapp_get_media',
  ].map((n) => [n, 'third-party side effect: writes to claude.ai or WhatsApp']),
  // Read-only, but need an id/argument the guard cannot synthesise safely, or
  // reach a remote/offline peer. Covered statically in the audit doc.
  ...['get_execution', 'mission_session_read', 'get_message_status', 'transfer_status',
    'ccr_cloud_read', 'ccr_cloud_repos', 'github_query', 'whatsapp_list_chats',
    'whatsapp_read_messages', 'whatsapp_search', 'claudeai_list_marketplace_plugins',
    'read_conversation', 'data_get', 'memory_cross_host', 'memory_import_candidates',
    'rule_cross_host', 'worker_status', 'transfer_list_remote', 'bus_read',
    'windows_terminal_state', 'list_claudeai_conversations', 'ccr_preflight',
    'fabric_probe', 'mission_executor_status', 'fs_list', 'fs_stat',
    // Found by this guard's own coverage check on its first run — proof the
    // check works: both were missed by the hand-built audit list.
    'windows_terminal_capture', 'mission_view_get',
  ].map((n) => [n, 'read-only but needs a target id or a live peer; covered statically']),
]);

/**
 * Third-party plugin tools (`ext__<plugin>__<tool>`) are exempt from per-tool
 * classification because the aggregator already enforces a universal hard cap
 * that no plugin can exceed: 1 MiB across all content blocks, over which the
 * whole result is replaced by a 4 KiB excerpt plus an explicit "too large"
 * notice (core/src/mcp-server/plugins/client.ts capResult), backed by an 8 MiB
 * unframed-output guard that kills a runaway child rather than the Core.
 *
 * That makes the ext surface the BEST-bounded one on the server — the opposite
 * of the intuition that third-party code is the least controlled. The guard
 * asserts this cap still exists rather than measuring 55 device-driving tools.
 */
export const EXT_TOOL_PREFIX = 'ext__';
export const EXT_AGGREGATOR_CAP_BYTES = 1024 * 1024;
