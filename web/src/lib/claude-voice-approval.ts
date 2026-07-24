// The in-band approval-reply frame builders for the voice v2 connector/MCP loop (Plan B
// Task 3). Pulled out as pure functions — the testable core of `useClaudeVoice`'s
// `approve()`/`denyApproval()` (web/src/hooks/useClaudeVoice.ts) — mirroring how
// `claude-voice-demux.ts` is the pure core for inbound frame handling.

import type { ApprovalOption } from './claude-voice-demux';

/** The approval-reply frame the real claude.ai voice client sends over the WS to answer a
 *  pending `tool_use` approval request (Once / For this chat / Always). Recovered shape
 *  (task-1's live capture deferred per the plan's own fallback clause; see
 *  planb-progress.md) — deliberately has NO `type` field: Core's relay
 *  (claude-voice-relay.ts, Plan A commit c2283cc) only special-cases `type:'connect'`/
 *  `type:'close'` on the user WS and forwards every other JSON frame to claude.ai verbatim,
 *  so this bare shape is what actually needs to reach the voice session. */
export interface ApprovalReplyFrame {
  tool_use_id: string;
  is_approved: boolean;
  approval_key: string;
  approval_option?: ApprovalOption;
}

/** Approve a pending tool_use/connector call with one of the three in-band choices. */
export function buildApprovalFrame(toolUseId: string, approvalKey: string, option: ApprovalOption): ApprovalReplyFrame {
  return { tool_use_id: toolUseId, is_approved: true, approval_key: approvalKey, approval_option: option };
}

/** Deny a pending tool_use/connector call. No `approval_option` — that field only scopes HOW
 *  an approval applies (once/perChat/always); a denial has no such scope. */
export function buildDenyFrame(toolUseId: string, approvalKey: string): ApprovalReplyFrame {
  return { tool_use_id: toolUseId, is_approved: false, approval_key: approvalKey };
}
