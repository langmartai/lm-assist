'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSessionDashboard } from '@/hooks/useSessionDashboard';
import { useMultiSessionMonitor } from '@/hooks/useMultiSessionMonitor';
import { useAppMode } from '@/contexts/AppModeContext';
import { useMachineContext } from '@/contexts/MachineContext';
import { TerminalPanel, TerminalFilterBar } from '@/components/session-dashboard';
import type { ConvType, LayoutMode } from '@/components/session-dashboard';
import { Terminal } from 'lucide-react';
import type { Session } from '@/lib/types';

// ============================================================================
// Local Storage
// ============================================================================

const STORAGE_KEY_SHOW_TYPES = 'terminal-show-types';
const STORAGE_KEY_LAYOUT = 'terminal-layout';
const STORAGE_KEY_RUNNING_ONLY = 'terminal-running-only';
const STORAGE_KEY_AUTO_SCROLL = 'terminal-auto-scroll';

const DEFAULT_SHOW_TYPES: Record<ConvType, boolean> = {
  user: true,
  assistant: true,
  thinking: false,
  tools: true,
  todos: true,
  tasks: true,
  agents: true,
};

function loadFromStorage<T>(key: string, defaultValue: T): T {
  if (typeof window === 'undefined') return defaultValue;
  try {
    const stored = localStorage.getItem(key);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return defaultValue;
}

function saveToStorage<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* ignore */ }
}

// ============================================================================
// Page Component
// ============================================================================

