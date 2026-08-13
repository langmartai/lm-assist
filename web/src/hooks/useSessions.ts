'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import { useMachineContext } from '@/contexts/MachineContext';
import type { Session } from '@/lib/types';
import type { BatchCheckResponse } from '@/lib/api-client';
import { workerFetch, detectProxyInfo, detectAppMode, getLastLocalSessionsTotal } from '@/lib/api-client';
import { mergeSessionLists, sortByLastModifiedDesc, applySummaries } from '@/lib/session-list';
import { dedupedRequest } from '@/lib/request-dedupe';

export type SessionFilter = {
  machineId: string | null;
  projectName: string | null;
  status: 'all' | 'running' | 'completed';
  timeRange: 'today' | 'week' | 'month' | 'all';
  search: string;
  sort: 'recent' | 'machine' | 'project';
  showCommands: boolean;
};

const defaultFilter: SessionFilter = {
  machineId: null,
  projectName: null,
  status: 'all',
  timeRange: 'all',
  search: '',
  sort: 'recent',
  showCommands: true,
};

/**
 * Returns true if the session's last user message indicates a command-only session.
 *
 * 🔴 This anchored on '<command-message>' until 2026-08-13 and could therefore never match.
 * Claude Code writes a slash-command turn as a three-tag envelope whose FIRST tag is always
 * '<command-name>':
 *     <command-name>/model</command-name>
 *     <command-message>model</command-message>
 *     <command-args>opus</command-args>
 * Measured over one node's complete session list (GET /projects/sessions, 6584 of 6584 rows,
 * untruncated): startsWith('<command-message>') → 0 matches; startsWith('<command-name>') → 6;
 * every one of the 6 contains both tags, none leads with '<command-message>'. So the
 * "commands" filter in SessionSidebar toggled and filtered nothing.
 *
 * Anchored rather than a contains-check so a human message that merely QUOTES the envelope is
 * not misread as a command session; on the measured corpus both forms select the same 6 rows.
 *
 * ui-apps/assist-sessions/assets/app.js carries a byte-for-byte port of this predicate — the
 * dead filter shipped in both surfaces. Change them together.
 */
function isCommandSession(s: Session): boolean {
  return !!s.lastUserMessage && s.lastUserMessage.trimStart().startsWith('<command-name>');
}

interface UseSessionsOptions {
  /** When true, disables internal polling -- caller manages polling externally */
  externalPolling?: boolean;
  /**
   * Fast first paint. Fetch only this many (most recent) sessions up front, then
   * fill in the remainder in the background once that paint has committed.
   *
   * 117 holds ~6300 sessions => the unlimited fetch is a 9.5MB response; the
   * limit=10 slice is 20KB. Omit to keep the old load-everything behaviour.
   */
  initialLimit?: number;
}

interface UseSessionsResult {
  sessions: Session[];
  allSessions: Session[];
  isLoading: boolean;
  error: string | null;
  filters: SessionFilter;
  setFilters: (f: Partial<SessionFilter>) => void;
  refetch: () => void;
  /** True while the list is still the truncated fast-first-paint slice */
  listTruncated: boolean;
  /** Server-reported total session count while truncated (null when unknown) */
  listTotal: number | null;
  /** True while the post-paint background fetch of the remaining sessions runs */
  isLoadingRest: boolean;
  /** Load the complete list now, bypassing the initialLimit slice */
  loadAll: () => void;
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
  const initialLimit = options?.initialLimit;
  const { apiClient, isLocal, isHybrid } = useAppMode();
  const { onlineMachines, selectedMachineId } = useMachineContext();
  const [allSessions, setAllSessions] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Fast-first-paint state ──
  // `loadedAllRef` is a ref, not state: fetchSessions reads it to decide whether
  // to request a slice or the full list, and that decision must see the value
  // written by the fetch that just finished (a state update wouldn't be visible
  // yet). listTruncated/listTotal drive the UI indicator.
  const loadedAllRef = useRef(false);
  const [listTruncated, setListTruncated] = useState(false);
  const [listTotal, setListTotal] = useState<number | null>(null);
  const [isLoadingRest, setIsLoadingRest] = useState(false);
  // Bumped every time a truncated slice lands. The background-fill effect keys
  // off this rather than off `listTruncated`, so a *second* slice (after the
  // api client upgrades local->hybrid, or after a machine switch) reliably
  // schedules its own fill instead of being swallowed by an unchanged boolean.
  const [sliceGen, setSliceGen] = useState(0);

