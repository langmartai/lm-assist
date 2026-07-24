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

  it('a built-in tool_use (no connector fields) classifies as a non-connector tool, not passthrough', () => {
    const frame = {
      type: 'message_sse',
      event: {
        type: 'content_block_start',
        data: { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: {} } },
      },
    };
    expect(() => demuxMessageSse(frame, initialDemuxAcc)).not.toThrow();
    const acc = demuxMessageSse(frame, initialDemuxAcc);
    expect(acc.tools).toHaveLength(1);
    expect(acc.tools[0].id).toBe('toolu_1');
    expect(acc.tools[0].name).toBe('web_search');
    expect(acc.tools[0].isConnector).toBe(false);
    expect(acc.tools[0].status).toBe('running');
    expect(acc.passthrough).toHaveLength(0);
  });

  it('a connector/MCP tool_use (is_mcp_app + mcp_server_url + integration_name) classifies as a connector tool', () => {
    const frame = {
      type: 'message_sse',
      event: {
        type: 'content_block_start',
        data: {
          index: 1,
          content_block: {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'mcp_google_drive_search',
            input: { query: 'Q4 roadmap' },
            integration_name: 'Google Drive',
            integration_icon_url: 'https://claude.ai/icons/gdrive.png',
            is_mcp_app: true,
            mcp_server_url: 'https://mcp.example.com/gdrive',
          },
        },
      },
    };
    const acc = demuxMessageSse(frame, initialDemuxAcc);
    expect(acc.tools).toHaveLength(1);
    expect(acc.tools[0].isConnector).toBe(true);
    expect(acc.tools[0].integrationName).toBe('Google Drive');
    expect(acc.tools[0].mcpServerUrl).toBe('https://mcp.example.com/gdrive');
    expect(acc.tools[0].iconUrl).toBe('https://claude.ai/icons/gdrive.png');
    expect(acc.pendingApprovals).toHaveLength(0);
  });

  it('a name-based connector (starts with mcp_ or contains ":") classifies as a connector even without is_mcp_app/mcp_server_url', () => {
    const acc1 = demuxMessageSse(
      { type: 'message_sse', event: { type: 'content_block_start', data: { content_block: { type: 'tool_use', id: 't1', name: 'mcp_notion_search' } } } },
      initialDemuxAcc,
    );
    expect(acc1.tools[0].isConnector).toBe(true);

    const acc2 = demuxMessageSse(
      { type: 'message_sse', event: { type: 'content_block_start', data: { content_block: { type: 'tool_use', id: 't2', name: 'notion:search' } } } },
      initialDemuxAcc,
    );
    expect(acc2.tools[0].isConnector).toBe(true);
  });

  it('a tool_use carrying approval_key + approval_options populates pendingApprovals (and still renders as a tool)', () => {
    const frame = {
      type: 'message_sse',
      event: {
        type: 'content_block_start',
        data: {
          index: 1,
          content_block: {
            type: 'tool_use',
            id: 'toolu_3',
            name: 'mcp_google_drive_search',
            integration_name: 'Google Drive',
            approval_key: 'appr_abc123',
            approval_options: ['once', 'perChat', 'always'],
          },
        },
      },
    };
    const acc = demuxMessageSse(frame, initialDemuxAcc);
    expect(acc.pendingApprovals).toHaveLength(1);
    expect(acc.pendingApprovals[0]).toEqual({
      toolUseId: 'toolu_3',
      approvalKey: 'appr_abc123',
      options: ['once', 'perChat', 'always'],
      name: 'mcp_google_drive_search',
      integrationName: 'Google Drive',
    });
    expect(acc.tools).toHaveLength(1);
  });

  it('approval_options entries outside the known enum are dropped, not thrown on', () => {
    const acc = demuxMessageSse(
      {
        type: 'message_sse',
        event: {
          type: 'content_block_start',
          data: { content_block: { type: 'tool_use', id: 't4', name: 'mcp_x', approval_key: 'k1', approval_options: ['once', 'bogus', 42] } },
        },
      },
      initialDemuxAcc,
    );
    expect(acc.pendingApprovals[0].options).toEqual(['once']);
  });

  it('content_block_stop flips the matching tool (by block index) from running to done', () => {
    let acc = demuxMessageSse(
      { type: 'message_sse', event: { type: 'content_block_start', data: { index: 2, content_block: { type: 'tool_use', id: 'toolu_4', name: 'web_search' } } } },
      initialDemuxAcc,
    );
    expect(acc.tools[0].status).toBe('running');
    acc = demuxMessageSse({ type: 'message_sse', event: { type: 'content_block_stop', data: { index: 2 } } }, acc);
    expect(acc.tools[0].status).toBe('done');
    // still logged, like message_delta/message_stop below — a side classification, not a
    // replacement for the raw log.
    expect(acc.passthrough).toHaveLength(1);
  });

  it('content_block_stop for an unrelated index leaves tool status unchanged', () => {
    let acc = demuxMessageSse(
      { type: 'message_sse', event: { type: 'content_block_start', data: { index: 2, content_block: { type: 'tool_use', id: 'toolu_5', name: 'web_search' } } } },
      initialDemuxAcc,
    );
    acc = demuxMessageSse({ type: 'message_sse', event: { type: 'content_block_stop', data: { index: 9 } } }, acc);
    expect(acc.tools[0].status).toBe('running');
  });

  it('a plain text content_block_start is a no-op (not pushed to passthrough)', () => {
    const acc = demuxMessageSse(
      { type: 'message_sse', event: { type: 'content_block_start', data: { content_block: { type: 'text' } } } },
      initialDemuxAcc,
    );
    expect(acc.passthrough).toHaveLength(0);
  });

  it('a connector_text content_block appends its text to connectorTexts, not passthrough', () => {
    const acc = demuxMessageSse(
      {
        type: 'message_sse',
        event: { type: 'content_block_start', data: { content_block: { type: 'connector_text', connector_text: 'Found 3 files matching "Q4 roadmap".' } } },
      },
      initialDemuxAcc,
    );
    expect(acc.connectorTexts).toEqual(['Found 3 files matching "Q4 roadmap".']);
    expect(acc.passthrough).toHaveLength(0);
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

  it('mcp_auth_required populates mcpAuth', () => {
    const acc = demuxMessageSse(
      {
        type: 'message_sse',
        event: {
          type: 'mcp_auth_required',
          data: { integration_name: 'Google Drive', mcp_server_url: 'https://mcp.example.com/gdrive', message: 'Google Drive needs authorization.' },
        },
      },
      initialDemuxAcc,
    );
    expect(acc.mcpAuth).toHaveLength(1);
    expect(acc.mcpAuth[0]).toEqual({
      integrationName: 'Google Drive',
      serverUrl: 'https://mcp.example.com/gdrive',
      message: 'Google Drive needs authorization.',
    });
  });

  it('mcp_elicitation also populates mcpAuth', () => {
    const acc = demuxMessageSse(
      { type: 'message_sse', event: { type: 'mcp_elicitation', data: { integration_name: 'Notion' } } },
      initialDemuxAcc,
    );
    expect(acc.mcpAuth).toHaveLength(1);
    expect(acc.mcpAuth[0].integrationName).toBe('Notion');
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
