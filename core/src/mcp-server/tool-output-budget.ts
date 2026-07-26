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
 *
 * THE CONNECT-TIME TAX IS A SEPARATE BUDGET AND LIVES ELSEWHERE. Everything here
 * bounds what a tool RETURNS. `tools/list` itself cost 350,402 B / ~87.6K tokens
 * for 244 tools — paid by every conversation before a single call — and 40.3% of
 * it was ONE 751-byte `node` paragraph repeated on 188 tools. That is guarded by
 * mcp-catalog-size.test.ts, whose rule is different in kind: shared boilerplate is
 * multiplied by the surface, so its cost is length x tool count.
 */

/**
 * The ADVISORY budget, in bytes of result text.
 *
 * There is deliberately no hard ceiling in this file. The enforced ceiling is
 * `DEFAULT_MAX_RESULT_BYTES` in `result-cap.ts` (64 KiB, landed by
 * mission_f4055461 at the `configureMcpServer` seam both surfaces share,
 * overridable per node with `MCP_RESULT_MAX_BYTES`). Anything needing the hard
 * number imports it from there — one hard number, one owner. Even an alias here
 * would be a second name for it, and a second name is how two numbers start
 * drifting apart.
 *
 * SOFT does a different job from the cap. The cap is an enforcement backstop that
 * CUTS a result; SOFT is where a tool becomes worth *looking at*, well before
 * anything gets cut. Set from the measured distribution — of the 70 read-only
 * tools measured pre-cap, 60 already returned under 20 KB — so it keeps pressure
 * on the tools that need design work without nagging about the majority.
 *
 * A 50 KB hard ceiling was proposed by this audit and rejected on measurement:
 * `bootstrap` is 55,572 B by design (it loads every use case in one call), so
 * 50 KB would have truncated session onboarding on EVERY fresh connect, making a
 * truncation marker the first thing a new session read.
 */
