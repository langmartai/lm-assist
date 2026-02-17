'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import { useMachineContext } from '@/contexts/MachineContext';
import type { Session, SessionDetail, SessionMessage } from '@/lib/types';

// ============================================================================
// Types
// ============================================================================

export interface SessionMonitorState {
  detail: SessionDetail | null;
  isLoading: boolean;
  lastLineCount: number;
  lastFileSize: number;
  error: Error | null;
}

export interface UseMultiSessionMonitorOptions {
  /** All sessions (pre-filtered to those with content) */
  sessions: Session[];
  /** Session IDs currently visible on screen — only these get detail loaded */
  visibleSessionIds: string[];
  /** Poll interval for active sessions in ms (default: 2000) */
  activeInterval?: number;
  /** Poll interval for inactive sessions in ms (default: 5000) */
  inactiveInterval?: number;
  /** Whether monitoring is enabled (default: true) */
  enabled?: boolean;
  /** Number of recent messages to fetch per session (default: 50) */
  messageLimit?: number;
}

export interface UseMultiSessionMonitorReturn {
  /** Map of session ID to monitor state */
  sessionStates: Map<string, SessionMonitorState>;
  /** Whether a batch check is in progress */
  isPolling: boolean;
  /** Session IDs that were recently updated (fades after 60s) */
  recentlyUpdatedIds: Set<string>;
  /** Force refresh all visible sessions */
  refreshAll: () => Promise<void>;
  /** Force refresh a single session */
  refreshSession: (sessionId: string) => Promise<void>;
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * Hook for monitoring multiple sessions concurrently.
 * Only loads full detail for sessions in `visibleSessionIds` (on-screen panels).
 * Uses a single batch-check poll loop for change detection on visible sessions.
 */
export function useMultiSessionMonitor({
  sessions,
  visibleSessionIds,
  activeInterval = 2000,
  inactiveInterval = 5000,
  enabled = true,
  messageLimit = 50,
}: UseMultiSessionMonitorOptions): UseMultiSessionMonitorReturn {

  const { apiClient, isLocal } = useAppMode();
  const { isSingleMachine } = useMachineContext();

  const [sessionStates, setSessionStates] = useState<Map<string, SessionMonitorState>>(new Map());
  const [isPolling, setIsPolling] = useState(false);
  const [recentlyUpdatedIds, setRecentlyUpdatedIds] = useState<Set<string>>(new Set());

  // Refs to avoid stale closures
  const sessionsRef = useRef<Session[]>([]);
  const statesRef = useRef<Map<string, SessionMonitorState>>(new Map());
  const visibleRef = useRef<string[]>([]);
  const fetchQueueRef = useRef<Set<string>>(new Set());
  const activeFetchesRef = useRef<number>(0);
  const activeSessionsRef = useRef<Set<string>>(new Set());
  const updateTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  // Track sessions that have had at least one batch check (skip glow on first check)
  const batchBaselineRef = useRef<Set<string>>(new Set());
  const prevMessageLimitRef = useRef<number>(messageLimit);

  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => { statesRef.current = sessionStates; }, [sessionStates]);
  useEffect(() => { visibleRef.current = visibleSessionIds; }, [visibleSessionIds]);

  // Cleanup update timers on unmount
  useEffect(() => {
    return () => {
      updateTimersRef.current.forEach(timer => clearTimeout(timer));
      updateTimersRef.current.clear();
    };
  }, []);

