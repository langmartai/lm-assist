import { describe, it, expect } from 'vitest';
import { clientToolResponse } from './claude-voice-clienttools';
import type { ToolUseView } from './claude-voice-demux';

function tool(overrides: Partial<ToolUseView> = {}): ToolUseView {
  return { id: 'toolu_1', name: 'some_tool', input: {}, isConnector: false, status: 'running', ...overrides };
}

describe('clientToolResponse', () => {
  it('does not respond to a connector/MCP tool — claude.ai executes it server-side', () => {
    const resp = clientToolResponse(tool({ isConnector: true, name: 'mcp_google_drive_search', integrationName: 'Google Drive' }));
    expect(resp).toEqual({ handled: false });
  });

  it('does not respond to web_search — a server-executed built-in, not a client tool', () => {
    const resp = clientToolResponse(tool({ name: 'web_search' }));
    expect(resp).toEqual({ handled: false });
  });

  it('surfaces ask_user_question instead of answering it — the overlay handles it', () => {
    const resp = clientToolResponse(tool({ name: 'ask_user_question' }));
    expect(resp).toEqual({ handled: false, surfaced: true });
  });

  it('error-recovers an unknown client tool (memory_read) with an is_error tool_result + turn_end', () => {
    const resp = clientToolResponse(tool({ id: 'toolu_42', name: 'memory_read' }));
    expect(resp.handled).toBe(true);
    expect(resp.frames).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_42',
        name: 'memory_read',
        is_error: true,
        content: [{ type: 'text', text: 'unsupported in lm-assist voice' }],
      },
      { type: 'turn_end' },
    ]);
  });

  it.each(['create_file', 'edit', 'open_file', 'notebook_edit', 'bash', 'bash_tool', 'drive_search', 'conversation_search', 'exit_plan_mode'])(
    'error-recovers %s the same bounded way',
    (name) => {
      const resp = clientToolResponse(tool({ name }));
      expect(resp.handled).toBe(true);
      expect(resp.frames?.[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', name, is_error: true });
      expect(resp.frames?.[1]).toEqual({ type: 'turn_end' });
    },
  );
});
