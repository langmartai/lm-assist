'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ExternalLink, Pin, X, GripVertical,
  Terminal, Loader2, Circle, Play, Copy, Check,
} from 'lucide-react';
import type { ConsoleInstance, GroupColor } from './types';
import { GROUP_COLOR_MAP } from './types';
import { useConsoleDashboardStore } from '@/stores/consoleDashboardStore';
import { useAppMode } from '@/contexts/AppModeContext';
import { useMachineContext } from '@/contexts/MachineContext';

// ============================================================================
// Helpers
// ============================================================================

function getProjectName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

// ============================================================================
// Props
// ============================================================================

export interface ConsolePanelProps {
  console: ConsoleInstance;
  isFocused: boolean;
  isMinimized: boolean;
  isGroupMode: boolean;
  isSelectedForGroup: boolean;
  groupColor?: GroupColor;
  compact?: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function ConsolePanel({
  console: con,
  isFocused,
  isMinimized,
  isGroupMode,
  isSelectedForGroup,
  groupColor,
  compact = false,
}: ConsolePanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [containerReady, setContainerReady] = useState(false);

  const {
    setFocusedConsole,
    closeConsole,
    restoreConsole,
    toggleGroupSelection,
    togglePinConsole,
    pinnedConsoleIds,
    updateConsole,
    layout,
  } = useConsoleDashboardStore();

  const { apiClient, proxy } = useAppMode();
  const { selectedMachineId } = useMachineContext();

  const [ttydStarting, setTtydStarting] = useState(false);
  const [ttydError, setTtydError] = useState<string | null>(null);
  const startedRef = useRef<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Build session detail URL for link/copy
  const sessionDetailUrl = `${proxy.basePath || ''}/sessions?session=${con.sessionId}`;

  const handleCopySessionUrl = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const fullUrl = `${window.location.origin}${sessionDetailUrl}`;
    navigator.clipboard.writeText(fullUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [sessionDetailUrl]);

  const handleClickSessionLink = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(sessionDetailUrl, '_blank');
  }, [sessionDetailUrl]);

  useEffect(() => {
    if (con.ttydUrl) {
      setTtydStarting(false);
      setTtydError(null);
    } else if (con.isRunning && !con.isTmux && !ttydError) {
      setTtydStarting(true);
    }
  }, [con.ttydUrl, con.isRunning, con.isTmux, ttydError]);

  // Defer iframe loading until the container has settled to its final layout
  // dimensions. Without this, right-side panels in split layout get wrong
  // initial terminal size because the nested flex hasn't fully computed yet.
  useEffect(() => {
    if (containerReady || !con.ttydUrl) return;
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        setContainerReady(true);
        ro.disconnect();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [con.ttydUrl, containerReady]);

  // Reset containerReady when ttydUrl changes (new terminal connection)
  useEffect(() => {
    setContainerReady(false);
    setIframeLoaded(false);
  }, [con.ttydUrl]);

  // Scrollbar CSS is now injected at the ttyd proxy level (ttyd-proxy.ts)
  // since iframe is cross-origin and contentDocument access is blocked
  const handleIframeLoad = useCallback(() => {
    setIframeLoaded(true);
  }, []);

  const handleStartTerminal = useCallback(() => {
    if (ttydStarting) return;
    setTtydStarting(true);
    setTtydError(null);
    startedRef.current = con.sessionId;

    // For tmux sessions, pass existingTmuxSession/connectPid to attach instead of creating new
    const tmuxOptions = con.isTmux
      ? { existingTmuxSession: con.tmuxSessionName, connectPid: con.pid }
      : undefined;

    apiClient.startTerminal(con.sessionId, con.projectPath, selectedMachineId || undefined, tmuxOptions)
      .then(({ consoleUrl }) => {
        if (consoleUrl) {
          updateConsole(con.id, { ttydUrl: consoleUrl });
        }
      })
      .catch((err: any) => {
        setTtydError(err.message || 'Failed to start terminal');
      })
      .finally(() => {
        setTtydStarting(false);
      });
  }, [con.sessionId, con.projectPath, con.id, con.isTmux, con.tmuxSessionName, con.pid, apiClient, selectedMachineId, updateConsole, ttydStarting]);

  const handleOpenNewTab = useCallback(() => {
    const params = new URLSearchParams({
      sessionId: con.sessionId,
      projectPath: con.projectPath,
    });
    // Include machineId for hub/proxy modes (needed by LangMartDesign console page)
    const mid = selectedMachineId || (proxy.isProxied ? proxy.machineId : null);
    if (mid) params.set('machineId', mid);
    window.open(`${proxy.basePath || ''}/console?${params.toString()}`, `terminal-${con.sessionId}`);
  }, [con.sessionId, con.projectPath, selectedMachineId, proxy]);

  const isPinned = pinnedConsoleIds.includes(con.id);

  const handleTogglePin = useCallback(() => {
    togglePinConsole(con.id);
  }, [con.id, togglePinConsole]);

  const handleRestore = useCallback(() => {
    restoreConsole(con.id);
  }, [con.id, restoreConsole]);

  const handleClose = useCallback(() => {
    closeConsole(con.id);
  }, [con.id, closeConsole]);

  const handlePanelClick = useCallback(() => {
    if (isGroupMode) {
      toggleGroupSelection(con.id);
      return;
    }
    if (!isFocused) {
      setFocusedConsole(con.id);
    }
  }, [isGroupMode, toggleGroupSelection, con.id, layout, isFocused, setFocusedConsole]);

  const colorStyles = groupColor ? GROUP_COLOR_MAP[groupColor] : null;

  // ── Minimized render ──────────────────────────────────────────────────

  if (isMinimized) {
    return (
      <div
        onClick={handleRestore}
        className={`
          flex items-center gap-2 px-3 py-1.5 rounded-md cursor-pointer
          transition-colors duration-150
          ${isSelectedForGroup ? 'ring-2 ring-emerald-400/60' : ''}
          ${colorStyles ? colorStyles.border : ''}
        `}
        style={{
          background: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border-default)',
        }}
      >
        <Terminal className="h-3 w-3" style={{ color: 'var(--color-status-green)', opacity: 0.7 }} />
        <span className="text-[11px] truncate max-w-[120px]" style={{ color: 'var(--color-text-primary)' }}>
          {con.title || getProjectName(con.projectPath)}
        </span>
        {con.isRunning && <Circle className="h-2 w-2 fill-emerald-400 text-emerald-400" />}
      </div>
    );
  }

  // ── Compact sidebar render ────────────────────────────────────────────

  if (compact) {
    return (
      <div
        onClick={handlePanelClick}
        className={`
          group flex flex-col rounded-md overflow-hidden cursor-pointer
          transition-all duration-200
          ${isSelectedForGroup ? 'ring-2 ring-emerald-400/60' : ''}
          ${colorStyles ? colorStyles.border + ' ' + colorStyles.bg : ''}
        `}
        style={{
          background: colorStyles ? undefined : 'var(--color-bg-surface)',
          border: isFocused
            ? '1px solid var(--color-status-green)'
            : '1px solid var(--color-border-default)',
        }}
      >
        {/* Compact title bar */}
        <div className="flex items-center gap-1.5 px-2 py-1.5" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
          <div className="relative shrink-0">
            {con.isRunning ? (
              <span className="flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
              </span>
            ) : (
              <span className="inline-flex rounded-full h-2 w-2" style={{ background: 'var(--color-text-tertiary)' }} />
            )}
          </div>

          <span className="text-[11px] font-medium truncate flex-1 min-w-0" style={{ color: 'var(--color-text-primary)' }}>
            {con.title || getProjectName(con.projectPath)}
          </span>

          <span className="text-[9px] shrink-0" style={{ color: 'var(--color-text-tertiary)' }}>{formatTimeAgo(con.lastActivity)}</span>

          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            <button title={isPinned ? 'Unpin' : 'Pin'} onClick={(e) => { e.stopPropagation(); handleTogglePin(); }}
              className="p-0.5 rounded" style={{ color: isPinned ? 'var(--color-status-green)' : 'var(--color-text-tertiary)' }}>
              <Pin className={`h-2.5 w-2.5 ${isPinned ? 'fill-current' : ''}`} />
            </button>
            <button title="New Tab" onClick={(e) => { e.stopPropagation(); handleOpenNewTab(); }}
              className="p-0.5 rounded" style={{ color: 'var(--color-text-tertiary)' }}>
              <ExternalLink className="h-2.5 w-2.5" />
            </button>
            <button title="Close" onClick={(e) => { e.stopPropagation(); handleClose(); }}
              className="p-0.5 rounded hover:text-red-400" style={{ color: 'var(--color-text-tertiary)' }}>
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        </div>

        {/* Compact console preview */}
        <div className="h-[120px] relative overflow-hidden" style={{ background: 'var(--color-bg-root)' }}>
          {con.ttydUrl ? (
            <>
              <iframe src={con.ttydUrl} className="w-full h-full border-0 pointer-events-none"
                title={`Terminal: ${con.title}`} tabIndex={-1} />
              <div className="absolute inset-0" />
            </>
          ) : ttydStarting ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--color-status-green)', opacity: 0.3 }} />
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <Terminal className="h-4 w-4" style={{ color: 'var(--color-text-tertiary)', opacity: 0.4 }} />
            </div>
          )}
        </div>

        {/* Compact info bar */}
        <div className="flex items-center gap-1 px-2 py-1" style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
          {con.model && (
            <span className="text-[8px] font-mono" style={{ color: 'var(--color-text-tertiary)' }}>{con.model}</span>
          )}
          {con.isTmux && (
            <span className="text-[7px] h-3 px-1 inline-flex items-center rounded border border-amber-500/30 text-amber-400/70">tmux</span>
          )}
          {groupColor && colorStyles && (
            <span className={`text-[8px] ${colorStyles.text}`}>grouped</span>
          )}
        </div>
      </div>
    );
  }

  // ── Full render ─────────────────────────────────────────────────────

  return (
    <div
      onClick={handlePanelClick}
      className={`
        group flex flex-col rounded-lg overflow-hidden
        transition-all duration-200
        ${isSelectedForGroup ? 'ring-2 ring-emerald-400/60' : ''}
        ${colorStyles ? colorStyles.border + ' ' + colorStyles.bg : ''}
        h-full
      `}
      style={{
        background: colorStyles ? undefined : 'var(--color-bg-root)',
        border: isFocused
          ? '1px solid var(--color-status-green)'
          : '1px solid var(--color-border-default)',
      }}
    >
      {/* ── Title bar ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 min-w-0"
        style={{ background: 'var(--color-bg-surface)', borderBottom: '1px solid var(--color-border-subtle)' }}>
        <GripVertical className="h-3 w-3 shrink-0 cursor-grab" style={{ color: 'var(--color-text-tertiary)', opacity: 0.5 }} />

        {/* Running indicator */}
        <div className="relative shrink-0">
          {con.isRunning ? (
            <span className="flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-400" />
            </span>
          ) : (
            <span className="inline-flex rounded-full h-2.5 w-2.5" style={{ background: 'var(--color-text-tertiary)' }} />
          )}
        </div>

        {/* Title - allow to shrink but not overflow */}
        <span className="text-[13px] font-semibold truncate min-w-0"
          style={{ color: 'var(--color-text-primary)' }}
          title={con.title || con.projectPath}>
          {con.title || getProjectName(con.projectPath)}
        </span>

        {/* Session ID link + copy */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={handleClickSessionLink}
            className="text-[9px] font-mono px-1.5 h-4 inline-flex items-center rounded hover:underline truncate max-w-[100px]"
            style={{ color: 'var(--color-accent)', opacity: 0.7 }}
            title={`Open session ${con.sessionId}`}
          >
            {con.sessionId.slice(0, 8)}
          </button>
          <button
            onClick={handleCopySessionUrl}
            className="h-5 w-5 inline-flex items-center justify-center rounded transition-colors"
            style={{ color: copied ? 'var(--color-status-green)' : 'var(--color-text-tertiary)' }}
            title="Copy session URL"
          >
            {copied ? <Check className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
          </button>
        </div>

        <span className="flex-1 min-w-0" />

        {/* Model badge */}
        {con.model && (
          <span className="text-[9px] h-4 px-1.5 inline-flex items-center rounded shrink-0"
            style={{ border: '1px solid var(--color-border-default)', color: 'var(--color-text-secondary)' }}>
            {con.model}
          </span>
        )}

        {/* Time */}
        <span className="text-[10px] shrink-0" style={{ color: 'var(--color-text-tertiary)' }}>
          {formatTimeAgo(con.lastActivity)}
        </span>

        {/* tmux badge */}
        {con.isTmux && (
          <span className="text-[8px] h-4 px-1 inline-flex items-center rounded border border-amber-500/30 text-amber-400/80 shrink-0">
            tmux
          </span>
        )}

        {/* ── Toolbar buttons ─────────────────────────────────────── */}
        <div className="flex items-center gap-1 ml-1 shrink-0">
          <button title="Open in new tab"
            className={`inline-flex items-center justify-center gap-1.5 rounded transition-all duration-200 ${
              isFocused
                ? 'h-7 px-3 bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30'
                : 'h-6 px-2 hover:bg-white/5'
            }`}
            style={isFocused ? undefined : { color: 'var(--color-text-tertiary)' }}
            onClick={(e) => { e.stopPropagation(); handleOpenNewTab(); }}>
            <ExternalLink className={isFocused ? 'h-3.5 w-3.5' : 'h-3 w-3'} />
            {isFocused && <span className="text-[10px] font-medium">Web</span>}
          </button>
          <button title={isPinned ? 'Unpin position' : 'Pin position'}
            className="h-6 w-6 inline-flex items-center justify-center rounded"
            style={{ color: isPinned ? 'var(--color-status-green)' : 'var(--color-text-tertiary)' }}
            onClick={(e) => { e.stopPropagation(); handleTogglePin(); }}>
            <Pin className={`h-3 w-3 ${isPinned ? 'fill-current' : ''}`} />
          </button>
          <button title="Close console"
            className="h-6 w-6 inline-flex items-center justify-center rounded hover:text-red-400"
            style={{ color: 'var(--color-text-tertiary)' }}
            onClick={(e) => { e.stopPropagation(); handleClose(); }}>
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* ── Console body ─────────────────────────────────────────────── */}
      <div ref={bodyRef} className="flex-1 relative min-h-0 overflow-hidden" style={{ background: 'var(--color-bg-root)' }}>
        {con.ttydUrl && containerReady ? (
          <>
            {!iframeLoaded && (
              <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
                <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--color-status-green)', opacity: 0.5 }} />
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={con.ttydUrl}
              className={`w-full h-full border-0 transition-opacity duration-300 ${iframeLoaded ? 'opacity-100' : 'opacity-0'}`}
              title={`Terminal: ${con.title}`}
              onLoad={handleIframeLoad}
              allow="clipboard-read; clipboard-write"
            />
          </>
        ) : con.ttydUrl && !containerReady ? (
          <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
            <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--color-status-green)', opacity: 0.5 }} />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            {ttydStarting ? (
              <>
                <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--color-status-green)', opacity: 0.5 }} />
                <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>Starting terminal...</span>
              </>
            ) : ttydError ? (
              <>
                <Terminal className="h-8 w-8 text-red-500/30" />
                <span className="text-[11px] text-red-400/70">{ttydError}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleStartTerminal(); }}
                  className="mt-1 px-3 py-1 text-[10px] rounded transition-colors"
                  style={{ background: 'var(--color-bg-hover)', color: 'var(--color-text-primary)' }}>
                  Retry
                </button>
              </>
            ) : con.isTmux ? (
              <>
                <Terminal className="h-8 w-8" style={{ color: 'var(--color-text-tertiary)', opacity: 0.3 }} />
                <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>External tmux session</span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleStartTerminal(); }}
                  className="mt-1 flex items-center gap-1.5 px-3 py-1.5 text-[10px] rounded bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 border border-amber-500/20 transition-colors">
                  <Play className="h-3 w-3" />
                  Attach
                </button>
                <span className="text-[9px] font-mono" style={{ color: 'var(--color-text-tertiary)', opacity: 0.6 }}>
                  {con.tmuxSessionName || con.sessionId.slice(0, 12)}
                </span>
              </>
            ) : con.isRunning ? (
              <>
                <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--color-status-green)', opacity: 0.3 }} />
                <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>Connecting...</span>
              </>
            ) : (
              <>
                <Terminal className="h-8 w-8" style={{ color: 'var(--color-text-tertiary)', opacity: 0.3 }} />
                <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>No active terminal</span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleStartTerminal(); }}
                  className="mt-1 flex items-center gap-1.5 px-3 py-1.5 text-[10px] rounded bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 border border-emerald-500/20 transition-colors">
                  <Play className="h-3 w-3" />
                  Start Terminal
                </button>
                <span className="text-[9px] font-mono" style={{ color: 'var(--color-text-tertiary)', opacity: 0.5 }}>{con.sessionId.slice(0, 12)}</span>
              </>
            )}
          </div>
        )}

        {isGroupMode && (
          <div className={`absolute inset-0 cursor-pointer transition-colors ${
            isSelectedForGroup ? 'bg-emerald-400/10' : 'bg-transparent hover:bg-emerald-400/5'
          }`} />
        )}
      </div>

      {/* ── Status bar ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-1 shrink-0"
        style={{ background: 'var(--color-bg-surface)', borderTop: '1px solid var(--color-border-subtle)' }}>
        <span className="text-[9px] font-mono truncate" style={{ color: 'var(--color-text-tertiary)' }}>{con.sessionId.slice(0, 16)}</span>
        <span className="flex-1" />
        {con.taskCount != null && con.taskCount > 0 && (
          <span className="text-[9px]" style={{ color: 'var(--color-text-tertiary)' }}>{con.taskCount} tasks</span>
        )}
        {con.costUsd != null && con.costUsd > 0 && (
          <span className="text-[9px]" style={{ color: 'var(--color-text-tertiary)' }}>${con.costUsd.toFixed(3)}</span>
        )}
        {con.isRunning && (
          <span className="flex items-center gap-1 text-[9px] text-emerald-400">
            <Circle className="h-1.5 w-1.5 fill-current" />
            live
          </span>
        )}
      </div>
    </div>
  );
}