  // Mark a session as recently updated (auto-clears after 60s)
  const markUpdated = useCallback((sessionId: string) => {
    // Clear existing timer for this session (resets the 60s window)
    const existing = updateTimersRef.current.get(sessionId);
    if (existing) clearTimeout(existing);

    setRecentlyUpdatedIds(prev => {
      const next = new Set(prev);
      next.add(sessionId);
      return next;
    });

    const timer = setTimeout(() => {
      updateTimersRef.current.delete(sessionId);
      setRecentlyUpdatedIds(prev => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }, 60000);

    updateTimersRef.current.set(sessionId, timer);
  }, []);

  // Stable key for visible session IDs
  const visibleKey = visibleSessionIds.join(',');

  // Fetch session detail with concurrency control
  const fetchSessionDetail = useCallback(async (sessionId: string) => {
    const MAX_CONCURRENT = 3;

    if (activeFetchesRef.current >= MAX_CONCURRENT) {
      fetchQueueRef.current.add(sessionId);
      return;
    }

    activeFetchesRef.current++;

    // Mark as loading
    setSessionStates(prev => {
      const next = new Map(prev);
      const existing = next.get(sessionId);
      if (!existing || (!existing.detail && !existing.isLoading)) {
        next.set(sessionId, {
          detail: existing?.detail || null,
          isLoading: true,
          lastLineCount: existing?.lastLineCount || 0,
          lastFileSize: existing?.lastFileSize || 0,
          error: null,
        });
      }
      return next;
    });

    try {
      const session = sessionsRef.current.find(s => s.sessionId === sessionId);
      const machineId = isLocal ? undefined : session?.machineId;

      const detail = await apiClient.getSessionConversation(
        sessionId,
        { lastN: Math.ceil(messageLimit / 5) },
        machineId,
      );

      setSessionStates(prev => {
        const next = new Map(prev);
        const existing = next.get(sessionId);
        next.set(sessionId, {
          detail,
          isLoading: false,
          lastLineCount: (detail as any).lineCount || existing?.lastLineCount || 0,
          lastFileSize: (detail as any).fileSize || existing?.lastFileSize || 0,
          error: null,
        });
        return next;
      });

      if (session) {
        const lastMod = new Date(session.lastModified).getTime();
        if (Date.now() - lastMod < 60000) {
          activeSessionsRef.current.add(sessionId);
        } else {
          activeSessionsRef.current.delete(sessionId);
        }
      }
    } catch (error) {
      setSessionStates(prev => {
        const next = new Map(prev);
        const existing = next.get(sessionId);
        next.set(sessionId, {
          detail: existing?.detail || null,
          isLoading: false,
          lastLineCount: existing?.lastLineCount || 0,
          lastFileSize: existing?.lastFileSize || 0,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return next;
      });
    } finally {
      activeFetchesRef.current--;

      if (fetchQueueRef.current.size > 0) {
        const nextSessionId = fetchQueueRef.current.values().next().value;
        if (nextSessionId) {
          fetchQueueRef.current.delete(nextSessionId);
          fetchSessionDetail(nextSessionId);
        }
      }
    }
  }, [apiClient, isLocal, messageLimit]);

  // Load detail when sessions become visible (and don't already have detail)
  useEffect(() => {
    if (!enabled || visibleSessionIds.length === 0) return;

    for (const sessionId of visibleSessionIds) {
      const state = statesRef.current.get(sessionId);
      // Skip if already loaded or currently loading
      if (state?.detail || state?.isLoading) continue;

      const session = sessionsRef.current.find(s => s.sessionId === sessionId);
      if (session) {
        fetchSessionDetail(sessionId);
      }
    }
  }, [enabled, visibleKey, fetchSessionDetail]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch visible sessions when messageLimit increases (e.g. layout switch to larger view)
  useEffect(() => {
    if (messageLimit > prevMessageLimitRef.current && enabled) {
      const toRefresh = visibleRef.current;
      for (const sessionId of toRefresh) {
        const state = statesRef.current.get(sessionId);
        if (state?.detail && !state?.isLoading) {
          fetchSessionDetail(sessionId);
        }
      }
    }
    prevMessageLimitRef.current = messageLimit;
  }, [messageLimit, enabled, fetchSessionDetail]);

  // Poll loop: batch check visible sessions for changes
  useEffect(() => {
    if (!enabled || visibleSessionIds.length === 0) return;

    const checkForUpdates = async () => {
      const currentVisible = visibleRef.current;
      if (currentVisible.length === 0) return;

      // Only check visible sessions that already have detail loaded
      const toCheck = currentVisible.filter(id => statesRef.current.get(id)?.detail);
      if (toCheck.length === 0) return;

      setIsPolling(true);

      try {
        // Determine machineId for batch check (use first session's machineId in hub mode)
        const firstSession = sessionsRef.current.find(s => toCheck.includes(s.sessionId));
        const machineId = isLocal ? undefined : firstSession?.machineId;

        const batchSessions = toCheck.map(sessionId => ({
          sessionId,
          knownFileSize: statesRef.current.get(sessionId)?.lastFileSize || 0,
        }));

        const batchResult = await apiClient.batchCheckSessions({ sessions: batchSessions }, machineId);

        for (const [sessionId, info] of Object.entries(batchResult.sessions)) {
          // Update lastFileSize from batch response so next check has correct baseline
          if (info.fileSize) {
            setSessionStates(prev => {
              const next = new Map(prev);
              const existing = next.get(sessionId);
              if (existing) {
                next.set(sessionId, { ...existing, lastFileSize: info.fileSize });
              }
              return next;
            });
          }

          if (!info.exists || !info.changed) {
            batchBaselineRef.current.add(sessionId);
            continue;
          }

          if (info.lastModified) {
            const lastMod = new Date(info.lastModified).getTime();
            if (Date.now() - lastMod < 60000) {
              activeSessionsRef.current.add(sessionId);
            } else {
              activeSessionsRef.current.delete(sessionId);
            }
          }

          // Only highlight if this session had a previous baseline (skip first check)
          if (batchBaselineRef.current.has(sessionId)) {
            markUpdated(sessionId);
          }
          batchBaselineRef.current.add(sessionId);

          fetchSessionDetail(sessionId);
        }
      } catch (error) {
        console.error('[useMultiSessionMonitor] Batch check error:', error);
      } finally {
        setIsPolling(false);
      }
    };

    // Delay first poll
    const initialTimeout = setTimeout(checkForUpdates, 3000);

    const hasActiveSessions = visibleSessionIds.some(id => activeSessionsRef.current.has(id));
    const interval = hasActiveSessions ? activeInterval : inactiveInterval;
    const intervalId = setInterval(checkForUpdates, interval);

    return () => {
      clearTimeout(initialTimeout);
      clearInterval(intervalId);
    };
  }, [enabled, visibleKey, activeInterval, inactiveInterval, fetchSessionDetail, markUpdated, apiClient, isLocal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Manual refresh
  const refreshAll = useCallback(async () => {
    setIsPolling(true);
    const toRefresh = visibleRef.current;
    const promises = toRefresh.map(sessionId => fetchSessionDetail(sessionId));
    await Promise.all(promises);
    setIsPolling(false);
  }, [fetchSessionDetail]);

  const refreshSession = useCallback(async (sessionId: string) => {
    await fetchSessionDetail(sessionId);
  }, [fetchSessionDetail]);

  return {
    sessionStates,
    isPolling,
    recentlyUpdatedIds,
    refreshAll,
    refreshSession,
  };
}
