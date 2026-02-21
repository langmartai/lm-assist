'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import { useMachineContext } from '@/contexts/MachineContext';
import type { Session } from '@/lib/types';
import type { BatchCheckResponse } from '@/lib/api-client';

export type SessionFilter = {
  machineId: string | null;
  projectName: string | null;
  status: 'all' | 'running' | 'completed';
  timeRange: 'today' | 'week' | 'month' | 'all';
  search: string;
  sort: 'recent' | 'machine' | 'project';
};

const defaultFilter: SessionFilter = {
  machineId: null,
  projectName: null,
  status: 'all',
  timeRange: 'all',
  search: '',
  sort: 'recent',
};

interface UseSessionsOptions {
  /** When true, disables internal polling -- caller manages polling externally */
  externalPolling?: boolean;
}

interface UseSessionsResult {
  sessions: Session[];
  allSessions: Session[];
  isLoading: boolean;
  error: string | null;
  filters: SessionFilter;
  setFilters: (f: Partial<SessionFilter>) => void;
  refetch: () => void;
  /** Update session list from batch-check listStatus data (avoids separate getSessions call) */
  updateFromBatchCheck: (listStatus: BatchCheckResponse['listStatus']) => void;
  /** Current known session count for listCheck change detection (getter to avoid stale snapshots) */
  getKnownSessionCount: () => number;
  /** Current known latest modified timestamp for listCheck change detection (getter to avoid stale snapshots) */
  getKnownLatestModified: () => string;
  // Derived
  projectNames: string[];
}

export function useSessions(options?: UseSessionsOptions): UseSessionsResult {
  const externalPolling = options?.externalPolling ?? false;
  const { apiClient, isLocal, isHybrid } = useAppMode();
  const { onlineMachines, selectedMachineId } = useMachineContext();
  const [allSessions, setAllSessions] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFiltersState] = useState<SessionFilter>(() => {
    if (typeof window !== 'undefined') {
      try {
        const savedProject = localStorage.getItem('session-filter-project');
        if (savedProject) {
          return { ...defaultFilter, projectName: savedProject };
        }
      } catch { /* ignore */ }
    }
    return defaultFilter;
  });
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Track list metadata for batch-check change detection
  const knownSessionCountRef = useRef(0);
  const knownLatestModifiedRef = useRef('');

  const setFilters = useCallback((partial: Partial<SessionFilter>) => {
    setFiltersState(prev => ({ ...prev, ...partial }));
    if ('projectName' in partial) {
      try {
        if (partial.projectName) {
          localStorage.setItem('session-filter-project', partial.projectName);
        } else {
          localStorage.removeItem('session-filter-project');
        }
      } catch { /* ignore */ }
    }
  }, []);

  // Guard against concurrent fetchSessions calls
  const fetchingRef = useRef(false);

  const fetchSessions = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      let sessions: Session[];

      if (isLocal) {
        // Pure local mode: single fetch, no machineId needed
        sessions = await apiClient.getSessions();
      } else if (isHybrid) {
        // Hybrid mode: parallel fetch from all online machines
        // The hybrid client routes local vs remote internally
        const machineIds = selectedMachineId
          ? [selectedMachineId]
          : onlineMachines.map(m => m.id);

        if (machineIds.length === 0) {
          // No machines yet -- fall back to local-only fetch
          sessions = await apiClient.getSessions();
        } else {
          const results = await Promise.allSettled(
            machineIds.map(id => apiClient.getSessions(id))
          );
          sessions = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
        }
      } else {
        // Hub mode: parallel fetch from all online machines
        const machineIds = selectedMachineId
          ? [selectedMachineId]
          : onlineMachines.map(m => m.id);

        const results = await Promise.allSettled(
          machineIds.map(id => apiClient.getSessions(id))
        );

        sessions = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
      }

      // Hide sessions with 0 user prompts (empty/no-interaction sessions)
      sessions = sessions.filter(s => s.userPromptCount == null || s.userPromptCount > 0);

      // Sort by lastModified descending
      sessions.sort((a, b) =>
        new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
      );

      setAllSessions(sessions);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch sessions');
    } finally {
      fetchingRef.current = false;
      setIsLoading(false);
    }
  }, [apiClient, isLocal, isHybrid, onlineMachines, selectedMachineId]);

  // Process batch-check listStatus: update tracking metadata and trigger
  // a full refetch when the session list has changed.
  // NOTE: knownSessionCount/knownLatestModified track the server's single-project
  // values (echoed back for change detection), NOT the client's all-project count.
  const updateFromBatchCheck = useCallback((listStatus: BatchCheckResponse['listStatus']) => {
    if (!listStatus) return;

    // Always echo back the server's values for next poll's change detection.
    // These track the server's scope (single project), not our all-project list.
    knownSessionCountRef.current = listStatus.totalSessions;
    knownLatestModifiedRef.current = listStatus.latestModified;

    // If the list changed, trigger a full multi-project refetch
    if (listStatus.changed) {
      fetchSessions();
    }
  }, [fetchSessions]);

  // Poll by calling fetchSessions directly -- getSessions() uses ifModifiedSince
  // internally, returning cached data (~200 bytes) when nothing has changed.
  useEffect(() => {
    fetchSessions();
    if (!externalPolling) {
      intervalRef.current = setInterval(fetchSessions, 3000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchSessions, externalPolling]);

  // Derived: unique project names
  const projectNames = useMemo(() => {
    const names = new Set(allSessions.map(s => s.projectName));
    return Array.from(names).sort();
  }, [allSessions]);

  // Apply client-side filters
  const sessions = useMemo(() => {
    let result = [...allSessions];

    // Machine filter
    if (filters.machineId) {
      result = result.filter(s => s.machineId === filters.machineId);
    }

    // Project filter (support both project name and full project path)
    if (filters.projectName) {
      const pf = filters.projectName;
      result = result.filter(s =>
        s.projectName === pf || s.projectPath === pf
      );
    }

    // Status filter
    if (filters.status === 'running') {
      result = result.filter(s => s.isRunning);
    } else if (filters.status === 'completed') {
      result = result.filter(s => !s.isRunning);
    }

    // Time range filter
    if (filters.timeRange !== 'all') {
      const now = Date.now();
      const cutoffs: Record<string, number> = {
        today: 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000,
        month: 30 * 24 * 60 * 60 * 1000,
      };
      const cutoff = cutoffs[filters.timeRange];
      if (cutoff) {
        result = result.filter(s => now - new Date(s.lastModified).getTime() < cutoff);
      }
    }

    // Search
    if (filters.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(s =>
        s.sessionId.toLowerCase().includes(q) ||
        s.projectName.toLowerCase().includes(q) ||
        (s.summary && s.summary.toLowerCase().includes(q)) ||
        (s.lastUserMessage && s.lastUserMessage.toLowerCase().includes(q))
      );
    }

    // Sort
    switch (filters.sort) {
      case 'machine':
        result.sort((a, b) => a.machineHostname.localeCompare(b.machineHostname));
        break;
      case 'project':
        result.sort((a, b) => a.projectName.localeCompare(b.projectName));
        break;
      case 'recent':
      default:
        result.sort((a, b) =>
          new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
        );
    }

    return result;
  }, [allSessions, filters]);

  return {
    sessions,
    allSessions,
    isLoading,
    error,
    filters,
    setFilters,
    refetch: fetchSessions,
    updateFromBatchCheck,
    getKnownSessionCount: () => knownSessionCountRef.current,
    getKnownLatestModified: () => knownLatestModifiedRef.current,
    projectNames,
  };
}
