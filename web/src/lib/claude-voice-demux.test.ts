import { describe, it, expect } from 'vitest';
import { demuxMessageSse, initialDemuxAcc } from './claude-voice-demux';

describe('demuxMessageSse — message_sse sub-events', () => {
  it('message_start sets the live per-turn model', () => {
    const acc = demuxMessageSse(
      { type: 'message_sse', event: { type: 'message_start', data: { message: { model: 'claude-opus-4-8' } } } },
      initialDemuxAcc,
    );
    expect(acc.liveModel).toBe('claude-opus-4-8');
  });

  it('content_block_delta text_delta appends to assistantText', () => {
    const acc = demuxMessageSse(
      { type: 'message_sse', event: { type: 'content_block_delta', data: { delta: { type: 'text_delta', text: 'hi' } } } },
      initialDemuxAcc,
    );
    expect(acc.assistantText).toContain('hi');
  });

  it('accumulates assistantText across multiple text_delta events', () => {
    let acc = initialDemuxAcc;
    acc = demuxMessageSse({ type: 'message_sse', event: { type: 'content_block_delta', data: { delta: { type: 'text_delta', text: 'hel' } } } }, acc);
    acc = demuxMessageSse({ type: 'message_sse', event: { type: 'content_block_delta', data: { delta: { type: 'text_delta', text: 'lo' } } } }, acc);
    expect(acc.assistantText).toBe('hello');
  });

  it('a fresh message_start resets assistantText for the new turn', () => {
    let acc = demuxMessageSse({ type: 'message_sse', event: { type: 'content_block_delta', data: { delta: { type: 'text_delta', text: 'first turn' } } } }, initialDemuxAcc);
    expect(acc.assistantText).toBe('first turn');
    acc = demuxMessageSse({ type: 'message_sse', event: { type: 'message_start', data: { message: { model: 'claude-sonnet-5' } } } }, acc);
    expect(acc.assistantText).toBe('');
    expect(acc.liveModel).toBe('claude-sonnet-5');
  });

  it('a tool_use content_block_start lands in passthrough without throwing', () => {
    const frame = {
      type: 'message_sse',
      event: { type: 'content_block_start', data: { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'web_search' } } },
    };
    expect(() => demuxMessageSse(frame, initialDemuxAcc)).not.toThrow();
    const acc = demuxMessageSse(frame, initialDemuxAcc);
    expect(acc.passthrough).toHaveLength(1);
    expect(acc.passthrough[0]).toEqual(frame.event);
  });

  it('a plain text content_block_start is a no-op (not pushed to passthrough)', () => {
    const acc = demuxMessageSse(
      { type: 'message_sse', event: { type: 'content_block_start', data: { content_block: { type: 'text' } } } },
      initialDemuxAcc,
    );
    expect(acc.passthrough).toHaveLength(0);
  });

  it('connector_text content_block_start lands in passthrough', () => {
    const acc = demuxMessageSse(
      { type: 'message_sse', event: { type: 'content_block_start', data: { content_block: { type: 'connector_text' } } } },
      initialDemuxAcc,
    );
    expect(acc.passthrough).toHaveLength(1);
  });

  it('input_json_delta lands in passthrough, not assistantText', () => {
    const acc = demuxMessageSse(
      { type: 'message_sse', event: { type: 'content_block_delta', data: { delta: { type: 'input_json_delta', partial_json: '{"q":' } } } },
      initialDemuxAcc,
    );
    expect(acc.passthrough).toHaveLength(1);
    expect(acc.assistantText).toBe('');
  });

  it('message_delta and message_stop land in passthrough', () => {
    let acc = demuxMessageSse({ type: 'message_sse', event: { type: 'message_delta', data: {} } }, initialDemuxAcc);
    acc = demuxMessageSse({ type: 'message_sse', event: { type: 'message_stop', data: {} } }, acc);
    expect(acc.passthrough).toHaveLength(2);
  });
});

describe('demuxMessageSse — top-level voice-session frames', () => {
  it('transcript_interim sets the live transcript and listening state', () => {
    const acc = demuxMessageSse({ type: 'transcript_interim', text: 'hello' }, initialDemuxAcc);
    expect(acc.transcript).toContain('hello');
    expect(acc.state).toBe('listening');
  });

  it('a later transcript_interim REPLACES (not appends to) the prior partial', () => {
    let acc = demuxMessageSse({ type: 'transcript_interim', text: 'hel' }, initialDemuxAcc);
    acc = demuxMessageSse({ type: 'transcript_interim', text: 'hello there' }, acc);
    expect(acc.transcript).toBe('hello there');
  });

  it('transcription_start clears a stale transcript for the new utterance', () => {
    let acc = demuxMessageSse({ type: 'transcript_interim', text: 'old utterance' }, initialDemuxAcc);
    acc = demuxMessageSse({ type: 'transcription_start' }, acc);
    expect(acc.transcript).toBe('');
  });

  it('user_input_end -> thinking, playback_start -> speaking, playback_end -> listening', () => {
    let acc = demuxMessageSse({ type: 'user_input_end' }, initialDemuxAcc);
    expect(acc.state).toBe('thinking');
    acc = demuxMessageSse({ type: 'playback_start' }, acc);
    expect(acc.state).toBe('speaking');
    acc = demuxMessageSse({ type: 'playback_end' }, acc);
    expect(acc.state).toBe('listening');
  });

  it('reconnect_requested sets the reconnect state', () => {
    const acc = demuxMessageSse({ type: 'reconnect_requested' }, initialDemuxAcc);
    expect(acc.state).toBe('reconnect');
  });

  it('tts_word and session_server_initialized are safe no-ops', () => {
    const acc1 = demuxMessageSse({ type: 'tts_word', text: 'hi' }, initialDemuxAcc);
    expect(acc1).toEqual(initialDemuxAcc);
    const acc2 = demuxMessageSse({ type: 'session_server_initialized' }, initialDemuxAcc);
    expect(acc2).toEqual(initialDemuxAcc);
  });
});

describe('demuxMessageSse — robustness', () => {
  it('never mutates the input accumulator (pure)', () => {
    const acc = initialDemuxAcc;
    const snapshot = { ...acc };
    demuxMessageSse({ type: 'transcript_interim', text: 'x' }, acc);
    expect(acc).toEqual(snapshot);
  });

  it('does not throw on an unrecognized top-level frame type', () => {
    expect(() => demuxMessageSse({ type: 'some_future_frame', weird: true }, initialDemuxAcc)).not.toThrow();
  });

  it('does not throw on a malformed, null, or undefined frame', () => {
    expect(() => demuxMessageSse(null, initialDemuxAcc)).not.toThrow();
    expect(() => demuxMessageSse(undefined, initialDemuxAcc)).not.toThrow();
    expect(() => demuxMessageSse({ type: 'message_sse' }, initialDemuxAcc)).not.toThrow();
    expect(() => demuxMessageSse('not an object', initialDemuxAcc)).not.toThrow();
  });
});
