// Bounded client-tool policy for claude.ai's voice v2 connector/agentic loop (Plan B Task 4;
// docs/superpowers/plans/2026-07-24-bidirectional-voice-v2-connectors.md). Over the voice WS a
// `tool_use` block (see claude-voice-demux.ts's `ToolUseView`) falls into three buckets:
//
//   1. SERVER-executed — connector/MCP tools (`isConnector`, per the demux's `is_mcp_app`/
//      `mcp_server_url`/`mcp_*`-name detection) and the `web_search` built-in. claude.ai runs
//      these itself and streams the result; the client must send NO tool_result at all.
//   2. `ask_user_question` — a CLIENT-executed builtin lm-assist voice DOES support, but not
//      by answering it here: it's surfaced to the user via the overlay, so this reports it
//      unhandled (`surfaced:true`) rather than replying.
//   3. Every OTHER client-executed builtin (`memory_*`, `create_file`, `edit`, `open_file`,
//      `notebook_edit`, `bash`/`bash_tool`, `drive_search`, `conversation_search`,
//      `exit_plan_mode`, …) — these need a real claude.ai browser environment lm-assist voice
//      doesn't have. Left unanswered, the model just hangs waiting for a tool_result that will
//      never come, so this bucket gets an immediate error tool_result + turn_end instead,
//      bounded to exactly those two frames, so the model recovers rather than stalling.
//
// Pure — no WS/state access. `useClaudeVoice` sends the returned `frames` verbatim over the
// voice WS and decides how to act on `surfaced`.

import type { ToolUseView } from './claude-voice-demux';

export interface ClientToolResponse {
  /** true when this function fully answered the tool (the error tool_result in `frames`);
   *  false when the caller must NOT reply — either claude.ai answers it server-side
   *  (connector/web_search) or the overlay surfaces it for the user (ask_user_question). */
  handled: boolean;
  /** Only meaningful when `handled` is false: true means the caller should still surface this
   *  tool_use to the user (ask_user_question) rather than silently ignoring it. */
  surfaced?: boolean;
  /** Only present when `handled` is true — the frame(s) to send over the voice WS verbatim, in
   *  order: the error tool_result, then turn_end so the model resumes. */
  frames?: object[];
}

/** Verbatim per the plan doc's Task 4 (docs/superpowers/plans/2026-07-24-bidirectional-voice-v2-connectors.md). */
const UNSUPPORTED_TEXT = 'unsupported in lm-assist voice';

/** Decide how (if at all) the client should respond to one `tool_use` block. */
export function clientToolResponse(toolUse: ToolUseView): ClientToolResponse {
  // Connectors/MCP tools run server-side — claude.ai answers them itself.
  if (toolUse.isConnector) return { handled: false };
  // web_search is also server-executed: no connector fields, but the client still sends no
  // tool_result for it (same as a connector).
  if (toolUse.name === 'web_search') return { handled: false };
  // Surfaced, not answered here — the overlay renders the question for the user.
  if (toolUse.name === 'ask_user_question') return { handled: false, surfaced: true };

  return {
    handled: true,
    frames: [
      {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        name: toolUse.name,
        is_error: true,
        content: [{ type: 'text', text: UNSUPPORTED_TEXT }],
      },
      { type: 'turn_end' },
    ],
  };
}