export const TOOL_OUTPUT_SOFT_BYTES = 25 * 1024;

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
    measuredBytes: 32995, budgetBytes: 46000, bound: 'NOTHING', verdict: 'NEEDS-SUMMARY',
    note: 'PRE-CAP 1,156,396 B (~12.6 KB per plugin x 92) — 82.3% of it the per-plugin skills manifest. Now projected to a capability count map. Grows with an ecosystem outside this repo.',
  },
  mission_query: {
    measuredBytes: 34102, budgetBytes: 48000, bound: 'NOTHING', verdict: 'NEEDS-SUMMARY',
    note: 'PRE-CAP 960,675 B (~19.2 KB per mission). Was 168 KB at the incident, grew 5.6x, now projected.',
  },
  mission_list: {
    measuredBytes: 34132, budgetBytes: 48000, bound: 'NOTHING', verdict: 'NEEDS-SUMMARY',
    note: 'PRE-CAP 923,758 B, 54.6% of it per-record REVISION HISTORY. Schema was {node} only — no way to ask for less; now takes detail/limit/offset/id.',
  },
  memory_map: {
    measuredBytes: 36053, budgetBytes: 50000, bound: 'PAGINATED', verdict: 'NEEDS-CAP',
    note: 'PRE-CAP 827,724 B = 1,313 records x 629 B. NO fat field (widest 143 B), so projection could ' +
      'not fix it — paginated instead (default 60). THE MONOTONIC GROWTH IS NOT THEORETICAL: the same ' +
      'map measured 1,323 records on 2026-07-26, up 10 from the audit days earlier, because records ' +
      'are never pruned and every host mirror re-emits the whole set. Being bounded was not enough — ' +
      'it returned a BARE ARRAY, so 60 of 1,323 read as the complete map; it now reports ' +
      'total/shown/offset/hasMore plus the next call (bl_8a737823).',
  },
  mission_workflow_list: {
    measuredBytes: 13498, budgetBytes: 30000, bound: 'PAGINATED', verdict: 'SAFE',
    note: 'WAS 65,829 B — truncated at the ceiling with a {node}-only schema, the second dead end. ' +
      'Fixed by the body projection + detail/limit/offset: 13,498 B measured 2026-07-26, a 4.9x cut, ' +
      'and it no longer truncates at all.',
  },
  mission_changes: {
    measuredBytes: 23013, budgetBytes: 40000, bound: 'PAGINATED', verdict: 'NEEDS-CAP',
    note: 'WAS 65,829 B (truncated). Now 23,013 B via the actor projection + paging. Revs only ' +
      'accumulate, so this one keeps climbing by construction — narrow with sinceRev/sinceTs.',
  },
  bootstrap: { measuredBytes: 55654, budgetBytes: 78000, bound: 'NOTHING', verdict: 'NEEDS-CAP', note: 'Deliberately large — loads every use case in one call; 55,572 B set the floor for the ' +
    'enforced ceiling. Does NOT scale with fleet data: ~52,344 B is STATIC prose (GUIDES sections), ' +
    'plus optional admin-curated content-registry overrides and a clusterBlock that grows with ' +
    'CLUSTER count (2-3), not nodes/sessions/missions. The 101KB->54KB swing since the incident was ' +
    'override prose in the registry, not data growth. Fix is trimming prose, not capping a list.' },
  data_keys: {
    measuredBytes: 61574, budgetBytes: 78000, bound: 'PAGINATED', verdict: 'NEEDS-CAP',
    note: 'PRE-PAGING 61,574 B and climbing — it was 55,967 B at the audit and reached 94% of the ' +
      'ceiling before anyone touched it, purely from the fleet issuing keys. Its handler took ' +
      '`_args` and enumerated everything. Now limit/offset with a 25 default AT THE MCP LAYER ONLY: ' +
      'GET /data/keys is what the web UI Data page reads.',
  },
  cc_sessions: { measuredBytes: 20578, budgetBytes: 29000, bound: 'NOTHING', verdict: 'NEEDS-SUMMARY', note: '~950 B per session x 55.' },
  windows_terminal_list: { measuredBytes: 52395, budgetBytes: 73000, bound: 'NOTHING', verdict: 'NEEDS-SUMMARY', note: '~950 B per terminal x 55.' },
  mission_graph: { measuredBytes: 42771, budgetBytes: 60000, bound: 'NOTHING', verdict: 'NEEDS-CAP', note: 'Nodes+edges for every mission.' },
  ccr_cloud_list: { measuredBytes: 41480, budgetBytes: 58000, bound: 'NOTHING', verdict: 'NEEDS-CAP', note: '~829 B per cloud session x 50.' },
  backlog_list: { measuredBytes: 24015, budgetBytes: 34000, bound: 'NOTHING', verdict: 'NEEDS-CAP', note: '~895 B per item x 22; unbounded but small today.' },
  session_footprints: { measuredBytes: 19547, budgetBytes: 27000, bound: 'NOTHING', verdict: 'NEEDS-CAP' },
  backlog_graph: { measuredBytes: 13146, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  list_session_messages: {
    measuredBytes: 27840, budgetBytes: 45000, bound: 'NOTHING', verdict: 'NEEDS-CAP',
    note: 'GREW 19,362 -> 27,840 B (+44%) DURING the audit session, and the guard caught it — the ' +
      'only live demonstration we have of the ratchet firing on real growth. Cause: it returns ' +
      'EVERY stored session-message with its full free-text body plus ack history, filterable by ' +
      'session/status but with NO limit. The audit itself sent four long messages to a sibling ' +
      'mission; that alone moved it 8 KB. It therefore grows with ordinary fleet chatter, not with ' +
      'anything rare. Budget raised deliberately to 45,000 with the reclassification, not to ' +
      'silence the failure.',
  },
  terminal_list: { measuredBytes: 9007, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  machine_access: { measuredBytes: 6254, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  mission_control_status: { measuredBytes: 5442, budgetBytes: 25000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  memory_projects: { measuredBytes: 5149, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  guide: { measuredBytes: 5127, budgetBytes: 25000, bound: 'HARD_LIMIT', verdict: 'SAFE', note: 'One topic per call; largest shipped topic is small.' },
  data_catalog: { measuredBytes: 4617, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  search_memory: { measuredBytes: 4359, budgetBytes: 25000, bound: 'CALLER_LIMIT_SANE_DEFAULT', verdict: 'SAFE' },
  list_projects: { measuredBytes: 4185, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  rule_sync_status: { measuredBytes: 1630, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  ccr_remote_list: { measuredBytes: 3354, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  memory_sync_status: { measuredBytes: 1486, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  scheduler_jobs: { measuredBytes: 3031, budgetBytes: 25000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  rule_map: { measuredBytes: 2392, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  mission_sessions: { measuredBytes: 2185, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  list_recent_sessions: { measuredBytes: 4810, budgetBytes: 25000, bound: 'CALLER_LIMIT_SANE_DEFAULT', verdict: 'SAFE' },
  session_status: { measuredBytes: 2070, budgetBytes: 25000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  search: { measuredBytes: 1715, budgetBytes: 25000, bound: 'CALLER_LIMIT_SANE_DEFAULT', verdict: 'SAFE' },
  cluster_list: { measuredBytes: 1168, budgetBytes: 25000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  list_claudeai_connectors: { measuredBytes: 1168, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  bus_topics: { measuredBytes: 1059, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  claudeai_list_marketplaces: { measuredBytes: 998, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  claudeai_active_sessions: { measuredBytes: 974, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  list_nodes: { measuredBytes: 737, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  stall_status: { measuredBytes: 558, budgetBytes: 25000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  claudeai_account: { measuredBytes: 492, budgetBytes: 25000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  list_port_forwards: { measuredBytes: 451, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  rule_projects: { measuredBytes: 421, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  auth_status: { measuredBytes: 416, budgetBytes: 25000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  claude_code_account: { measuredBytes: 415, budgetBytes: 25000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  whatsapp_status: { measuredBytes: 353, budgetBytes: 25000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  claude_code_usage: { measuredBytes: 342, budgetBytes: 25000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  node_status: { measuredBytes: 331, budgetBytes: 25000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  data_sync_status: { measuredBytes: 263, budgetBytes: 25000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  fs_drives: { measuredBytes: 203, budgetBytes: 25000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  elevated_status: { measuredBytes: 168, budgetBytes: 25000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  transfer_stats: { measuredBytes: 156, budgetBytes: 25000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  node_builds: { measuredBytes: 155, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  port_forward_stats: { measuredBytes: 145, budgetBytes: 25000, bound: 'SMALL_BY_CONSTRUCTION', verdict: 'SAFE' },
  rule_import_candidates: { measuredBytes: 133, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  list_executions: { measuredBytes: 129, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  list_workers: { measuredBytes: 127, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  mission_view_list: { measuredBytes: 97, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },

  // ── read-only but need a target id; measured with a real id ─────────────
  fs_read: {
    measuredBytes: 65856, budgetBytes: 92000, bound: 'CALLER_LIMIT_SANE_DEFAULT', verdict: 'NEEDS-CAP',
    note: 'BETTER BOUNDED than this audit first classified it. Default 64 KiB (READ_DEFAULT_BYTES) ' +
      'and a HARD server clamp a caller cannot exceed: Math.min(maxBytes, READ_MAX_BYTES=1 MiB) in ' +
      'file-transfer/fs-inspect.ts, raisable only by the LM_FS_READ_MAX env var, never by a request ' +
      'arg. Also refuses secret files. Not the arbitrary-read hole it looked like.',
  },
  mission_neighbors: { measuredBytes: 26267, budgetBytes: 37000, bound: 'CALLER_LIMIT_SANE_DEFAULT', verdict: 'NEEDS-CAP', note: 'Depth arg; full records per neighbour.' },
  memory_file: { measuredBytes: 16760, budgetBytes: 25000, bound: 'NOTHING', verdict: 'NEEDS-CAP', note: 'Whole memory file; bounded only by the file on disk.' },
  mission_history: { measuredBytes: 13661, budgetBytes: 25000, bound: 'CALLER_LIMIT_SANE_DEFAULT', verdict: 'SAFE' },
  terminal_capture: { measuredBytes: 6279, budgetBytes: 25000, bound: 'HARD_LIMIT', verdict: 'SAFE', note: 'One pane of terminal text.' },
  backlog_get: {
    measuredBytes: 5860, budgetBytes: 25000, bound: 'NOTHING', verdict: 'NEEDS-CAP',
    note: 'MEASURED SMALL, STRUCTURALLY THE WORST COMPOUNDING CASE on the surface — and the ' +
      'clearest example of a SAFE rating that is an accident of which item got sampled. ' +
      'backlog.routes.ts reads it with includeHistory:true, and each OverlayChange embeds a FULL ' +
      'post-change state snapshot (doc-model.ts `state: S`), capped at 20 revs. So one call can ' +
      'return the current item PLUS 20 complete copies of its prior states, each carrying ' +
      'discussion (<=200 notes x 4000 chars) and reviews (<=100 x 4000). An item with an active ' +
      'discussion revised 20x is 300KB+; at the caps it is multi-MB. Unlike mission_list this IS ' +
      'full-state-per-rev, not diffs.',
  },
  mission_workflow_get: { measuredBytes: 5127, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  detail: { measuredBytes: 1119, budgetBytes: 25000, bound: 'PAGINATED', verdict: 'SAFE' },
  mission_workflow_history: { measuredBytes: 715, budgetBytes: 25000, bound: 'CALLER_LIMIT_SANE_DEFAULT', verdict: 'SAFE' },
  session_dag: { measuredBytes: 2213, budgetBytes: 25000, bound: 'NOTHING', verdict: 'SAFE' },
  data_search: { measuredBytes: 108, budgetBytes: 25000, bound: 'CALLER_LIMIT_SANE_DEFAULT', verdict: 'SAFE' },
  data_query: {
    measuredBytes: 65856, budgetBytes: 92000, bound: 'PAGINATED', verdict: 'NEEDS-CAP',
    note: 'PRE-PAGING 962,799 B on the `knowledge` dataset (997 records x ~966 B summarised) — it ' +
      'TRUNCATED at the ceiling and its schema offered no way to ask for less, the only true dead ' +
      'end on the surface. Fixed in three places because one was not enough (bl_47b5c8d8): ' +
      'top-level limit/offset with a 25 default at the MCP layer; a MAX_QUERY_ROWS ceiling in ' +
      'DataService.query so the REST path and the natively-paging sql backend are bounded too; and ' +
      'coercion of a numeric-STRING limit, which the relay sends and which made ' +
      'slice(offset, offset+limit) CONCATENATE (10 + "50" = "1050" -> 1,040 rows). ' +
      'Remeasure after deploy; datasets are user-extensible so this budget bounds the TOOL, not the data.',
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
 * Read-only tools that the guard cannot safely auto-measure (they need a target
 * id or a live peer) but that are KNOWN UNBOUNDED when called without arguments.
 *
 * These are the audit's blind spot made explicit. They sit in `NOT_MEASURED`
 * because no id can be synthesised for them, which means an empirical sweep says
 * nothing about them — and "not measured" reads as "fine" unless it is written
 * down. Each returns a full transcript on a plain call.
 *
 * All three are now backstopped by the central 64 KiB ceiling, so they can no
 * longer kill a conversation; they will simply truncate. They are listed so the
 * follow-up work (a sane default, not just a cap) has a target.
 */
export const UNBOUNDED_BY_DEFAULT_UNMEASURED: Record<string, string> = {
  get_execution:
    'Merges the agent execution\'s FULL result text into the status object; grows with whatever the agent produced. No limit argument at all.',
  ccr_cloud_read:
    'The sneakiest of the three: its description implies `last_n` bounds the read, but there is NO default — omit it and the whole cloud-session transcript is returned.',
  mission_session_read:
    '`lastN` is undefined when omitted and forwarded as such, so a plain call returns the full session transcript. The route clamps to [1,2000] only when a value is supplied.',
};

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

/**
 * Tools observed hitting the enforced ceiling and being TRUNCATED, that expose
 * NO argument a caller could use to ask for less.
 *
 * This pairs a fact from each side of the guardrail. The truncation marker tells
 * the model, correctly, to "narrow the call instead of repeating it — pass this
 * tool's paging/filter arguments (limit / offset / cursor / status / since)".
 * But a tool whose input schema is `{node}` has no such argument, so the only
 * advice the marker can give is advice the caller cannot follow, and repeating
 * the call returns the same prefix forever.
 *
 * The cap still does its job — the conversation survives, which is the point.
 * These are the tools where it degrades into a dead end rather than a nudge, and
 * they are therefore the remaining projection/pagination work.
 *
 * This is a RATCHET, not a permanent excuse: the guard fails if a tool truncates
 * and is neither narrowable nor listed here, so a new one cannot appear quietly.
 * Entries should be DELETED as narrowing arguments are added, never appended to
 * out of convenience.
 */
export const TRUNCATING_WITHOUT_NARROWING: Record<string, string> = {
  // EMPTY, and that is the point — every tool observed truncating now exposes a way
  // to ask for less, so the marker's advice is always followable.
  //
  //   - data_query   (bl_47b5c8d8) took top-level limit/offset with a 25-row default;
  //                  the hard row ceiling moved into DataService.query so the REST path
  //                  and every backend are bounded too. 962,799 B -> a bounded page.
  //   - mission_workflow_list  gained detail/limit/offset + a body projection and now
  //                  measures 13,498 B, so it no longer truncates at all.
  //
  // Do not append here to make a failing guard pass. An entry is an admission that a
  // tool truncates into a dead end; the fix is a paging/filter argument.
};

/**
 * Argument names that let a caller ask for less. Used by the guard to decide
 * whether a truncating tool leaves its caller a way forward.
 */
export const NARROWING_ARG_PATTERN = /^(limit|offset|cursor|page|pageSize|max|maxBytes|count|lastN|depth|since|sinceRev|sinceTs|status|detail|before|after)$/i;

/** The marker `result-cap.ts` injects when it truncates. Detected, never parsed. */
export const TRUNCATION_MARKER = 'RESULT TRUNCATED';
