// Pure demux for the claude.ai bidirectional voice v2 protocol — the testable core of
// `useClaudeVoice` (web/src/hooks/useClaudeVoice.ts). By the time a JSON frame reaches
// `demuxMessageSse`, the hook has already peeled off Core's OWN relay-control frames
// (`ready` / `reconnect` / `error`, synthesized by claude-voice-relay.ts's
// `mapPageStatus()`) — everything else on the wire is claude.ai's own protocol, forwarded
// verbatim, and lands here. Two frame families share that channel:
//
//   1. Top-level voice-session frames: `transcript_interim`, `transcription_start`,
//      `user_input_end`, `playback_start`, `playback_end`, `tts_word`, `message_complete`,
//      `session_server_initialized`, `reconnect_requested`.
//   2. `message_sse` — claude.ai's `/completion` SSE re-muxed one-JSON-frame-per-SSE-event
//      as `{type:'message_sse', event:{type, data}}` (`message_start`, `content_block_start`,
//      `content_block_delta`, `message_delta`, `message_stop`, …).
//
// The agentic/connector loop lives inside family 2. Plan A (this file's original version)
// left it as an opaque `passthrough` log. Plan B Task 2 (this file) classifies the
// connector-relevant sub-events into typed fields instead: a `tool_use` content block
// becomes a `ToolUseView` in `tools` — flagged `isConnector` for an MCP/connector call vs a
// built-in like `web_search` — and, if it also carries `approval_key`/`approval_options`,
// an `ApprovalReq` in `pendingApprovals`; a `connector_text` block's text lands in
// `connectorTexts`; `mcp_auth_required`/`mcp_elicitation` land in `mcpAuth`. Everything
// still unclassified (`input_json_delta`, `content_block_stop`'s raw event, `message_delta`,
// `message_stop`, and any future sub-event) keeps flowing into `passthrough` verbatim, per
// the same "never lose a frame" rule. Task 3 (the hook) and Task 5 (the overlay) consume
// the typed fields; nothing reads `passthrough` yet.

/** Voice session UI state. `idle`/`connecting`/`error` are hook-driven (connection
 *  lifecycle); `listening`/`thinking`/`speaking`/`reconnect` are protocol-driven, set by
 *  `demuxMessageSse` below. */
export type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'reconnect' | 'error';

/** The three in-band approval choices the voice protocol offers (Once / For this chat /
 *  Always) — echoed back as `approval_option` in the approval-reply frame (Task 3). */
export type ApprovalOption = 'once' | 'perChat' | 'always';

/** One `tool_use` content block, classified. A built-in (e.g. `web_search`) has
 *  `isConnector:false` and no integration metadata. An MCP/connector call is executed
 *  SERVER-SIDE — claude.ai holds the MCP connection (design §7) — so this is a view for
 *  rendering only; lm-assist never runs `input` itself. */
export interface ToolUseView {
  id: string;
  name: string;
  input: unknown;
  isConnector: boolean;
  integrationName?: string;
  mcpServerUrl?: string;
  iconUrl?: string;
  status: 'running' | 'done' | 'error';
}

/** An in-band approval request — a `tool_use` block that also carried `approval_key` +
 *  `approval_options`. `options` is whichever of the three known choices the server
 *  actually offered. `approve()`/`denyApproval()` (Task 3) reply keyed on `approvalKey`. */
export interface ApprovalReq {
  toolUseId: string;
  approvalKey: string;
  options: ApprovalOption[];
  name: string;
  integrationName?: string;
}

/** A connector needs authorization/elicitation before it can run (`mcp_auth_required` /
 *  `mcp_elicitation`). v1 is informational only (design §7) — the overlay surfaces a
 *  notice; the actual auth flow happens on claude.ai, not in lm-assist. */
export interface McpAuthReq {
  serverUrl?: string;
  integrationName?: string;
  message?: string;
}

/** Accumulator threaded through `demuxMessageSse` — one per voice session. */
export interface DemuxAcc {
  /** Live speech-to-text for the CURRENT user utterance. Each `transcript_interim` REPLACES
   *  it (ASR revises earlier words in an interim result, so appending would pile up
   *  garbage); `transcription_start` clears it for the next utterance. */
  transcript: string;
  /** Assistant reply text for the CURRENT turn, built by appending `text_delta` chunks;
   *  reset to '' on the next `message_start` (a new turn). */
  assistantText: string;
  /** The authoritative per-turn model from the last `message_start.message.model` — claude.ai
   *  may not run the exact model requested at connect, so this is ground truth, not an echo. */
  liveModel: string | null;
  state: VoiceState;
  /** Tool/connector calls seen this session, in call order. A tool's `status` starts
   *  `'running'` and flips to `'done'` on its `content_block_stop` (matched by Anthropic's
   *  content-block `index` — the same envelope claude.ai's `/completion` SSE re-mux uses;
   *  see `demuxSseEvent`'s `content_block_stop` case). */
  tools: ToolUseView[];
  /** Connector output text chunks (`connector_text` blocks), in arrival order. */
  connectorTexts: string[];
  /** Approval prompts awaiting a user choice; `approve`/`denyApproval` (Task 3) remove the
   *  matching entry once answered. */
  pendingApprovals: ApprovalReq[];
  /** Connector auth/elicitation notices awaiting resolution (v1: informational display only). */
  mcpAuth: McpAuthReq[];
  /** Everything from `message_sse` not yet classified above (`input_json_delta`, the raw
   *  `content_block_stop` event, `message_delta`, `message_stop`, and any future sub-event)
   *  — the raw forward-compat log; nothing is ever dropped. */
  passthrough: unknown[];
}

