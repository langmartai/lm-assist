'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import { useMachineContext } from '@/contexts/MachineContext';
import type { BatchCheckListSession } from '@/lib/api-client';
import type { ClaudeProcessInfo } from '@/lib/types';

/**
 * Enrichment data for a session, indexed by sessionId.
 * Loaded asynchronously via batch-check API, independent of process polling.
 */
export type SessionEnrichmentMap = Record<string, BatchCheckListSession>;

/**
 * Hook that asynchronously fetches session metadata for running processes.
 * Uses batchCheckSessions with listCheck to get rich data (lastUserMessage,
 * numTurns, fileSize, agentCount, taskCount, teamName, etc.)
 *
 * This data loads independently from process data — the process dashboard
 * renders immediately with process info, then enrichment data fills in.
 */
export function useSessionEnrichment(
  processes: ClaudeProcessInfo[],
  pollInterval = 15000,
) {
  const { apiClient, isLocal } = useAppMode();
  const { onlineMachines, selectedMachineId } = useMachineContext();
  const [enrichment, setEnrichment] = useState<SessionEnrichmentMap>({});
  const [isLoading, setIsLoading] = useState(false);

  // Use refs for all values that change frequently — keeps fetchEnrichment stable
  const apiClientRef = useRef(apiClient);
  apiClientRef.current = apiClient;
  const isLocalRef = useRef(isLocal);
  isLocalRef.current = isLocal;
  const machinesRef = useRef(onlineMachines);
  machinesRef.current = onlineMachines;
  const selectedRef = useRef(selectedMachineId);
  selectedRef.current = selectedMachineId;
  const processesRef = useRef(processes);
  processesRef.current = processes;
  const inFlightRef = useRef(false);

  // Derive a stable key from session IDs — effect only re-triggers when sessions change
  const processKey = useMemo(() => {
    const parts: string[] = [];
    for (const proc of processes) {
      if (proc.sessionId && proc.sessionId !== 'unknown' && proc.sessionId !== 'chrome-session') {
        parts.push(proc.sessionId);
      }
    }
    parts.sort();
    return parts.join(',');
  }, [processes]);

  const fetchEnrichment = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    const procs = processesRef.current;
    const client = apiClientRef.current;

    // Collect unique project paths from processes that have session IDs
    const projectPaths = new Set<string>();
    const sessionIds = new Set<string>();

    for (const proc of procs) {
      if (proc.sessionId && proc.sessionId !== 'unknown' && proc.sessionId !== 'chrome-session') {
        sessionIds.add(proc.sessionId);
        if (proc.projectPath) {
          projectPaths.add(proc.projectPath);
        }
      }
    }

    if (sessionIds.size === 0) {
      inFlightRef.current = false;
      setEnrichment({});
      return;
    }

    setIsLoading(true);
    try {
      const local = isLocalRef.current;
      const machines = machinesRef.current;
      const selected = selectedRef.current;

      // Determine machine IDs to query
      const machineIds: (string | undefined)[] = local
        ? [undefined]
        : selected
          ? [selected]
          : machines.map(m => m.id);

      // For each machine + project path combo, call batchCheckSessions
      const results = await Promise.allSettled(
        machineIds.flatMap(machineId =>
          Array.from(projectPaths).map(async projectPath => {
            const resp = await client.batchCheckSessions(
              { listCheck: { projectPath } },
              machineId,
            );
            return resp.listStatus?.sessions || [];
          })
        )
      );

      // Build enrichment map from results
      const map: SessionEnrichmentMap = {};
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        for (const session of result.value) {
          // Only include sessions that match running processes
          if (sessionIds.has(session.sessionId)) {
            map[session.sessionId] = session;
          }
        }
      }

      setEnrichment(map);
    } catch {
      // Don't clear enrichment on error — keep stale data
    } finally {
      setIsLoading(false);
      inFlightRef.current = false;
    }
  }, []); // No dependencies — uses refs for everything

  // Initial fetch when processes first appear, then poll on interval
  useEffect(() => {
    if (!processKey) return; // No sessions to enrich

    // Fetch immediately, then start interval
    fetchEnrichment();
    const interval = setInterval(fetchEnrichment, pollInterval);
    return () => clearInterval(interval);
  }, [fetchEnrichment, pollInterval, processKey]);

  return { enrichment, isLoading, refetch: fetchEnrichment };
}
