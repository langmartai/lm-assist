'use client';

import { Terminal } from 'lucide-react';

interface CommandInvocation {
  commandName: string;
  args?: string;
  turnIndex: number;
  lineIndex: number;
  timestamp?: string;
}

interface CommandTimelineProps {
  commands: CommandInvocation[];
}

// Deterministic color for a command name
const COMMAND_COLORS = [
  'var(--color-accent)',
  'var(--color-status-blue)',
  'var(--color-status-green)',
  'var(--color-status-purple)',
  'var(--color-status-cyan)',
  'var(--color-status-orange)',
  'var(--color-status-pink)',
];

function commandColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return COMMAND_COLORS[Math.abs(hash) % COMMAND_COLORS.length];
}

function relativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function CommandTimeline({ commands }: CommandTimelineProps) {
  if (commands.length === 0) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <Terminal size={32} style={{ color: 'var(--color-text-tertiary)', opacity: 0.5 }} />
        <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)', marginTop: 8 }}>
          No command invocations in this session
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header bar */}
      <div style={{
        padding: '8px 16px',
        borderBottom: '1px solid var(--color-border-default)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 11,
        color: 'var(--color-text-tertiary)',
      }}>
        <Terminal size={12} style={{ color: 'var(--color-accent)' }} />
        <span style={{ fontFamily: 'var(--font-mono)' }}>
          {commands.length} command{commands.length !== 1 ? 's' : ''}
        </span>

        {/* Unique command summary */}
        {commands.length >= 2 && (
          <>
            <div style={{ flex: 1 }} />
            <CommandChainFlow commands={commands} />
          </>
        )}
      </div>

      {/* Timeline */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 16px 16px 20px', position: 'relative' }} className="scrollbar-thin">
        {/* Vertical connector line */}
        <div style={{
          position: 'absolute',
          left: 29,
          top: 16,
          bottom: 16,
          width: 2,
          background: 'var(--color-border-default)',
          borderRadius: 1,
        }} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {commands.map((cmd, i) => {
            const color = commandColor(cmd.commandName);
            return (
              <div key={`${cmd.lineIndex}-${i}`} style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 14,
                position: 'relative',
              }}>
                {/* Node indicator */}
                <div style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: 'var(--color-bg-root)',
                  border: '2px solid var(--color-border-strong)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  zIndex: 1,
                  marginTop: 8,
                }}>
                  <div style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: color,
                  }} />
                </div>

                {/* Card */}
                <div
                  style={{
                    flex: 1,
                    padding: '10px 14px',
                    background: 'var(--color-bg-surface)',
                    border: '1px solid var(--color-border-default)',
                    borderLeft: `3px solid ${color}`,
                    borderRadius: 'var(--radius-md)',
                    transition: 'all 0.15s ease',
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border-strong)';
                    (e.currentTarget as HTMLElement).style.borderLeftColor = color;
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border-default)';
                    (e.currentTarget as HTMLElement).style.borderLeftColor = color;
                  }}
                >
                  {/* Command name */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{
                      fontSize: 13,
                      fontWeight: 600,
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--color-text-primary)',
                    }}>
                      {cmd.commandName}
                    </span>
                    {cmd.timestamp && (
                      <span style={{
                        fontSize: 10,
                        color: 'var(--color-text-tertiary)',
                        marginLeft: 'auto',
                      }}>
                        {relativeTime(cmd.timestamp)}
                      </span>
                    )}
                  </div>

                  {/* Args */}
                  {cmd.args && (
                    <div style={{
                      fontSize: 11,
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--color-status-orange)',
                      marginTop: 4,
                      lineHeight: '18px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxHeight: 18,
                    }}>
                      {cmd.args}
                    </div>
                  )}

                  {/* Line info badge */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                    <span className="badge badge-default" style={{ fontSize: 9, padding: '1px 6px', fontFamily: 'var(--font-mono)' }}>
                      L{cmd.lineIndex}
                    </span>
                    <span className="badge badge-default" style={{ fontSize: 9, padding: '1px 6px', fontFamily: 'var(--font-mono)' }}>
                      T{cmd.turnIndex}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---- Chain Flow (horizontal connected pills) ----

function CommandChainFlow({ commands }: { commands: CommandInvocation[] }) {
  // Show unique commands as pills
  const unique = Array.from(new Set(commands.map(c => c.commandName)));
  if (unique.length === 0) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, overflow: 'hidden' }}>
      {unique.map((name, i) => {
        const count = commands.filter(c => c.commandName === name).length;
        return (
          <span key={name} style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
            {i > 0 && (
              <span style={{
                fontSize: 10,
                color: 'var(--color-text-tertiary)',
                margin: '0 3px',
                fontFamily: 'var(--font-mono)',
              }}>
                {'\u00b7'}
              </span>
            )}
            <span
              className="badge badge-amber"
              style={{ fontSize: 9, padding: '1px 6px' }}
            >
              {name}{count > 1 ? ` x${count}` : ''}
            </span>
          </span>
        );
      })}
    </div>
  );
}