export default function TerminalsPage() {
  const { apiClient, isLocal, proxy } = useAppMode();
  const { isSingleMachine, onlineMachines } = useMachineContext();

  // ─── State (persisted) ──────────────────────────────────────────────────

  const [showTypes, setShowTypes] = useState<Record<ConvType, boolean>>(DEFAULT_SHOW_TYPES);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('2col');
  const [showRunningOnly, setShowRunningOnly] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  // ─── State (UI) ─────────────────────────────────────────────────────────

  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [visibleSessionIds, setVisibleSessionIds] = useState<string[]>([]);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(new Set());

  // ─── Refs ───────────────────────────────────────────────────────────────

  const visibleSetRef = useRef<Set<string>>(new Set());
  const openTabsRef = useRef<Map<string, Window>>(new Map());
  const tabMonitorIntervalsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Cleanup tab monitoring intervals on unmount
  useEffect(() => {
    return () => {
      tabMonitorIntervalsRef.current.forEach(interval => clearInterval(interval));
      tabMonitorIntervalsRef.current.clear();
    };
  }, []);

  // ─── Load persisted state on mount ──────────────────────────────────────

  useEffect(() => {
    setShowTypes(loadFromStorage(STORAGE_KEY_SHOW_TYPES, DEFAULT_SHOW_TYPES));
    setLayoutMode(loadFromStorage(STORAGE_KEY_LAYOUT, '2col'));
    setShowRunningOnly(loadFromStorage(STORAGE_KEY_RUNNING_ONLY, false));
    setAutoScroll(loadFromStorage(STORAGE_KEY_AUTO_SCROLL, true));
  }, []);

  // ─── Data ───────────────────────────────────────────────────────────────

  const { availableSessions, isLoading, error, refetch } = useSessionDashboard();

  // ─── Running detection via ttyd processes ──────────────────────────────

  useEffect(() => {
    let cancelled = false;

    const checkRunning = async () => {
      try {
        const allSessionIds = new Set<string>();

        if (isLocal) {
          const status = await apiClient.getTerminalStatus();
          if (status.sessions) status.sessions.forEach(s => allSessionIds.add(s));
        } else {
          // Hub mode: check each online machine
          const results = await Promise.allSettled(
            onlineMachines.map(m => apiClient.getTerminalStatus(m.id))
          );
          for (const result of results) {
            if (result.status === 'fulfilled' && result.value.sessions) {
              result.value.sessions.forEach(s => allSessionIds.add(s));
            }
          }
        }

        if (!cancelled) {
          setRunningSessionIds(allSessionIds);
        }
      } catch {
        // Ignore — ttyd may not be available
      }
    };

    checkRunning();
    const interval = setInterval(checkRunning, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [apiClient, isLocal, onlineMachines]);

  // ─── Derived data ──────────────────────────────────────────────────────

  const filteredSessions = useMemo(() => {
    if (!showRunningOnly) return availableSessions;
    return availableSessions.filter(s => runningSessionIds.has(s.sessionId));
  }, [availableSessions, showRunningOnly, runningSessionIds]);

  // ─── Scroll-based visibility tracking ──────────────────────────────────

  const gridRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Estimate initial visible panel count from viewport size
  const initialVisibleCount = useMemo(() => {
    if (typeof window === 'undefined') return 9;
    const cols = Math.max(1, Math.floor((window.innerWidth - 280) / 430));
    const rows = Math.max(1, Math.ceil((window.innerHeight - 180) / 310));
    return cols * (rows + 1);
  }, []);

  // Set initial visible panels immediately
  useEffect(() => {
    if (filteredSessions.length === 0) return;
    const initial = filteredSessions.slice(0, initialVisibleCount).map(s => s.sessionId);
    visibleSetRef.current = new Set(initial);
    setVisibleSessionIds(initial);
  }, [filteredSessions, initialVisibleCount]);

  // Scroll handler: update visible panels based on scroll position
  useEffect(() => {
    const container = scrollContainerRef.current;
    const gridEl = gridRef.current;
    if (!container || !gridEl) return;

    const updateVisibility = () => {
      const containerRect = container.getBoundingClientRect();
      const viewTop = containerRect.top - 200;
      const viewBottom = containerRect.bottom + 200;

      const next = new Set<string>();
      const panels = gridEl.querySelectorAll('[data-session-id]');
      for (const el of panels) {
        const rect = el.getBoundingClientRect();
        if (rect.top > viewBottom) break;
        if (rect.bottom < viewTop) continue;
        const sid = (el as HTMLElement).dataset.sessionId;
        if (sid) next.add(sid);
      }

      const prev = visibleSetRef.current;
      if (next.size !== prev.size || ![...next].every(id => prev.has(id))) {
        visibleSetRef.current = next;
        setVisibleSessionIds(Array.from(next));
      }
    };

    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          updateVisibility();
          ticking = false;
        });
      }
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    const rafId = requestAnimationFrame(updateVisibility);

    return () => {
      container.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(rafId);
    };
  }, [filteredSessions]);

  // ─── Message limits based on layout mode ──────────────────────────────

  const messageLimit = useMemo(() => {
    switch (layoutMode) {
      case '2col': return 150;   // 2-column layout — tall panels
      case '3x2': return 100;   // Half-viewport tall panels
      case 'rows': return 80;   // Single column, moderate height
      case 'grid':
      default: return 50;       // Compact auto-fill grid
    }
  }, [layoutMode]);

  // ─── Multi-session monitor ─────────────────────────────────────────────

  const { sessionStates, isPolling, recentlyUpdatedIds, refreshAll } = useMultiSessionMonitor({
    sessions: filteredSessions,
    visibleSessionIds,
    activeInterval: 2000,
    inactiveInterval: 5000,
    enabled: filteredSessions.length > 0,
    messageLimit,
  });

  const autoExpanded = filteredSessions.length <= 3;

  // ─── Handlers ──────────────────────────────────────────────────────────

  const handleToggleType = useCallback((type: ConvType) => {
    setShowTypes(prev => {
      const next = { ...prev, [type]: !prev[type] };
      saveToStorage(STORAGE_KEY_SHOW_TYPES, next);
      return next;
    });
  }, []);

  const handleSetLayoutMode = useCallback((mode: LayoutMode) => {
    setLayoutMode(mode);
    saveToStorage(STORAGE_KEY_LAYOUT, mode);
  }, []);

  const handleToggleRunningOnly = useCallback(() => {
    setShowRunningOnly(prev => {
      const next = !prev;
      saveToStorage(STORAGE_KEY_RUNNING_ONLY, next);
      return next;
    });
  }, []);

  const handleToggleAutoScroll = useCallback(() => {
    setAutoScroll(prev => {
      const next = !prev;
      saveToStorage(STORAGE_KEY_AUTO_SCROLL, next);
      return next;
    });
  }, []);

  const handleToggleExpand = useCallback((sessionId: string) => {
    setExpandedSessionId(prev => prev === sessionId ? null : sessionId);
  }, []);

  const handleConnect = useCallback(async (session: Session) => {
    const isRunning = runningSessionIds.has(session.sessionId);

    // Build console wrapper URL — include machineId for hub/proxy mode
    const buildWrapperUrl = () => {
      const params = new URLSearchParams({
        sessionId: session.sessionId,
        projectPath: session.projectPath,
      });
      if (!isLocal && session.machineId) {
        params.set('machineId', session.machineId);
      }
      return `${proxy.basePath || ''}/console?${params.toString()}`;
    };

    if (isRunning) {
      // Already running - open tab directly
      const wrapperUrl = buildWrapperUrl();

      const existingTab = openTabsRef.current.get(session.sessionId);
      if (existingTab && !existingTab.closed) {
        existingTab.focus();
        return;
      }

      const newWindow = window.open(wrapperUrl, `terminal-${session.sessionId}`);
      if (newWindow) {
        openTabsRef.current.set(session.sessionId, newWindow);

        const existingInterval = tabMonitorIntervalsRef.current.get(session.sessionId);
        if (existingInterval) clearInterval(existingInterval);

        const checkClosed = setInterval(() => {
          if (newWindow.closed) {
            clearInterval(checkClosed);
            tabMonitorIntervalsRef.current.delete(session.sessionId);
            openTabsRef.current.delete(session.sessionId);
          }
        }, 1000);
        tabMonitorIntervalsRef.current.set(session.sessionId, checkClosed);
      }
    } else {
      // Start ttyd first
      setLaunchingId(session.sessionId);
      try {
        const machineId = isLocal ? undefined : session.machineId;
        const result = await apiClient.startTerminal(session.sessionId, session.projectPath, machineId);

        if (result.consoleUrl) {
          const wrapperUrl = buildWrapperUrl();
          const newWindow = window.open(wrapperUrl, `terminal-${session.sessionId}`);

          if (newWindow) {
            openTabsRef.current.set(session.sessionId, newWindow);

            const existingInterval = tabMonitorIntervalsRef.current.get(session.sessionId);
            if (existingInterval) clearInterval(existingInterval);

            const checkClosed = setInterval(() => {
              if (newWindow.closed) {
                clearInterval(checkClosed);
                tabMonitorIntervalsRef.current.delete(session.sessionId);
                openTabsRef.current.delete(session.sessionId);
                // Kill process when tab closes
                apiClient.killSessionProcesses(
                  session.sessionId,
                  isLocal ? undefined : session.machineId,
                ).catch(() => {});
              }
            }, 1000);
            tabMonitorIntervalsRef.current.set(session.sessionId, checkClosed);
          }
        }
      } catch (err) {
        console.error('Failed to start terminal:', err);
      } finally {
        setLaunchingId(null);
      }
    }
  }, [runningSessionIds, apiClient, isLocal]);

  const handleStop = useCallback((sessionId: string) => {
    // Clear monitoring interval
    const interval = tabMonitorIntervalsRef.current.get(sessionId);
    if (interval) {
      clearInterval(interval);
      tabMonitorIntervalsRef.current.delete(sessionId);
    }

    // Close tab if open
    const tab = openTabsRef.current.get(sessionId);
    if (tab && !tab.closed) {
      tab.close();
    }
    openTabsRef.current.delete(sessionId);

    // Optimistically remove from running set for immediate UI feedback
    setRunningSessionIds(prev => {
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });

    // Stop ttyd server + kill processes
    const session = availableSessions.find(s => s.sessionId === sessionId);
    const machineId = isLocal ? undefined : session?.machineId;
    apiClient.stopTerminal(sessionId, machineId).catch(() => {});
    apiClient.killSessionProcesses(sessionId, machineId).catch(() => {});
  }, [apiClient, isLocal, availableSessions]);

  const handleCloseAll = useCallback(() => {
    if (!confirm(`Stop all ${runningSessionIds.size} running terminals?`)) return;

    for (const sessionId of runningSessionIds) {
      handleStop(sessionId);
    }
  }, [runningSessionIds, handleStop]);

  const handleRefresh = useCallback(() => {
    refreshAll();
    refetch();
  }, [refreshAll, refetch]);

  // ─── Render ─────────────────────────────────────────────────────────────

  if (isLoading && availableSessions.length === 0) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'var(--color-text-tertiary)', animation: 'pulse 2s infinite' }}>Loading sessions...</div>
      </div>
    );
  }

  if (filteredSessions.length === 0) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        {/* Filter bar */}
        <TerminalFilterBar
          showTypes={showTypes}
          onToggleType={handleToggleType}
          layoutMode={layoutMode}
          onSetLayoutMode={handleSetLayoutMode}
          showRunningOnly={showRunningOnly}
          onToggleRunningOnly={handleToggleRunningOnly}
          autoScroll={autoScroll}
          onToggleAutoScroll={handleToggleAutoScroll}
          runningCount={runningSessionIds.size}
          totalCount={availableSessions.length}
          onCloseAll={handleCloseAll}
          onRefresh={handleRefresh}
          isRefreshing={isPolling}
        />

        {/* Empty state */}
        <div className="empty-state" style={{ flex: 1 }}>
          <Terminal size={36} className="empty-state-icon" />
          {showRunningOnly ? (
            <>
              <span style={{ fontSize: 13 }}>No running terminals</span>
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                {availableSessions.length} session{availableSessions.length !== 1 ? 's' : ''} available
              </span>
              <button
                style={{
                  fontSize: 11,
                  color: 'var(--color-accent)',
                  textDecoration: 'underline',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  marginTop: 4,
                }}
                onClick={() => setShowRunningOnly(false)}
              >
                Show all sessions
              </button>
            </>
          ) : (
            <>
              <span style={{ fontSize: 13 }}>No sessions found</span>
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                Start a Claude Code session to see it here
              </span>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Filter bar */}
      <TerminalFilterBar
        showTypes={showTypes}
        onToggleType={handleToggleType}
        layoutMode={layoutMode}
        onSetLayoutMode={handleSetLayoutMode}
        showRunningOnly={showRunningOnly}
        onToggleRunningOnly={handleToggleRunningOnly}
        autoScroll={autoScroll}
        onToggleAutoScroll={handleToggleAutoScroll}
        runningCount={runningSessionIds.size}
        totalCount={availableSessions.length}
        onCloseAll={handleCloseAll}
        onRefresh={handleRefresh}
        isRefreshing={isPolling}
      />

      {/* Panel grid */}
      <div ref={scrollContainerRef} className="terminal-grid-scroll" style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        <div
          ref={gridRef}
          style={
            layoutMode === 'grid' ? {
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))',
              gap: 12,
            }
            : layoutMode === '3x2' ? {
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gridAutoRows: 'calc(50vh - 40px)',
              gap: 10,
            }
            : layoutMode === '2col' ? {
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gridAutoRows: 'calc(50vh - 40px)',
              gap: 10,
            }
            : {
              display: 'flex',
              flexDirection: 'column' as const,
              gap: 8,
            }
          }
        >
          {filteredSessions.map(session => {
            const state = sessionStates.get(session.sessionId);
            const isRunning = runningSessionIds.has(session.sessionId);
            const isExpanded = expandedSessionId === session.sessionId;
            const hasExpandedSibling = expandedSessionId !== null && expandedSessionId !== session.sessionId;

            return (
              <TerminalPanel
                key={session.sessionId}
                session={session}
                detail={state?.detail || null}
                isLoading={state?.isLoading || false}
                showTypes={showTypes}
                isExpanded={isExpanded}
                autoExpanded={autoExpanded}
                autoScroll={autoScroll}
                onToggleExpand={() => handleToggleExpand(session.sessionId)}
                onConnect={() => handleConnect(session)}
                onStop={() => handleStop(session.sessionId)}
                isConnecting={launchingId === session.sessionId}
                isRunning={isRunning}
                hasExpandedSibling={hasExpandedSibling}
                isRecentlyUpdated={recentlyUpdatedIds.has(session.sessionId)}
                isVisible={visibleSetRef.current.has(session.sessionId)}
                isSingleMachine={isSingleMachine}
                layoutMode={layoutMode}
                messageLimit={messageLimit}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
