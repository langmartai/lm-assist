'use client';

import { Plug, Wrench } from 'lucide-react';
import { StatusDot } from '@/components/shared/StatusDot';
import type { ToolUseView } from '@/hooks/useClaudeVoice';

/** `ToolUseView.status` -> the shared `StatusDot` vocabulary (`StatusDot.tsx`) — `'done'`
 *  reads as a settled dot (`online`: static green), `'running'`/`'error'` map straight
 *  across (`running`: pulsing green: `error`: red). Same CSS (`.status-dot`, globals.css)
 *  the overlay's own status row already uses, just via the shared modifier classes instead
 *  of an inline color override (those states — running/done/error — have no need for the
 *  bespoke per-state colors the overlay's connecting/listening/etc. row does).
 */
const DOT_STATUS: Record<ToolUseView['status'], 'online' | 'running' | 'error'> = {
  running: 'running',
  done: 'online',
  error: 'error',
};

/**
 * One tool/connector call from the live voice turn (`useClaudeVoice`'s `tools`, sourced from
 * `claude-voice-demux.ts`'s `ToolUseView[]`). Mirrors `TranscriptMessage.tsx`'s `ToolCard`
 * visual language (bordered row, `--color-bg-elevated`, `--radius-md`) but flat — no
 * expand/collapse — a connector call is executed server-side by claude.ai (design §7), so
 * there's no raw input/result payload to drill into here, only identity + status.
 *
 * A built-in tool (`web_search`, …) shows just its name + status dot. A connector/MCP call
 * (`isConnector`) additionally surfaces its `integrationName` (+ `iconUrl` if the server
 * sent one) and `mcpServerUrl`, both on a subtle secondary line.
 */
export function ConnectorCard({ tool }: { tool: ToolUseView }) {
  const Icon = tool.isConnector ? Plug : Wrench;
  const iconColor = tool.status === 'error' ? 'var(--color-status-red)' : 'var(--color-accent)';
  const showMeta = tool.isConnector && (tool.integrationName || tool.mcpServerUrl);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        border: `1px solid ${tool.status === 'error' ? 'var(--color-status-red)' : 'var(--color-border-subtle)'}`,
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-bg-elevated)',
        padding: '7px 10px',
      }}
    >
      {tool.isConnector && tool.iconUrl ? (
        <img src={tool.iconUrl} alt="" width={14} height={14} style={{ borderRadius: 3, flexShrink: 0, objectFit: 'contain' }} />
      ) : (
        <Icon size={13} style={{ color: iconColor, flexShrink: 0 }} />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: 1 }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--color-text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {tool.name || 'tool'}
        </span>
        {showMeta && (
          <span
            style={{
              fontSize: 10.5,
              color: 'var(--color-text-tertiary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {tool.integrationName}
            {tool.integrationName && tool.mcpServerUrl ? ' · ' : ''}
            {tool.mcpServerUrl && <span style={{ fontFamily: 'var(--font-mono)' }}>{tool.mcpServerUrl}</span>}
          </span>
        )}
      </div>

      <StatusDot status={DOT_STATUS[tool.status]} />
    </div>
  );
}
