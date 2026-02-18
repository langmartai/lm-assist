'use client';

import { useCallback, useRef, useState } from 'react';
import {
  Terminal, Play, Square, ExternalLink, Loader2, Maximize2, Minimize2, Copy, Check,
  RefreshCw, User, Bot, Wrench, Cpu, ListChecks, Pin, PinOff, X
} from 'lucide-react';
import { CompactMessageFeed, inlineMarkdown } from './CompactMessageFeed';
import type { ConvType } from './CompactMessageFeed';
import type { Session, SessionDetail, SessionMessage } from '@/lib/types';
import { formatTimeAgo, formatBytes, getModelShortName, getSessionIdShort } from '@/lib/utils';
import { MachineBadge } from '@/components/shared/MachineBadge';
import { useAppMode } from '@/contexts/AppModeContext';

// ============================================================================
// Types
// ============================================================================

export interface TerminalPanelProps {
  session: Session;
  detail: SessionDetail | null;
  isLoading: boolean;
  showTypes: Record<ConvType, boolean>;
  isExpanded: boolean;
  autoExpanded: boolean;
  autoScroll: boolean;
  onToggleExpand: () => void;
  onConnect: () => void;
  onStop: () => void;
  isConnecting: boolean;
  isRunning: boolean;
  hasExpandedSibling: boolean;
  isRecentlyUpdated?: boolean;
  isVisible?: boolean;
  isSingleMachine?: boolean;
  layoutMode?: string;
  /** Max messages to display in the feed. Default: 50 */
  messageLimit?: number;
}

// ============================================================================
// Component
// ============================================================================