  // Online machine ids as a stable primitive. onlineMachines is a fresh array on
  // every machines poll; depending on the array identity is what used to refire
  // fetchSessions (and so re-fetch the whole 9.5MB list) every few seconds.
  const machineIdsKey = onlineMachines.map(m => m.id).join(',');
  const machineIds = useMemo(
    () => (machineIdsKey ? machineIdsKey.split(',') : []),
    [machineIdsKey],
  );
  const [filters, setFiltersState] = useState<SessionFilter>(() => {
    if (typeof window !== 'undefined') {
      try {
        const savedProject = localStorage.getItem('session-filter-project');
        const savedShowCmds = localStorage.getItem('session-filter-show-commands');
        const overrides: Partial<SessionFilter> = {};
        if (savedProject) overrides.projectName = savedProject;
        if (savedShowCmds !== null) overrides.showCommands = savedShowCmds !== 'false';
        if (Object.keys(overrides).length > 0) {
          return { ...defaultFilter, ...overrides };
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
    if ('showCommands' in partial) {
      try {
        localStorage.setItem('session-filter-show-commands', String(partial.showCommands));
      } catch { /* ignore */ }
    }
  }, []);

  // Guard against concurrent fetchSessions calls
  const fetchingRef = useRef(false);

  /**
   * Overlay LLM summaries / display names onto whatever list is on screen.
   *
   * Fire-and-forget: never await this from the fetch path. The endpoint carries a
   * 3s timeout and awaiting it delayed first rows by however long it took —
   * summaries are cosmetic, the rows are not. Deduped because every fetch asks
   * for it and each in-flight copy holds one of the ~6 connections.
   */
  const enrichSummaries = useCallback(async () => {
    try {
      const proxyInfo = detectProxyInfo();
      // In proxy mode, hostname:3100 is the wrong host — route via the _coreapi relay.
      // Otherwise defer to detectAppMode(), the ONE place that knows how to reach Core from
      // this page. Hand-rolling `http://${hostname}:${port}` here was wrong twice over: on the
      // LM_HTTPS terminator (:3849) an http:// call from an https page is MIXED CONTENT and the
      // browser blocks it outright — summaries silently never loaded — and it read only the
      // build-time NEXT_PUBLIC port, missing the runtime window.__LM_LOCAL_API_PORT__ override
      // that lets one build serve prod (:3100) and dev (:3200).
      const sumBase = proxyInfo.isProxied ? `${proxyInfo.basePath}/_coreapi` : detectAppMode().baseUrl;
      const data = await dedupedRequest(
        `sessions-summaries:${sumBase}`,
        5000,
        async () => {
          const res = await workerFetch(`${sumBase}/sessions/summaries`, { signal: AbortSignal.timeout(3000) });
          if (!res.ok) throw new Error(`summaries ${res.status}`);
          return res.json();
        },
      );
      const summaryMap = new Map<string, { summary: string; displayName?: string }>();
      for (const s of data?.data?.summaries || []) {
        if (s.sessionId && s.summary) summaryMap.set(s.sessionId, { summary: s.summary, displayName: s.displayName });
      }
      if (summaryMap.size === 0) return;
      // Functional update: applies to whatever list is current, so a fetch that
      // landed in the meantime is never clobbered.
      setAllSessions(prev => applySummaries(prev, summaryMap));
    } catch {
      // Non-critical — proceed without LLM summaries
    }
  }, []);

  // WHICH sessions the list is showing. A machine switch is a genuinely
  // different list, so it goes back through the fast-slice-then-fill path.
  //
  // Deliberately NOT keyed on isLocal/isHybrid/apiClient: the local->hybrid
  // upgrade fires mid-load and shows the SAME sessions, so treating it as a new
  // source ran the whole truncate-then-fill cycle a second time — two full
  // 9.3MB fetches per page load. It just refreshes in place instead.
  const listScopeKey = `${selectedMachineId ?? ''}|${selectedMachineId ? '' : machineIdsKey}`;
  const lastScopeKeyRef = useRef<string | null>(null);

  /**
   * Fetch the session list. Resolves `true` when it actually ran, `false` when it
   * bailed because another fetch was already in flight (the caller may retry).
   */
  const fetchSessions = useCallback(async (fetchOpts?: { loadAll?: boolean }): Promise<boolean> => {
    if (fetchingRef.current) return false;
    fetchingRef.current = true;

    // A different list scope invalidates "we already have everything".
    if (lastScopeKeyRef.current !== listScopeKey) {
      const previous = lastScopeKeyRef.current;
      lastScopeKeyRef.current = listScopeKey;
      // ...but NOT the "no machine selected yet" -> "local machine selected"
      // transition. MachineContext resolves the local machine a beat after mount
      // and it resolves to the very sessions we just fetched, so treating it as a
      // new scope threw away the slice and ran a whole extra truncate+fill.
      const wasUninitialised = previous === null || previous.startsWith('|');
      if (!wasUninitialised) loadedAllRef.current = false;
    }

    // Decide ONCE per fetch, so every branch below agrees.
    const wantAll = fetchOpts?.loadAll === true || loadedAllRef.current || !initialLimit;
    const lim = wantAll ? undefined : { limit: initialLimit };
    // True only for the background fill that follows a truncated first paint —
    // the one case where the incoming list is merged onto what's on screen
    // instead of replacing it.
    const isProgressiveFill = wantAll && !loadedAllRef.current && !!initialLimit;

    try {
      let sessions: Session[];

      if (isLocal) {
        // Pure local mode: single fetch, no machineId needed
        sessions = await apiClient.getSessions(undefined, lim);
      } else if (isHybrid) {
        // Hybrid mode: parallel fetch from all online machines
        // The hybrid client routes local vs remote internally
        const targets = selectedMachineId ? [selectedMachineId] : machineIds;

        if (targets.length === 0) {
          // No machines yet -- fall back to local-only fetch
          sessions = await apiClient.getSessions(undefined, lim);
        } else {
          const results = await Promise.allSettled(
            targets.map(id => apiClient.getSessions(id, lim))
          );
          sessions = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
        }
      } else {
        // Hub mode: parallel fetch from all online machines
        const targets = selectedMachineId ? [selectedMachineId] : machineIds;

        const results = await Promise.allSettled(
          targets.map(id => apiClient.getSessions(id, lim))
        );

        sessions = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
      }

      // Hide sessions with 0 user prompts AND no turns (truly empty sessions).
      // Sessions with turns but 0 user prompts are SDK/programmatic executions — keep them.
      sessions = sessions.filter(s =>
        s.userPromptCount == null || s.userPromptCount > 0 || (s.numTurns != null && s.numTurns > 0)
      );

      // Sort by lastModified descending
      sortByLastModifiedDesc(sessions);

      // LLM summaries are enriched AFTER this paint — see enrichSummaries. This
      // used to be an `await` right here, which is why the rows sat invisible for
      // another 1.7s (up to 3s, its timeout) after the list had already arrived.
      void enrichSummaries();

      // The background fill MERGES onto the slice already on screen so the rows
      // the user is looking at never flicker out. Every other fetch (first
      // paint, poll, refetch) replaces, so deleted sessions really disappear.
      if (isProgressiveFill) {
        setAllSessions(prev => (prev.length > 0 ? mergeSessionLists(prev, sessions) : sessions));
      } else {
        setAllSessions(sessions);
      }

      if (wantAll) {
        loadedAllRef.current = true;
        setListTruncated(false);
      } else {
        // getLastLocalSessionsTotal() is only populated by the local client, so
        // it stays null for a purely remote fetch — the indicator handles that.
        setListTotal(getLastLocalSessionsTotal());
        setListTruncated(true);
        setSliceGen(g => g + 1);
      }
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch sessions');
      return true;
    } finally {
      fetchingRef.current = false;
      setIsLoading(false);
    }
  }, [apiClient, isLocal, isHybrid, machineIds, selectedMachineId, listScopeKey, initialLimit, enrichSummaries]);

  // Latest fetchSessions, for effects that must not re-run when it changes identity.
  const fetchSessionsRef = useRef(fetchSessions);
  fetchSessionsRef.current = fetchSessions;

  const loadAll = useCallback(() => {
    void fetchSessionsRef.current({ loadAll: true });
  }, []);

  // ── Background fill: the remaining sessions, after the first paint commits ──
  // Scheduled on requestIdleCallback (rAF fallback) rather than a blind timer, so
  // the truncated rows are actually on screen before the big fetch starts.
  useEffect(() => {
    if (sliceGen === 0) return;          // no truncated slice has landed yet
    if (loadedAllRef.current) return;    // already have everything

    let cancelled = false;

    const run = async () => {
      if (cancelled || loadedAllRef.current) return;
      setIsLoadingRest(true);
      try {
        // fetchSessions declines while another fetch is in flight (e.g. a poll
        // landed first); retry briefly rather than silently never filling in.
        for (let attempt = 0; attempt < 20; attempt++) {
          if (cancelled || loadedAllRef.current) return;
          if (await fetchSessionsRef.current({ loadAll: true })) return;
          await new Promise(r => setTimeout(r, 150));
        }
      } finally {
        if (!cancelled) setIsLoadingRest(false);
      }
    };

    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };

    if (typeof w.requestIdleCallback === 'function') {
      const handle = w.requestIdleCallback(() => { void run(); }, { timeout: 1500 });
      return () => { cancelled = true; w.cancelIdleCallback?.(handle); };
    }
    // Safari: rAF fires after paint, the 0ms timeout then yields to the browser.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const raf = requestAnimationFrame(() => { timer = setTimeout(() => { void run(); }, 0); });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [sliceGen]);

  // Process batch-check listStatus: update tracking metadata and trigger
  // a full refetch when the session list has changed.
  // NOTE: knownSessionCount/knownLatestModified track the server's single-project
  // values (echoed back for change detection), NOT the client's all-project count.
  const updateFromBatchCheck = useCallback((listStatus: BatchCheckResponse['listStatus']) => {
    if (!listStatus) return;

    // Always echo back the server's values for next poll's change detection —
    // BEFORE the truncation gate below. Skipping the echo while truncated would
    // leave knownSessionCount at 0, so the first poll after the background fill
    // would report `changed` and burn a whole extra full refetch.
    // These track the server's scope (single project), not our all-project list.
    knownSessionCountRef.current = listStatus.totalSessions;
    knownLatestModifiedRef.current = listStatus.latestModified;

    // Fast-first-paint mode: a refetch here would pull the full list and replace
    // our slice with thousands of rows, defeating the fast paint. The background
    // fill is already on its way; per-session updates for the visible rows still
    // flow through the sessions[] side of batch-check.
    if (!loadedAllRef.current) return;

    // If the list changed, trigger a full multi-project refetch
    if (listStatus.changed) {
      void fetchSessions();
    }
  }, [fetchSessions]);

  // Poll by calling fetchSessions directly -- getSessions() uses ifModifiedSince
  // internally, returning cached data (~200 bytes) when nothing has changed.
  useEffect(() => {
    void fetchSessions();
    if (!externalPolling) {
      intervalRef.current = setInterval(() => { void fetchSessions(); }, 3000);
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

  // Auto-clear project filter when the saved project no longer exists in available sessions.
  // This happens when a project is excluded in settings or all its sessions are removed —
  // the <select> dropdown shows "All projects" visually but the React state still holds the
  // stale value, causing 0 results.
  useEffect(() => {
    if (filters.projectName && allSessions.length > 0 && projectNames.length > 0) {
      const match = allSessions.some(
        s => s.projectName === filters.projectName || s.projectPath === filters.projectName
      );
      if (!match) {
        setFilters({ projectName: null });
      }
    }
  }, [filters.projectName, allSessions, projectNames, setFilters]);

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

    // Command session filter
    if (!filters.showCommands) {
      result = result.filter(s => !isCommandSession(s));
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
        sortByLastModifiedDesc(result);
    }

    return result;
  }, [allSessions, filters]);

  const refetch = useCallback(() => { void fetchSessionsRef.current(); }, []);

  return {
    sessions,
    allSessions,
    isLoading,
    error,
    filters,
    setFilters,
    refetch,
    listTruncated,
    listTotal,
    isLoadingRest,
    loadAll,
    updateFromBatchCheck,
    getKnownSessionCount: () => knownSessionCountRef.current,
    getKnownLatestModified: () => knownLatestModifiedRef.current,
    projectNames,
  };
}
