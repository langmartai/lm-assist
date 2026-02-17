'use client';

import { useEffect, useCallback, useMemo, useRef } from 'react';
import { useTerminals } from '@/hooks/useTerminals';
import { useRunningProcesses } from '@/hooks/useRunningProcesses';
import { useAppMode } from '@/contexts/AppModeContext';
import { useMachineContext } from '@/contexts/MachineContext';
import { resolveConsoleUrl } from '@/lib/api-client';
import { DashboardToolbar } from '@/components/console-dashboard/DashboardToolbar';
import { LayoutEngine } from '@/components/console-dashboard/LayoutEngine';
import { useConsoleDashboardStore } from '@/stores/consoleDashboardStore';
import type { ConsoleInstance } from '@/components/console-dashboard/types';

// ============================================================================
// Helpers
// ============================================================================

const POSITION_REFRESH_MS = 5 * 60 * 1000; // 5 minutes

function getProjectName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

// ============================================================================
// Page Component
// ============================================================================

export default function ConsoleDashboardPage() {
  const positionTimerRef = useRef<NodeJS.Timeout | null>(null);
  const { apiClient, proxy } = useAppMode();
  const { selectedMachineId } = useMachineContext();

  const {
    openConsoles,
    setConsoles,
    openConsole,
    updateConsole,
    focusedConsoleId,
    setFocusedConsole,
    refreshPositions,
    hydrate,
  } = useConsoleDashboardStore();

  // Hydrate store from localStorage on mount
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // ── Data queries ──────────────────────────────────────────────────────

  const { availableSessions, isLoading: sessionsLoading, refetch: refetchSessions } = useTerminals();
  const { data: processData, isLoading: processesLoading, refetch: refetchProcesses } = useRunningProcesses();

  // ── Derived data: running sessions → open consoles ────────────────────

  const runningSessionIds = useMemo(() => {
    const ids = new Set<string>();
    if (processData?.managed) {
      for (const proc of processData.managed) {
        if (proc.sessionId) ids.add(proc.sessionId);
      }
    }
    if (processData?.allClaudeProcesses) {
      for (const proc of processData.allClaudeProcesses) {
        if (proc.sessionId && proc.sessionId !== 'chrome-session') {
          ids.add(proc.sessionId);
        }
      }
    }
    if (availableSessions) {
      for (const s of availableSessions) {
        if (s.isRunning && s.sessionId) ids.add(s.sessionId);
      }
    }
    return ids;
  }, [processData, availableSessions]);

  // Build ttyd URL map from managed processes
  // In proxy mode, skip localhost URLs — the auto-start flow will use
  // apiClient.startTerminal() which returns hub-proxied URLs with auth tokens
  const ttydUrlMap = useMemo(() => {
    const map = new Map<string, string>();
    if (proxy.isProxied) return map; // Let auto-start handle URL generation
    if (processData?.managed) {
      for (const proc of processData.managed) {
        if (proc.sessionId && proc.url) {
          map.set(proc.sessionId, resolveConsoleUrl(proc.url));
        } else if (proc.sessionId && proc.port) {
          const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
          map.set(proc.sessionId, `http://${host}:${proc.port}`);
        }
      }
    }
    return map;
  }, [processData, proxy.isProxied]);

  // Build map of unmanaged-tmux processes by sessionId for tmux attach
  const tmuxProcessMap = useMemo(() => {
    const map = new Map<string, { tmuxSessionName?: string; pid: number }>();
    if (processData?.allClaudeProcesses) {
      for (const proc of processData.allClaudeProcesses) {
        if (proc.managedBy === 'unmanaged-tmux' && proc.sessionId) {
          map.set(proc.sessionId, { tmuxSessionName: proc.tmuxSessionName, pid: proc.pid });
        }
      }
    }
    return map;
  }, [processData]);

  // Sync running sessions into the store as open consoles
  useEffect(() => {
    if (!availableSessions || availableSessions.length === 0) return;

    const currentConsoles = useConsoleDashboardStore.getState().openConsoles;
    const currentFocusId = useConsoleDashboardStore.getState().focusedConsoleId;

    const sessions = availableSessions.filter(
      (s) => s.sessionId && s.projectPath && runningSessionIds.has(s.sessionId)
    );

    const consoles: ConsoleInstance[] = sessions.map((s) => {
      const existing = currentConsoles.find(c => c.id === s.sessionId);
      const tmuxProc = tmuxProcessMap.get(s.sessionId);
      return {
        id: s.sessionId,
        sessionId: s.sessionId,
        projectPath: s.projectPath,
        title: s.lastUserMessage
          ? s.lastUserMessage.slice(0, 60) + (s.lastUserMessage.length > 60 ? '...' : '')
          : getProjectName(s.projectPath),
        ttydUrl: ttydUrlMap.get(s.sessionId) || existing?.ttydUrl || null,
        isRunning: true,
        isTmux: !!tmuxProc,
        tmuxSessionName: tmuxProc?.tmuxSessionName,
        pid: tmuxProc?.pid,
        lastActivity: s.lastModified || new Date().toISOString(),
        model: s.model,
        costUsd: s.totalCostUsd,
        taskCount: s.taskCount,
        groupId: existing?.groupId ?? null,
      };
    });

    // Keep manually opened but no longer running consoles (mark not running)
    // Also deduplicate: drop any tmux-prefixed console whose sessionId is already covered
    // Preserve isRunning for sessions still in runningSessionIds (e.g. tmux-only sessions
    // detected by process scanner but missing from availableSessions list)
    const runningIds = new Set(consoles.map(c => c.id));
    const runningSessionIdSet = new Set(consoles.map(c => c.sessionId));
    const staleConsoles = currentConsoles
      .filter(c => !runningIds.has(c.id) && !runningSessionIdSet.has(c.sessionId))
      .map(c => ({ ...c, isRunning: runningSessionIds.has(c.sessionId) }));

    setConsoles([...consoles, ...staleConsoles]);

    // Auto-focus first if none focused
    if (!currentFocusId && consoles.length > 0) {
      setFocusedConsole(consoles[0].id);
    }
  }, [availableSessions, runningSessionIds, ttydUrlMap, tmuxProcessMap, setConsoles, setFocusedConsole]);

  // ── External tmux sessions (only those not already in availableSessions) ──

  useEffect(() => {
    if (!processData?.allClaudeProcesses) return;

    const currentConsoles = useConsoleDashboardStore.getState().openConsoles;

    for (const proc of processData.allClaudeProcesses) {
      if (proc.managedBy === 'unmanaged-tmux' && proc.sessionId) {
        // Skip if already added by the main sync (by sessionId match)
        const existing = currentConsoles.find(c => c.sessionId === proc.sessionId);
        if (!existing) {
          openConsole({
            id: `tmux-${proc.sessionId}`,
            sessionId: proc.sessionId,
            projectPath: proc.projectPath || '/unknown',
            title: `tmux: ${proc.tmuxSessionName || proc.sessionId.slice(0, 8)}`,
            ttydUrl: null,
            isRunning: true,
            isTmux: true,
            tmuxSessionName: proc.tmuxSessionName,
            pid: proc.pid,
            lastActivity: new Date().toISOString(),
            groupId: null,
          });
        }
      }
    }
  }, [processData, openConsole]);

  // ── Auto-start ttyd for all running consoles (single bulk call) ──────

  const startingAllRef = useRef(false);
  // Tracks whether we've already dispatched a start-all for the current batch.
  // Reset only when consolesNeedingStart is stably 0 (debounced), so that
  // brief polling fluctuations don't trigger duplicate calls.
  const batchStartedRef = useRef(false);

  // Use ref for apiClient to avoid it as an effect dependency (it may be
  // recreated on every render by the context provider, causing re-fires).
  const apiClientRef = useRef(apiClient);
  apiClientRef.current = apiClient;

  // Stable trigger: only re-run when the count of consoles needing a URL changes,
  // not on every openConsoles reference change (which happens every poll cycle).
  const consolesNeedingStart = useMemo(
    () => openConsoles.filter(c => c.isRunning && !c.ttydUrl).length,
    [openConsoles],
  );

  useEffect(() => {
    if (consolesNeedingStart === 0 || batchStartedRef.current || startingAllRef.current) return;

    // Debounce: wait for consolesNeedingStart to settle before calling.
    // During initial load the count fluctuates (0→23→7→1) as poll data
    // arrives; each change restarts this timer so we fire only once.
    const timer = setTimeout(() => {
      if (batchStartedRef.current || startingAllRef.current) return;
      batchStartedRef.current = true;
      startingAllRef.current = true;
      apiClientRef.current.startAllTerminals(selectedMachineId || undefined)
        .then(({ results }) => {
          const store = useConsoleDashboardStore.getState();
          for (const r of results) {
            if (r.consoleUrl && r.sessionId) {
              const current = store.openConsoles.find(c => c.sessionId === r.sessionId);
              if (current) {
                store.updateConsole(current.id, { ttydUrl: r.consoleUrl });
              }
            }
          }
        })
        .catch(() => {
          batchStartedRef.current = false; // Allow retry on error
        })
        .finally(() => {
          startingAllRef.current = false;
        });
    }, 500);

    return () => clearTimeout(timer);
  }, [consolesNeedingStart, selectedMachineId]);

  // ── Position refresh timer ────────────────────────────────────────────

  useEffect(() => {
    positionTimerRef.current = setInterval(() => {
      if (useConsoleDashboardStore.getState().openConsoles.length > 0 &&
          Date.now() - useConsoleDashboardStore.getState().lastPositionRefresh >= POSITION_REFRESH_MS) {
        refreshPositions();
      }
    }, 30000);

    refreshPositions();

    return () => {
      if (positionTimerRef.current) clearInterval(positionTimerRef.current);
    };
  }, [refreshPositions]);

  // Also refresh positions when console count changes significantly
  const prevCountRef = useRef(openConsoles.length);
  useEffect(() => {
    if (Math.abs(openConsoles.length - prevCountRef.current) >= 2) {
      refreshPositions();
      prevCountRef.current = openConsoles.length;
    }
  }, [openConsoles.length, refreshPositions]);

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleRefresh = useCallback(() => {
    refetchProcesses();
    refetchSessions();
    refreshPositions();
  }, [refetchProcesses, refetchSessions, refreshPositions]);

  // ── Count stats ───────────────────────────────────────────────────────

  const openCount = openConsoles.length;
  const runningCount = openConsoles.filter(c => c.isRunning).length;
  const totalAvailable = availableSessions?.length ?? 0;

  // ── Loading state ─────────────────────────────────────────────────────

  if (sessionsLoading && openConsoles.length === 0) {
    return (
      <div className="h-full flex flex-col" style={{ background: 'var(--color-bg-root)' }}>
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-10 w-10 rounded-lg flex items-center justify-center"
              style={{ background: 'var(--color-bg-surface)', border: '1px solid var(--color-border-subtle)' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--color-status-green)', opacity: 0.4 }} className="animate-pulse">
                <path d="M4 17l6-6-6-6M12 19h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <span className="text-[11px] animate-pulse" style={{ color: 'var(--color-text-tertiary)' }}>Scanning processes...</span>
          </div>
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: 'var(--color-bg-root)' }}>
      {/* Toolbar */}
      <DashboardToolbar
        openCount={openCount}
        runningCount={runningCount}
        totalAvailable={totalAvailable}
        onRefresh={handleRefresh}
        isRefreshing={processesLoading || sessionsLoading}
      />

      {/* Layout engine */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <LayoutEngine consoles={openConsoles} />
      </div>
    </div>
  );
}
