'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import type { SessionDetail, SessionMessage, SubagentSession } from '@/lib/types';

interface UseSessionDetailOptions {
  sessionId: string | null;
  machineId?: string;
  enabled?: boolean;
  /** When true, disables internal polling — caller manages polling externally */
  externalPolling?: boolean;
  /** Number of user prompts to fetch from server (default: 200) */
  lastN?: number;
}

interface UseSessionDetailResult {
  detail: SessionDetail | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
  /** Trigger update check from external batch result */
  applyBatchCheck: (check: {
    exists: boolean;
    fileSize: number;
    agentIds: string[];
    lastModified: string;
    changed: boolean;
    agentsChanged: boolean;
  }) => void;
  /** Current tracking state for batch requests */
  pollState: {
    knownFileSize: number;
    knownAgentCount: number;
  };
}

/**
 * Merge subagent conversation messages into the main message list.
 *
 * Task-spawned agents use turnIndex/lineIndex from session endpoint.
 * Other agents (prompt_suggestion, compact) fall back to parentUuid positioning.
 */
function mergeSubagentConversations(
  messages: SessionMessage[],
  subagents: SubagentSession[],
  rawMessages?: any[],
): SessionMessage[] {
  const agentsWithConv = subagents.filter(a => a.conversation?.length);
  if (agentsWithConv.length === 0) return messages;

  // Build UUID -> lineIndex map from rawMessages (fallback for agents without direct positioning)
  const uuidToLineIndex = new Map<string, number>();
  if (rawMessages) {
    for (const msg of rawMessages) {
      if (msg.uuid && msg.lineIndex !== undefined) {
        uuidToLineIndex.set(msg.uuid, msg.lineIndex);
      }
    }
  }

  // Build sorted lineIndex -> turnIndex map from messages for fallback lookups
  const lineToTurn: Array<{ lineIndex: number; turnIndex: number }> = [];
  for (const m of messages) {
    if (m.lineIndex !== undefined && m.turnIndex !== undefined) {
      lineToTurn.push({ lineIndex: m.lineIndex, turnIndex: m.turnIndex });
    }
  }
  lineToTurn.sort((a, b) => a.lineIndex - b.lineIndex);

  const agentMessages: SessionMessage[] = [];

  for (let agentIdx = 0; agentIdx < agentsWithConv.length; agentIdx++) {
    const agent = agentsWithConv[agentIdx];
    if (!agent.conversation) continue;

    let effectiveLineIndex: number;
    let effectiveTurnIndex: number;

    if (agent.lineIndex !== undefined && agent.turnIndex !== undefined) {
      // Direct positioning from session endpoint (Task-spawned agents)
      effectiveLineIndex = agent.lineIndex;
      effectiveTurnIndex = agent.turnIndex;
    } else {
      // Fallback: resolve from parentUuid
      const parentLineIndex = agent.parentUuid
        ? uuidToLineIndex.get(agent.parentUuid)
        : undefined;
      if (parentLineIndex === undefined) continue;

      effectiveLineIndex = parentLineIndex + 0.001;

      // Find turnIndex from nearest message at/before parentLineIndex
      let foundTurn = 0;
      for (let i = lineToTurn.length - 1; i >= 0; i--) {
        if (lineToTurn[i].lineIndex <= parentLineIndex) {
          foundTurn = lineToTurn[i].turnIndex;
          break;
        }
      }
      effectiveTurnIndex = foundTurn;
    }

    let validIdx = 0;
    for (const msg of agent.conversation) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (!content.trim()) continue;

      const offset = (validIdx + 1) * 0.0001; // Small offset to maintain order after base
      agentMessages.push({
        id: `agent-${agent.agentId || agentIdx}-${msg.type}-${validIdx}`,
        type: msg.type === 'user' ? 'agent_user' : 'agent_assistant',
        content,
        turnIndex: effectiveTurnIndex,
        lineIndex: effectiveLineIndex + offset,
        agentId: agent.agentId,
        subagentType: agent.type,
      });
      validIdx++;
    }
  }

  if (agentMessages.length === 0) return messages;

  // Remove existing basic agent_user messages for agents that now have full conversations
  const agentIdsWithConv = new Set(agentsWithConv.map(a => a.agentId));
  const filtered = messages.filter(m =>
    !(m.type === 'agent_user' && m.agentId && agentIdsWithConv.has(m.agentId))
  );

  // Merge and re-sort — matches admin-web sort logic
  const merged = [...filtered, ...agentMessages];
  merged.sort((a, b) => {
    // Primary: lineIndex (JSONL line order)
    if (a.lineIndex !== undefined && b.lineIndex !== undefined) return a.lineIndex - b.lineIndex;
    // Fallback: turnIndex
    if (a.turnIndex !== undefined && b.turnIndex !== undefined) return a.turnIndex - b.turnIndex;
    return 0;
  });

  return merged;
}