export const initialDemuxAcc: DemuxAcc = {
  transcript: '',
  assistantText: '',
  liveModel: null,
  state: 'idle',
  tools: [],
  connectorTexts: [],
  pendingApprovals: [],
  mcpAuth: [],
  passthrough: [],
};

/** The `tool_use` (or `connector_text`) shape nested at `event.data.content_block` on a
 *  `content_block_start`. A connector/MCP call populates `integration_name` / `is_mcp_app` /
 *  `mcp_server_url` / `approval_key` / `approval_options`; a built-in tool (e.g.
 *  `web_search`) leaves them unset. Recovered schema (plan doc + design §7); `is_mcp_app`
 *  independently corroborated by the text-chat connector flow (`buildConnectorToolsArray`,
 *  CHANGELOG 2026-06-21), pending Task 1's live capture of a populated voice example. */
interface ContentBlockPayload {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  integration_name?: string;
  integration_icon_url?: string;
  approval_key?: string;
  approval_options?: unknown;
  is_mcp_app?: boolean;
  mcp_server_url?: string;
  connector_text?: string;
  text?: string;
  [k: string]: unknown;
}

interface SseEvent {
  type?: string;
  data?: {
    index?: number;
    message?: { model?: string };
    delta?: { type?: string; text?: string };
    content_block?: ContentBlockPayload;
    [k: string]: unknown;
  };
}

/**
 * Reduce one JSON voice frame into the accumulator. Pure — never mutates `acc`, always
 * returns a fresh object; call as `setAcc(prev => demuxMessageSse(frame, prev))`. Never
 * throws: a malformed frame, an unrecognized `type`, or a malformed `message_sse.event`
 * all fall through to returning `acc` unchanged (or, for `message_sse`, pushing the raw
 * event to `passthrough` — see `demuxSseEvent`).
 */
export function demuxMessageSse(frame: unknown, acc: DemuxAcc): DemuxAcc {
  if (!frame || typeof frame !== 'object') return acc;
  const f = frame as { type?: string; text?: string; event?: SseEvent };

  if (f.type === 'message_sse') return demuxSseEvent(f.event, acc);

  switch (f.type) {
    case 'transcript_interim':
      return { ...acc, transcript: typeof f.text === 'string' ? f.text : acc.transcript, state: 'listening' };
    case 'transcription_start':
      // A fresh user utterance begins — drop the previous one's leftover text.
      return { ...acc, transcript: '', state: 'listening' };
    case 'user_input_end':
      return { ...acc, state: 'thinking' };
    case 'playback_start':
      return { ...acc, state: 'speaking' };
    case 'playback_end':
    case 'message_complete':
      // Continuous-stream architecture (no client VAD/gate) — the turn is over, back to
      // listening for the next one.
      return { ...acc, state: 'listening' };
    case 'reconnect_requested':
      // claude.ai's own advance notice — distinct from Core's synthesized {type:'reconnect'}
      // (mapped from the page relay's 4008-idle detection), but the same UI treatment.
      return { ...acc, state: 'reconnect' };
    case 'tts_word':
    case 'session_server_initialized':
      // Informational only: no DemuxAcc field tracks word-level TTS sync, and Core normally
      // consumes session_server_initialized itself (translates it to {type:'ready'} before
      // it ever reaches the user WS) — a stray one here is a safe no-op either way.
      return acc;
    default:
      // Forward-compat: an unrecognized top-level frame. Never drop it silently onto the
      // floor with a crash, but this bucket (unlike message_sse's) has no consumer yet.
      return acc;
  }
}

/** `true` when a `tool_use` content block is an MCP/connector call rather than a built-in —
 *  populated `is_mcp_app`/`mcp_server_url`, or a `name` that looks like an MCP tool
 *  (`mcp_*` / containing `:`), per the recovered schema. */
function isConnectorToolUse(block: ContentBlockPayload): boolean {
  if (block.is_mcp_app) return true;
  if (typeof block.mcp_server_url === 'string' && block.mcp_server_url.length > 0) return true;
  const name = typeof block.name === 'string' ? block.name : '';
  return name.startsWith('mcp_') || name.includes(':');
}

function isApprovalOption(v: unknown): v is ApprovalOption {
  return v === 'once' || v === 'perChat' || v === 'always';
}

function toToolUseView(block: ContentBlockPayload): ToolUseView {
  return {
    id: typeof block.id === 'string' ? block.id : '',
    name: typeof block.name === 'string' ? block.name : '',
    input: block.input,
    isConnector: isConnectorToolUse(block),
    integrationName: typeof block.integration_name === 'string' ? block.integration_name : undefined,
    mcpServerUrl: typeof block.mcp_server_url === 'string' ? block.mcp_server_url : undefined,
    iconUrl: typeof block.integration_icon_url === 'string' ? block.integration_icon_url : undefined,
    status: 'running',
  };
}

