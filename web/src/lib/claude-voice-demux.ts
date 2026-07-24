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
// The agentic/connector loop (`tool_use` / `connector_text` content blocks,
// `input_json_delta`, `message_delta`, `message_stop`) is out of scope here — Plan B. Those
// sub-events are pushed verbatim onto `acc.passthrough` so nothing is lost and nothing
// throws; a future connector UI (or Task 10's overlay, in the interim) reads them from there.

/** Voice session UI state. `idle`/`connecting`/`error` are hook-driven (connection
 *  lifecycle); `listening`/`thinking`/`speaking`/`reconnect` are protocol-driven, set by
 *  `demuxMessageSse` below. */
export type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'reconnect' | 'error';

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
  /** Non-text `message_sse` sub-events (tool_use / connector_text content blocks,
   *  input_json_delta, message_delta, message_stop) — Plan B's input. Never interpreted here. */
  passthrough: unknown[];
}

export const initialDemuxAcc: DemuxAcc = {
  transcript: '',
  assistantText: '',
  liveModel: null,
  state: 'idle',
  passthrough: [],
};

interface SseEvent {
  type?: string;
  data?: {
    message?: { model?: string };
    delta?: { type?: string; text?: string };
    content_block?: { type?: string };
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
      // input_json_delta (streamed tool-call arguments) — Plan B.
      return { ...acc, passthrough: [...acc.passthrough, event] };
    case 'content_block_start':
      // Every text block opens with one of these before its text_deltas stream in — it
      // carries no new information, so it's a no-op. A non-text block (tool_use,
      // connector_text, or anything future) is the start of the agentic/connector loop.
      if (data?.content_block?.type === 'text') return acc;
      return { ...acc, passthrough: [...acc.passthrough, event] };
    case 'message_delta':
    case 'message_stop':
      return { ...acc, passthrough: [...acc.passthrough, event] };
    default:
      // Forward-compat: an SSE event type we don't know yet. Hand it to the same bucket
      // Plan B already reads from rather than dropping it — never throw either way.
      return { ...acc, passthrough: [...acc.passthrough, event] };
  }
}