export function useSessionDetail({
  sessionId,
  machineId,
  enabled = true,
  externalPolling = false,
  lastN = 200,
}: UseSessionDetailOptions): UseSessionDetailResult {
  const { apiClient } = useAppMode();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastLineRef = useRef<number>(0);
  const lastModifiedRef = useRef<string>('');
  const lastFileSizeRef = useRef<number>(0);
  const lastAgentCountRef = useRef<number>(0);
  const isActiveRef = useRef(false);
  const fetchingRef = useRef(false);
  // Count consecutive delta failures to trigger full refetch
  const deltaFailCountRef = useRef(0);
  // Track when fetching started (to detect stuck fetches)
  const fetchingStartRef = useRef<number | null>(null);
  // Stable refs for callbacks — prevents polling teardown on re-renders
  const fetchDetailRef = useRef<() => Promise<void>>(async () => {});
  const checkForUpdatesRef = useRef<() => Promise<void>>(async () => {});
  const applyBatchCheckRef = useRef<UseSessionDetailResult['applyBatchCheck']>(async () => {});

  const fetchDetail = useCallback(async () => {
    if (!sessionId || !enabled) return;

    try {
      setIsLoading(true);

      // Fetch session data and subagent conversations in parallel
      const [result, subagentsData] = await Promise.all([
        apiClient.getSessionConversation(sessionId, { lastN }, machineId),
        apiClient.getSessionSubagents(sessionId, machineId),
      ]);

      // Extract raw data for subagent positioning
      const rawMessages = (result as any)._rawMessages || [];

      // Merge subagent conversations into chat messages
      if (subagentsData.sessions.length > 0) {
        // Enrich /subagents data with positioning from session endpoint's SubagentInvocation
        // (session endpoint has turnIndex/lineIndex matching the Task tool call)
        const sessionSubagents = result.subagents || [];
        const positionMap = new Map<string, { turnIndex?: number; lineIndex?: number }>();
        for (const s of sessionSubagents) {
          if (s.agentId) {
            positionMap.set(s.agentId, {
              turnIndex: (s as any).turnIndex,
              lineIndex: (s as any).lineIndex,
            });
          }
        }
        for (const s of subagentsData.sessions) {
          const pos = positionMap.get(s.agentId);
          if (pos) {
            if (pos.turnIndex !== undefined) s.turnIndex = pos.turnIndex;
            if (pos.lineIndex !== undefined) s.lineIndex = pos.lineIndex;
          }
        }

        result.messages = mergeSubagentConversations(
          result.messages,
          subagentsData.sessions,
          rawMessages,
        );
        // Use richer subagent data from /subagents endpoint
        result.subagents = subagentsData.sessions;
      }

      setDetail(result);
      lastLineRef.current = result.lineCount || result.messages?.length || 0;
      isActiveRef.current = result.isActive || false;
      deltaFailCountRef.current = 0;

      // Seed tracking refs from session response so the first poll cycle
      // doesn't spuriously report "changed". GET /sessions/:id now returns
      // lastModified (file mtime) directly, avoiding the extra batch-check call.
      if (result.lastModified) {
        lastModifiedRef.current = result.lastModified;
      }
      lastAgentCountRef.current = subagentsData.sessions.length;
      // Fallback: use current time so polling is never blocked
      if (!lastModifiedRef.current) {
        lastModifiedRef.current = new Date().toISOString();
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch session');
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, sessionId, machineId, enabled, lastN]);

  // Keep ref in sync
  fetchDetailRef.current = fetchDetail;

  // Delta fetch — get new messages + refresh subagents, merge into existing state.
  // Falls back to full refetch after 3 consecutive failures.
  const fetchDelta = useCallback(async () => {
    if (!sessionId || !enabled) return;

    const fromLine = lastLineRef.current;
    if (fromLine === 0) return; // No initial fetch yet

    try {
      // Fetch delta messages and subagents in parallel
      const [delta, subagentsData] = await Promise.all([
        apiClient.getSessionConversation(sessionId, { fromLine }, machineId),
        apiClient.getSessionSubagents(sessionId, machineId),
      ]);

      const rawMessages = (delta as any)._rawMessages || [];

      // Enrich subagent positioning from session endpoint
      if (subagentsData.sessions.length > 0) {
        const sessionSubagents = delta.subagents || [];
        const positionMap = new Map<string, { turnIndex?: number; lineIndex?: number }>();
        for (const s of sessionSubagents) {
          if (s.agentId) {
            positionMap.set(s.agentId, {
              turnIndex: (s as any).turnIndex,
              lineIndex: (s as any).lineIndex,
            });
          }
        }
        for (const s of subagentsData.sessions) {
          const pos = positionMap.get(s.agentId);
          if (pos) {
            if (pos.turnIndex !== undefined) s.turnIndex = pos.turnIndex;
            if (pos.lineIndex !== undefined) s.lineIndex = pos.lineIndex;
          }
        }
      }

      // Filter to only truly new messages (lineIndex > current)
      const newMessages = (delta.messages || []).filter(
        (m: SessionMessage) => m.lineIndex !== undefined && m.lineIndex > fromLine
      );

      console.debug('[delta] fromLine=%d, deltaMsgs=%d, newMsgs=%d, subagents=%d, deltaLineCount=%s',
        fromLine, delta.messages?.length || 0, newMessages.length,
        subagentsData.sessions.length, delta.lineCount);

      setDetail(prev => {
        if (!prev) return delta;

        // Merge new main messages
        let mergedMessages = prev.messages;
        if (newMessages.length > 0) {
          const existingLines = new Set(
            prev.messages
              .filter(m => m.lineIndex !== undefined)
              .map(m => m.lineIndex)
          );
          const uniqueNew = newMessages.filter(
            (m: SessionMessage) => !existingLines.has(m.lineIndex!)
          );
          if (uniqueNew.length > 0) {
            mergedMessages = [...prev.messages, ...uniqueNew];
          }
        }

        // Strip old agent messages before re-merging with fresh subagent data
        const baseMessages = mergedMessages.filter(m =>
          m.type !== 'agent_user' && m.type !== 'agent_assistant'
        );

        // Re-merge subagent conversations into messages
        const finalMessages = subagentsData.sessions.length > 0
          ? mergeSubagentConversations(baseMessages, subagentsData.sessions, rawMessages)
          : baseMessages;

        // Sort
        finalMessages.sort((a, b) => {
          if (a.lineIndex !== undefined && b.lineIndex !== undefined) return a.lineIndex - b.lineIndex;
          if (a.turnIndex !== undefined && b.turnIndex !== undefined) return a.turnIndex - b.turnIndex;
          return 0;
        });

        return {
          ...prev,
          messages: finalMessages,
          subagents: subagentsData.sessions.length > 0 ? subagentsData.sessions : prev.subagents,
          lineCount: delta.lineCount || prev.lineCount,
          totalCostUsd: delta.totalCostUsd ?? prev.totalCostUsd,
          numTurns: delta.numTurns ?? prev.numTurns,
          inputTokens: delta.inputTokens ?? prev.inputTokens,
          outputTokens: delta.outputTokens ?? prev.outputTokens,
          lastModified: delta.lastModified ?? prev.lastModified,
          isActive: delta.isActive ?? prev.isActive,
        };
      });

      // Update tracking — use lastLineIndex from API response, only advance
      const newLineCount = delta.lineCount ?? fromLine;
      if (newLineCount > lastLineRef.current) {
        lastLineRef.current = newLineCount;
      }
      deltaFailCountRef.current = 0;
    } catch {
      deltaFailCountRef.current++;
    }
  }, [apiClient, sessionId, machineId, enabled]);

  // Apply external batch check result — used when parent manages polling
  const applyBatchCheck = useCallback(async (check: {
    exists: boolean;
    fileSize: number;
    agentIds: string[];
    lastModified: string;
    changed: boolean;
    agentsChanged: boolean;
  }) => {
    if (!sessionId || !enabled) return;
    if (!check.exists) return;
    if (fetchingRef.current) return;

    // Update active status
    isActiveRef.current = !!check.lastModified &&
      (Date.now() - new Date(check.lastModified).getTime()) < 15000;

    // Seed refs if needed
    if (!lastModifiedRef.current) {
      if (check.lastModified) lastModifiedRef.current = check.lastModified;
      lastFileSizeRef.current = check.fileSize || 0;
      lastAgentCountRef.current = check.agentIds?.length || 0;
      return;
    }

    if (check.changed || check.agentsChanged) {
      if (check.lastModified) lastModifiedRef.current = check.lastModified;
      lastFileSizeRef.current = check.fileSize;
      lastAgentCountRef.current = check.agentIds?.length || 0;
      fetchingRef.current = true;
      fetchingStartRef.current = Date.now();
      try {
        if (deltaFailCountRef.current >= 3 || lastLineRef.current === 0) {
          await fetchDetail();
        } else {
          await fetchDelta();
        }
      } finally {
        fetchingRef.current = false;
        fetchingStartRef.current = null;
      }
    }
  }, [sessionId, enabled, fetchDetail, fetchDelta]);

  // Keep ref in sync
  applyBatchCheckRef.current = applyBatchCheck;

  // Lightweight change check — uses batch-check endpoint (stat-only, ~10ms).
  // When lastModified changes, fetches delta (only new messages).
  // Falls back to full refetch after 3 consecutive delta failures.
  const checkForUpdates = useCallback(async () => {
    if (!sessionId || !enabled) return;
    if (fetchingRef.current) {
      // Safety: if fetching has been stuck for >30s, force reset
      if (fetchingStartRef.current && Date.now() - fetchingStartRef.current > 30000) {
        console.debug('[poll] force-reset stuck fetchingRef after 30s');
        fetchingRef.current = false;
      } else {
        console.debug('[poll] skip: fetching in progress');
        return;
      }
    }

    try {
      const batchResult = await apiClient.batchCheckSessions({
        sessions: [{
          sessionId,
          knownFileSize: lastFileSizeRef.current || undefined,
          knownAgentCount: lastAgentCountRef.current || undefined,
        }],
      }, machineId);

      const check = batchResult.sessions[sessionId];
      if (!check || !check.exists) return;

      // Update active status based on last modification (15s window)
      isActiveRef.current = !!check.lastModified &&
        (Date.now() - new Date(check.lastModified).getTime()) < 15000;

      // If we haven't seeded refs yet, seed them now without fetching
      // (initial fetchDetail should have loaded the data already)
      if (!lastModifiedRef.current) {
        if (check.lastModified) lastModifiedRef.current = check.lastModified;
        lastFileSizeRef.current = check.fileSize || 0;
        lastAgentCountRef.current = check.agentIds?.length || 0;
        console.debug('[poll] seeded refs', { mtime: check.lastModified, size: check.fileSize, agents: check.agentIds?.length });
        return;
      }

      if (check.changed || check.agentsChanged) {
        console.debug('[poll] change detected', {
          changed: check.changed, agentsChanged: check.agentsChanged,
          oldSize: lastFileSizeRef.current, newSize: check.fileSize,
          oldMtime: lastModifiedRef.current, newMtime: check.lastModified,
        });
        if (check.lastModified) lastModifiedRef.current = check.lastModified;
        lastFileSizeRef.current = check.fileSize;
        lastAgentCountRef.current = check.agentIds?.length || 0;
        fetchingRef.current = true;
        fetchingStartRef.current = Date.now();
        try {
          if (deltaFailCountRef.current >= 3 || lastLineRef.current === 0) {
            console.debug('[poll] full refetch (failCount=%d, lastLine=%d)', deltaFailCountRef.current, lastLineRef.current);
            await fetchDetail();
          } else {
            console.debug('[poll] delta fetch from line %d', lastLineRef.current);
            await fetchDelta();
          }
        } finally {
          fetchingRef.current = false;
          fetchingStartRef.current = null;
        }
      }
    } catch (err) {
      console.debug('[poll] error:', err);
    }
  }, [apiClient, sessionId, machineId, enabled, fetchDetail, fetchDelta]);

  // Keep ref in sync
  checkForUpdatesRef.current = checkForUpdates;

  // Initial fetch when session changes — use ref to avoid re-triggering on callback identity changes
  useEffect(() => {
    if (!sessionId) {
      setDetail(null);
      return;
    }
    lastLineRef.current = 0;
    lastModifiedRef.current = '';
    lastFileSizeRef.current = 0;
    lastAgentCountRef.current = 0;
    isActiveRef.current = false;
    fetchingRef.current = false;
    fetchDetailRef.current();
  }, [sessionId, machineId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Self-scheduling poll loop — each poll waits for completion before scheduling the next.
  // Avoids setInterval issues (Chrome throttling, overlapping async calls).
  // Active sessions: 1s delay between polls
  // Inactive sessions: 5s delay
  // Skipped when externalPolling=true (parent manages polling via applyBatchCheck)
  useEffect(() => {
    if (!sessionId || !enabled || externalPolling) return;

    let isMounted = true;

    const scheduleNext = () => {
      if (!isMounted) return;
      const delay = isActiveRef.current ? 1000 : 5000;
      intervalRef.current = setTimeout(async () => {
        if (!isMounted) return;
        try {
          await checkForUpdatesRef.current();
        } catch {
          // ignore — checkForUpdates has its own error handling
        }
        scheduleNext();
      }, delay);
    };

    // Start after initial fetch completes
    const startTimer = setTimeout(scheduleNext, 500);

    return () => {
      isMounted = false;
      clearTimeout(startTimer);
      if (intervalRef.current) clearTimeout(intervalRef.current);
    };
  }, [sessionId, enabled, externalPolling]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stable ref for pollState — avoids re-render churn from creating new objects
  const pollStateRef = useRef({ knownFileSize: 0, knownAgentCount: 0 });
  pollStateRef.current.knownFileSize = lastFileSizeRef.current;
  pollStateRef.current.knownAgentCount = lastAgentCountRef.current;

  // Stable wrapper — identity never changes, delegates to latest ref
  const stableApplyBatchCheck = useCallback<UseSessionDetailResult['applyBatchCheck']>(
    (check) => applyBatchCheckRef.current(check),
    [],
  );

  return {
    detail,
    isLoading,
    error,
    refetch: fetchDetail,
    applyBatchCheck: stableApplyBatchCheck,
    pollState: pollStateRef.current,
  };
}