/** `null` unless the block carries BOTH `approval_key` and an `approval_options` array —
 *  the two fields the approval prompt (Task 5) and `approve()`/`denyApproval()` (Task 3)
 *  need. Unrecognized option values are dropped rather than failing the whole request. */
function toApprovalReq(block: ContentBlockPayload): ApprovalReq | null {
  if (typeof block.approval_key !== 'string') return null;
  if (!Array.isArray(block.approval_options)) return null;
  return {
    toolUseId: typeof block.id === 'string' ? block.id : '',
    approvalKey: block.approval_key,
    options: block.approval_options.filter(isApprovalOption),
    name: typeof block.name === 'string' ? block.name : '',
    integrationName: typeof block.integration_name === 'string' ? block.integration_name : undefined,
  };
}

/** `ToolUseView` plus the Anthropic content-block `index` it opened at — runtime-only
 *  bookkeeping, NOT part of the public `ToolUseView` contract Task 3/5 read. A
 *  `content_block_stop` carries only `index`, not the tool's `id`, so this is how it gets
 *  matched back to the right entry in `acc.tools` to flip `status` to `'done'`. */
type TrackedToolUseView = ToolUseView & { blockIndex?: number };

/** `message_sse` sub-event handling — claude.ai's `/completion` SSE, one frame per event. */
function demuxSseEvent(event: SseEvent | undefined, acc: DemuxAcc): DemuxAcc {
  if (!event || typeof event !== 'object') return acc;
  const data = event.data;

  switch (event.type) {
    case 'message_start': {
      const model = data?.message?.model;
      // A new assistant turn starts — its text is built fresh (the prior turn's text
      // belongs to the surrounding chat transcript, not this live-turn accumulator).
      return { ...acc, liveModel: typeof model === 'string' ? model : acc.liveModel, assistantText: '' };
    }
    case 'content_block_delta':
      if (data?.delta?.type === 'text_delta') {
        return { ...acc, assistantText: acc.assistantText + (typeof data.delta.text === 'string' ? data.delta.text : '') };
      }
      // input_json_delta (streamed tool-call arguments): not accumulated into a tool's
      // `input` yet — left in passthrough until a task needs the fully-assembled input
      // mid-stream rather than at content_block_start.
      return { ...acc, passthrough: [...acc.passthrough, event] };
    case 'content_block_start': {
      const block = data?.content_block;
      if (block?.type === 'text') return acc; // no new information — see module header
      if (block?.type === 'tool_use') {
        const tool: TrackedToolUseView = { ...toToolUseView(block), blockIndex: data?.index };
        const approval = toApprovalReq(block);
        return {
          ...acc,
          tools: [...acc.tools, tool],
          pendingApprovals: approval ? [...acc.pendingApprovals, approval] : acc.pendingApprovals,
        };
      }
      if (block?.type === 'connector_text') {
        const text =
          typeof block.connector_text === 'string' ? block.connector_text : typeof block.text === 'string' ? block.text : '';
        return { ...acc, connectorTexts: [...acc.connectorTexts, text] };
      }
      // Forward-compat: a missing/unclassified content_block type.
      return { ...acc, passthrough: [...acc.passthrough, event] };
    }
    case 'content_block_stop': {
      // Flip the matching tool (by content-block index — content_block_stop carries no id)
      // from 'running' to 'done'. Still logged to passthrough like message_delta/
      // message_stop below; this is a side classification, not a replacement for it.
      const idx = data?.index;
      const tools =
        typeof idx === 'number'
          ? acc.tools.map((t) => {
              const tracked = t as TrackedToolUseView;
              return tracked.blockIndex === idx && tracked.status === 'running'
                ? ({ ...tracked, status: 'done' } as TrackedToolUseView)
                : tracked;
            })
          : acc.tools;
      return { ...acc, tools, passthrough: [...acc.passthrough, event] };
    }
    case 'mcp_auth_required':
    case 'mcp_elicitation': {
      // Envelope unconfirmed (Task 1's residual protocol gap) — read defensively by field
      // name rather than trusting a declared interface for this one event family.
      const raw = (data ?? {}) as Record<string, unknown>;
      const req: McpAuthReq = {
        serverUrl: typeof raw.mcp_server_url === 'string' ? raw.mcp_server_url : undefined,
        integrationName: typeof raw.integration_name === 'string' ? raw.integration_name : undefined,
        message: typeof raw.message === 'string' ? raw.message : undefined,
      };
      return { ...acc, mcpAuth: [...acc.mcpAuth, req] };
    }
    case 'message_delta':
    case 'message_stop':
      return { ...acc, passthrough: [...acc.passthrough, event] };
    default:
      // Forward-compat: an SSE event type we don't know yet. Hand it to the same bucket
      // Plan B already reads from rather than dropping it — never throw either way.
      return { ...acc, passthrough: [...acc.passthrough, event] };
  }
}