export function TerminalPanel({
  session,
  detail,
  isLoading,
  showTypes,
  isExpanded,
  autoExpanded,
  autoScroll,
  onToggleExpand,
  onConnect,
  onStop,
  isConnecting,
  isRunning,
  hasExpandedSibling,
  isRecentlyUpdated = false,
  isVisible = false,
  isSingleMachine = true,
  layoutMode = 'grid',
  messageLimit = 50,
}: TerminalPanelProps) {

  const handleConnectClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onConnect();
  }, [onConnect]);

  const handleStopClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onStop();
  }, [onStop]);

  const { isLocal, proxy } = useAppMode();

  const handleExpandClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleExpand();
  }, [onToggleExpand]);

  // Tooltip state for header text items
  const [headerTooltip, setHeaderTooltip] = useState<{ text: string; x: number; y: number; rowTop: number; pinned?: boolean } | null>(null);
  const [headerTooltipCopied, setHeaderTooltipCopied] = useState(false);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showTooltip = useCallback((text: string, el: HTMLElement) => {
    if (!text || headerTooltip?.pinned) return;
    // If a tooltip is already showing and fading out, don't replace it
    if (headerTooltip && tooltipTimerRef.current) return;
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    const rect = el.getBoundingClientRect();
    setHeaderTooltip({ text, x: rect.left, y: rect.bottom + 4, rowTop: rect.top });
    setHeaderTooltipCopied(false);
  }, [headerTooltip?.pinned, headerTooltip]);

  const hideTooltip = useCallback(() => {
    if (headerTooltip?.pinned) return;
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    tooltipTimerRef.current = setTimeout(() => setHeaderTooltip(null), 1000);
  }, [headerTooltip?.pinned]);

  const handleHeaderTooltipEnter = useCallback(() => {
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
  }, []);

  const handleHeaderTooltipLeave = useCallback(() => {
    if (headerTooltip?.pinned) return;
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    tooltipTimerRef.current = setTimeout(() => setHeaderTooltip(null), 1000);
  }, [headerTooltip?.pinned]);

  const handleHeaderTooltipPin = useCallback(() => {
    setHeaderTooltip(prev => prev ? { ...prev, pinned: !prev.pinned } : null);
  }, []);

  const handleHeaderTooltipCopy = useCallback(() => {
    if (!headerTooltip) return;
    navigator.clipboard.writeText(headerTooltip.text);
    setHeaderTooltipCopied(true);
    setTimeout(() => setHeaderTooltipCopied(false), 1500);
  }, [headerTooltip]);

  const handleHeaderTooltipClose = useCallback(() => {
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    setHeaderTooltip(null);
    setHeaderTooltipCopied(false);
  }, []);

  // Only extract messages when visible and detail is loaded
  const messages: SessionMessage[] = isVisible && detail?.messages ? detail.messages : [];

  const effectiveExpanded = isExpanded || autoExpanded;

  // Panel height — 3x2 / 2col modes fill their grid cell
  const gridFill = layoutMode === '3x2' || layoutMode === '2col';
  const height = gridFill
    ? '100%'
    : isExpanded
      ? '60vh'
      : autoExpanded
        ? 500
        : hasExpandedSibling
          ? 140
          : 300;

  // Stats — derive from messages when available, fall back to session-level counts
  const turns = detail?.numTurns ?? session.numTurns ?? 0;
  const prompts = session.userPromptCount ?? messages.filter(m => m.type === 'human').length;
  const assistantCount = messages.filter(m => m.type === 'assistant' && m.subtype !== 'tool_use').length;
  const tools = messages.filter(m => m.type === 'assistant' && m.subtype === 'tool_use').length;
  const taskCount = detail?.tasks?.length ?? session.taskCount ?? 0;
  const model = detail?.model || session.model;
  const modelShort = model ? getModelShortName(model) : null;

  // Last user prompt text
  const lastPromptText = (() => {
    if (messages.length > 0) {
      const lastHuman = [...messages].reverse().find(m => m.type === 'human');
      if (lastHuman) return typeof lastHuman.content === 'string' ? lastHuman.content : '';
    }
    return session.lastUserMessage || '';
  })();

  return (
    <div
      data-session-id={session.sessionId}
      className={`card terminal-panel ${isRecentlyUpdated ? 'terminal-panel-updated' : ''}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        height,
        transition: 'height 0.2s ease-in-out',
        ...(isExpanded ? { outline: '2px solid rgba(232, 190, 100, 0.4)', outlineOffset: 1, gridColumn: '1 / -1' } : {}),
      }}
    >
      {/* Header */}
      <div style={{
        padding: '6px 12px',
        borderBottom: '1px solid var(--color-border-subtle)',
        flexShrink: 0,
        background: 'var(--color-bg-elevated)',
      }}>
        {/* Row 1: Session info */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Running indicator */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            {isRunning ? (
              <span style={{ display: 'flex', width: 10, height: 10 }}>
                <span className="terminal-ping" style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: '50%',
                  background: 'rgba(74, 222, 128, 0.6)',
                }} />
                <span style={{
                  position: 'relative',
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: '#4ade80',
                }} />
              </span>
            ) : (
              <span style={{ display: 'inline-flex', width: 10, height: 10, borderRadius: '50%', background: '#6b7280' }} />
            )}
          </div>

          {/* Project name */}
          <span
            className="truncate"
            style={{ fontWeight: 500, fontSize: 13 }}
            onMouseEnter={(e) => showTooltip(session.projectPath || '', e.currentTarget)}
            onMouseLeave={hideTooltip}
          >
            {session.projectName || 'Session'}
          </span>

          {/* File size */}
          {session.size !== undefined && session.size > 0 && (
            <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
              {formatBytes(session.size)}
            </span>
          )}

          {/* Model badge */}
          {modelShort && (
            <span className="badge badge-default" style={{ fontSize: 9, flexShrink: 0 }}>
              {modelShort}
            </span>
          )}

          {/* Session ID + copy button */}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
            <a
              href={`${proxy.basePath || ''}/sessions?session=${session.sessionId}${!isLocal && session.machineId ? `&machine=${session.machineId}` : ''}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{
                fontSize: 10,
                color: 'var(--color-text-tertiary)',
                fontFamily: 'var(--font-mono)',
                textDecoration: 'none',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-accent)'; e.currentTarget.style.textDecoration = 'underline'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-tertiary)'; e.currentTarget.style.textDecoration = 'none'; }}
            >
              {getSessionIdShort(session.sessionId)}
            </a>
            <CopyIdButton sessionId={session.sessionId} />
          </span>

          {/* Status badge */}
          {detail?.status && (
            <span className="badge" style={{
              fontSize: 9,
              flexShrink: 0,
              background: detail.status === 'running' ? 'rgba(74, 222, 128, 0.2)' :
                detail.status === 'active' ? 'rgba(96, 165, 250, 0.2)' : 'rgba(255,255,255,0.06)',
              color: detail.status === 'running' ? '#4ade80' :
                detail.status === 'active' ? '#60a5fa' : 'var(--color-text-tertiary)',
            }}>
              {detail.status}
            </span>
          )}

          {/* Machine badge (only shown in multi-machine mode) */}
          {!isSingleMachine && (
            <MachineBadge
              hostname={session.machineHostname}
              platform={session.machinePlatform}
              status={session.machineStatus}
            />
          )}

          {/* Time ago */}
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginLeft: 'auto', flexShrink: 0 }}>
            {formatTimeAgo(session.lastModified)}
          </span>

          {/* Expand/collapse button */}
          <button
            className="btn btn-sm btn-ghost"
            onClick={handleExpandClick}
            title={isExpanded ? 'Collapse' : 'Expand'}
            style={{ height: 20, width: 20, padding: 0, flexShrink: 0 }}
          >
            {isExpanded ? (
              <Minimize2 size={14} style={{ color: 'var(--color-text-tertiary)' }} />
            ) : (
              <Maximize2 size={14} style={{ color: 'var(--color-text-tertiary)' }} />
            )}
          </button>
        </div>

        {/* Last user prompt subtitle */}
        {lastPromptText && (
          <div
            className="truncate"
            style={{
              fontSize: 11,
              color: 'rgba(96, 165, 250, 0.8)',
              marginTop: 2,
              paddingLeft: 18,
              fontStyle: 'italic',
            }}
            onMouseEnter={(e) => showTooltip(lastPromptText, e.currentTarget)}
            onMouseLeave={hideTooltip}
          >
            {lastPromptText}
          </div>
        )}

        {/* Row 2: Action buttons + stats */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
          {isRunning ? (
            <>
              <button
                className="btn btn-sm btn-secondary"
                onClick={handleConnectClick}
                disabled={isConnecting}
                style={{ height: 20, padding: '0 8px', fontSize: 10, gap: 4 }}
              >
                {isConnecting ? (
                  <><Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Opening...</>
                ) : (
                  <><ExternalLink size={12} /> Reconnect</>
                )}
              </button>
              <button
                className="btn btn-sm btn-destructive"
                onClick={handleStopClick}
                style={{ height: 20, padding: '0 8px', fontSize: 10, gap: 4 }}
              >
                <Square size={12} /> Stop
              </button>
            </>
          ) : (
            <button
              className="btn btn-sm btn-primary"
              onClick={handleConnectClick}
              disabled={isConnecting}
              style={{ height: 20, padding: '0 8px', fontSize: 10, gap: 4 }}
            >
              {isConnecting ? (
                <><Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Connecting...</>
              ) : (
                <><Play size={12} /> Connect</>
              )}
            </button>
          )}

          {/* Stats row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', fontSize: 9, color: 'var(--color-text-tertiary)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }} title="Turns">
              <RefreshCw size={10} />{turns}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'rgba(96, 165, 250, 0.8)' }} title="User prompts">
              <User size={10} />{prompts}
            </span>
            {assistantCount > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'rgba(167, 139, 250, 0.7)' }} title="Assistant responses">
                <Bot size={10} />{assistantCount}
              </span>
            )}
            {tools > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'rgba(156, 163, 175, 0.7)' }} title="Tool uses">
                <Wrench size={10} />{tools}
              </span>
            )}
            {(session.agentCount ?? 0) > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'rgba(34, 211, 238, 0.7)' }} title="Agents">
                <Cpu size={10} />{session.agentCount}
              </span>
            )}
            {taskCount > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'rgba(129, 140, 248, 0.7)' }} title="Tasks">
                <ListChecks size={10} />{taskCount}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Message feed */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {!isVisible ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-tertiary)', opacity: 0.4 }}>
            <span style={{ fontSize: 10 }}>Scroll into view to load</span>
          </div>
        ) : isLoading && !detail ? (
          <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ height: 16, background: 'var(--color-bg-hover)', borderRadius: 4, animation: 'pulse 2s infinite' }} />
            <div style={{ height: 16, width: '75%', background: 'var(--color-bg-hover)', borderRadius: 4, animation: 'pulse 2s infinite' }} />
            <div style={{ height: 16, width: '85%', background: 'var(--color-bg-hover)', borderRadius: 4, animation: 'pulse 2s infinite' }} />
          </div>
        ) : messages.length === 0 ? (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-tertiary)' }}>
            <Terminal size={24} style={{ opacity: 0.2, marginBottom: 8 }} />
            <span style={{ fontSize: 11 }}>Loading messages...</span>
          </div>
        ) : (
          <CompactMessageFeed
            messages={messages}
            showTypes={showTypes}
            isExpanded={effectiveExpanded}
            autoScroll={autoScroll}
            className="h-full"
            messageLimit={messageLimit}
          />
        )}
      </div>

      {/* Header tooltip (fixed position to escape overflow:hidden) */}
      {headerTooltip && (() => {
        const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
        const spaceBelow = vh - headerTooltip.y;
        const flipUp = spaceBelow < 200;
        const left = Math.max(8, Math.min(headerTooltip.x, vw - 24));
        const top = flipUp ? undefined : Math.max(8, headerTooltip.y);
        const bottom = flipUp ? Math.max(8, vh - headerTooltip.rowTop + 4) : undefined;
        const maxH = flipUp
          ? `calc(100vh - ${Math.max(8, vh - headerTooltip.rowTop + 4) + 16}px)`
          : `calc(100vh - ${Math.max(8, headerTooltip.y) + 16}px)`;
        return (
        <div
          onMouseEnter={handleHeaderTooltipEnter}
          onMouseLeave={handleHeaderTooltipLeave}
          className="terminal-grid-scroll"
          style={{
            position: 'fixed',
            left,
            top,
            bottom,
            maxWidth: `calc(100vw - ${left + 16}px)`,
            maxHeight: maxH,
            zIndex: 9999,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '8px 12px',
            paddingTop: 4,
            fontSize: 11,
            lineHeight: 1.5,
            color: '#e2e8f0',
            background: 'rgba(15, 23, 42, 0.96)',
            border: `1px solid ${headerTooltip.pinned ? 'rgba(250, 204, 21, 0.4)' : 'rgba(148, 163, 184, 0.2)'}`,
            borderRadius: 6,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            wordBreak: 'break-word',
          }}
        >
          {/* Toolbar */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 2, marginBottom: 4, position: 'sticky', top: 0 }}>
            <button
              onClick={handleHeaderTooltipCopy}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 4, padding: '2px 6px', cursor: 'pointer',
                color: headerTooltipCopied ? '#4ade80' : '#94a3b8', fontSize: 10,
              }}
            >
              {headerTooltipCopied ? <><Check size={10} /> Copied</> : <><Copy size={10} /> Copy</>}
            </button>
            <button
              onClick={handleHeaderTooltipPin}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                background: headerTooltip.pinned ? 'rgba(250, 204, 21, 0.15)' : 'rgba(255,255,255,0.06)',
                border: `1px solid ${headerTooltip.pinned ? 'rgba(250, 204, 21, 0.3)' : 'rgba(255,255,255,0.1)'}`,
                borderRadius: 4, padding: '2px 6px', cursor: 'pointer',
                color: headerTooltip.pinned ? '#facc15' : '#94a3b8', fontSize: 10,
              }}
            >
              {headerTooltip.pinned ? <><PinOff size={10} /> Unpin</> : <><Pin size={10} /> Pin</>}
            </button>
            {headerTooltip.pinned && (
              <button
                onClick={handleHeaderTooltipClose}
                style={{
                  display: 'inline-flex', alignItems: 'center',
                  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 4, padding: '2px 4px', cursor: 'pointer',
                  color: '#94a3b8', fontSize: 10,
                }}
              >
                <X size={10} />
              </button>
            )}
          </div>
          {/* Content */}
          {headerTooltip.text.split('\n').map((line, i) => (
            <div key={i} style={{ minHeight: 16 }}>{inlineMarkdown(line)}</div>
          ))}
        </div>
        );
      })()}
    </div>
  );
}

function CopyIdButton({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(sessionId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [sessionId]);

  return (
    <button
      onClick={handleCopy}
      style={{
        height: 14,
        width: 14,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--color-text-tertiary)',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        opacity: 0.6,
      }}
      title="Copy session ID"
    >
      {copied ? (
        <Check size={10} style={{ color: '#4ade80' }} />
      ) : (
        <Copy size={10} />
      )}
    </button>
  );
}

export default TerminalPanel;
