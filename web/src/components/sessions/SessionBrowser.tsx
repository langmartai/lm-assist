'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAppMode } from '@/contexts/AppModeContext';
import { useSessions } from '@/hooks/useSessions';
import { useProjects } from '@/hooks/useProjects';
import { SessionSidebar } from './SessionSidebar';
import { SessionDetail } from './SessionDetail';
import type { SubagentSession } from '@/lib/types';
import { useDeviceInfo } from '@/hooks/useDeviceInfo';
import { ArrowLeft } from 'lucide-react';

export function SessionBrowser() {
  const searchParams = useSearchParams();
  const { apiClient } = useAppMode();
  const sessionsHook = useSessions({ externalPolling: true });
  const { projects } = useProjects();
  const gitProjectNames = useMemo(() => {
    const names = new Set<string>();
    for (const p of projects) {
      if (p.isGitProject !== false) {
        const name = p.projectPath.split('/').pop() || p.projectName;
        names.add(name);
      }
    }
    return names;
  }, [projects]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedMachineId, setSelectedMachineId] = useState<string | undefined>(undefined);
  const [lastSuggestion, setLastSuggestion] = useState<{ text: string; updatedAt?: string } | null>(null);
  const [selectedSubagents, setSelectedSubagents] = useState<SubagentSession[]>([]);

  // Watchdog: compare session list vs chat detail freshness
  const detailMetaRef = useRef<{ numTurns: number; lineCount: number; refetch: () => void } | null>(null);
  const watchdogTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastForceRefetchRef = useRef<number>(0);

  // Batch poll controls from SessionDetail child
  const pollControlsRef = useRef<{
    applyBatchCheck: (check: {
      exists: boolean;
      fileSize: number;
      agentIds: string[];
      lastModified: string;
      changed: boolean;
      agentsChanged: boolean;
    }) => void;
    pollState: { knownFileSize: number; knownAgentCount: number };
  } | null>(null);

  const handleDetailMeta = useCallback((meta: { numTurns: number; lineCount: number; refetch: () => void }) => {
    detailMetaRef.current = meta;
  }, []);

  const handlePollControls = useCallback((controls: typeof pollControlsRef.current) => {
    pollControlsRef.current = controls;
  }, []);

  const hasUrlSession = searchParams.has('session');
  const urlParent = searchParams.get('parent');

  // Read tab + milestone from URL params for deep-linking
  const urlTab = searchParams.get('tab') as any;
  const urlMilestone = searchParams.get('milestone');

  // Apply URL search params as initial filters
  useEffect(() => {
    const project = searchParams.get('project');
    const machine = searchParams.get('machine');
    const sessionId = searchParams.get('session');

    if (project || machine) {
      sessionsHook.setFilters({
        ...(project ? { projectName: project } : {}),
        ...(machine ? { machineId: machine } : {}),
      });
    }
    if (sessionId) {
      setSelectedSessionId(sessionId);
      if (machine) setSelectedMachineId(machine);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select most recent session when no session specified in URL
  useEffect(() => {
    if (hasUrlSession || selectedSessionId) return;
    if (sessionsHook.sessions.length > 0) {
      const first = sessionsHook.sessions[0];
      setSelectedSessionId(first.sessionId);
      setSelectedMachineId(first.machineId);
    }
  }, [hasUrlSession, selectedSessionId, sessionsHook.sessions]);

  // Resolve machineId from sessions list when selected session has no machineId
  // (e.g., navigated via link without &machine= param)
  useEffect(() => {
    if (!selectedSessionId || selectedMachineId) return;
    const match = sessionsHook.sessions.find(s => s.sessionId === selectedSessionId);
    if (match?.machineId) {
      setSelectedMachineId(match.machineId);
    }
  }, [selectedSessionId, selectedMachineId, sessionsHook.sessions]);

  // ═══════════════════════════════════════════════════════════════════════════
  // Poll Loop — runs in parallel:
  //   - Session list: getSessions() with ifModifiedSince (cached when unchanged)
  //   - Session detail: batch-check for the selected session only
  // ═══════════════════════════════════════════════════════════════════════════
  const isActiveRef = useRef(false);
  const batchPollTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Stable refs to avoid effect teardown when callbacks/state change
  const sessionsHookRef = useRef(sessionsHook);
  sessionsHookRef.current = sessionsHook;
  const apiClientRef = useRef(apiClient);
  apiClientRef.current = apiClient;
  const selectedSessionIdRef = useRef(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;
  const selectedMachineIdRef = useRef(selectedMachineId);
  selectedMachineIdRef.current = selectedMachineId;

  useEffect(() => {
    let isMounted = true;

    const doBatchPoll = async () => {
      if (!isMounted) return;

      const currentSessionId = selectedSessionIdRef.current;
      const currentMachineId = selectedMachineIdRef.current;
      const currentApiClient = apiClientRef.current;
      const currentSessionsHook = sessionsHookRef.current;

      // Session list: use getSessions() with ifModifiedSince (returns cached data when unchanged)
      // Session detail: use batch-check for the selected session only
      const listPromise = currentSessionsHook.refetch();

      let detailPromise: Promise<void> | undefined;
      if (currentSessionId && pollControlsRef.current) {
        detailPromise = (async () => {
          try {
            const { pollState } = pollControlsRef.current!;
            const result = await currentApiClient.batchCheckSessions({
              sessions: [{
                sessionId: currentSessionId,
                knownFileSize: pollState.knownFileSize || undefined,
                knownAgentCount: pollState.knownAgentCount || undefined,
              }],
            }, currentMachineId);

            if (!isMounted) return;

            const sessionResult = result.sessions[currentSessionId];
            if (sessionResult && pollControlsRef.current) {
              isActiveRef.current = !!sessionResult.lastModified &&
                (Date.now() - new Date(sessionResult.lastModified).getTime()) < 15000;
              await pollControlsRef.current.applyBatchCheck(sessionResult);
            }
          } catch (err) {
            console.debug('[batch-poll] session check error:', err);
          }
        })();
      }

      await Promise.all([listPromise, detailPromise].filter(Boolean));
    };

    const scheduleNext = () => {
      if (!isMounted) return;
      // Active sessions: 1s, inactive: 3s
      const delay = isActiveRef.current ? 1000 : 3000;
      batchPollTimerRef.current = setTimeout(async () => {
        if (!isMounted) return;
        await doBatchPoll();
        scheduleNext();
      }, delay);
    };

    // Start after initial data loads
    const startTimer = setTimeout(scheduleNext, 1000);

    return () => {
      isMounted = false;
      clearTimeout(startTimer);
      if (batchPollTimerRef.current) clearTimeout(batchPollTimerRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — uses refs for all dependencies

  // Watchdog: detect when session list has newer data than chat detail
  useEffect(() => {
    if (!selectedSessionId) return;

    const selected = sessionsHook.sessions.find(s => s.sessionId === selectedSessionId);
    if (!selected || !detailMetaRef.current) return;

    const listTurns = selected.numTurns || 0;
    const detailTurns = detailMetaRef.current.numTurns;

    // Allow small difference (up to 2 turns) — session list polls every 3s
    if (listTurns > detailTurns + 2) {
      // Clear any existing timer
      if (watchdogTimerRef.current) clearTimeout(watchdogTimerRef.current);

      // Wait 5 seconds then check again — if still stale, force refetch
      watchdogTimerRef.current = setTimeout(() => {
        const currentDetail = detailMetaRef.current;
        if (!currentDetail) return;

        const stillStale = listTurns > currentDetail.numTurns + 2;
        const now = Date.now();
        // Don't force refetch more than once every 10 seconds
        if (stillStale && now - lastForceRefetchRef.current > 10000) {
          console.error(
            '[watchdog] chat stale! session list T:%d vs chat T:%d — forcing refetch',
            listTurns, currentDetail.numTurns
          );
          lastForceRefetchRef.current = now;
          currentDetail.refetch();
        }
      }, 5000);
    }

    return () => {
      if (watchdogTimerRef.current) {
        clearTimeout(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
    };
  }, [sessionsHook.sessions, selectedSessionId]);

  const handleSelectSession = (sessionId: string, machineId: string) => {
    setSelectedSessionId(sessionId);
    setSelectedMachineId(machineId);
  };

  // Get session list's data for the selected session
  const selectedListSession = sessionsHook.sessions.find(s => s.sessionId === selectedSessionId);

  const { viewMode } = useDeviceInfo();
  const isMobile = viewMode === 'mobile';
  const sidebarWidth = viewMode === 'tablet' ? 280 : 320;

  // Mobile: back button clears selection, showing list
  const handleBack = () => {
    setSelectedSessionId(null);
    setSelectedMachineId(undefined);
  };

  // Mobile stack navigation: show either list OR detail
  if (isMobile) {
    if (selectedSessionId) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', position: 'relative' }}>
          {/* Floating back button */}
          <button className="session-mobile-back-fab" onClick={handleBack} title="Back to sessions">
            <ArrowLeft size={16} />
          </button>
          {/* Detail panel */}
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <SessionDetail
              sessionId={selectedSessionId}
              machineId={selectedMachineId}
              onLastSuggestion={setLastSuggestion}
              onSubagents={setSelectedSubagents}
              onDetailMeta={handleDetailMeta}
              onPollControls={handlePollControls}
              externalPolling={true}
              listNumTurns={selectedListSession?.numTurns}
              listLastModified={selectedListSession?.lastModified}
              initialTab={urlTab || undefined}
              highlightMilestoneId={urlMilestone || undefined}
              onSelectSession={handleSelectSession}
            />
          </div>
        </div>
      );
    }

    // Mobile: full-width session list
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <SessionSidebar
          sessionsHook={sessionsHook}
          selectedSessionId={selectedSessionId}
          sidebarHighlightId={urlParent || undefined}
          onSelectSession={handleSelectSession}
          lastSuggestion={lastSuggestion}
          subagents={selectedSubagents}
          gitProjectNames={gitProjectNames}
          scrollToSessionId={hasUrlSession ? (urlParent || searchParams.get('session')) : null}
        />
      </div>
    );
  }

  // Desktop / Tablet: side-by-side layout
  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left sidebar */}
      <div style={{
        width: sidebarWidth,
        minWidth: sidebarWidth,
        borderRight: '1px solid var(--color-border-default)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <SessionSidebar
          sessionsHook={sessionsHook}
          selectedSessionId={selectedSessionId}
          sidebarHighlightId={urlParent || undefined}
          onSelectSession={handleSelectSession}
          lastSuggestion={lastSuggestion}
          subagents={selectedSubagents}
          gitProjectNames={gitProjectNames}
          scrollToSessionId={hasUrlSession ? (urlParent || searchParams.get('session')) : null}
        />
      </div>

      {/* Right detail panel */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {selectedSessionId ? (
          <SessionDetail
            sessionId={selectedSessionId}
            machineId={selectedMachineId}
            onLastSuggestion={setLastSuggestion}
            onSubagents={setSelectedSubagents}
            onDetailMeta={handleDetailMeta}
            onPollControls={handlePollControls}
            externalPolling={true}
            listNumTurns={selectedListSession?.numTurns}
            listLastModified={selectedListSession?.lastModified}
            initialTab={urlTab || undefined}
            highlightMilestoneId={urlMilestone || undefined}
            onSelectSession={handleSelectSession}
          />
        ) : (
          <div className="empty-state" style={{ height: '100%' }}>
            <span style={{ fontSize: 14 }}>Select a session</span>
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              Choose a session from the list to view details
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
