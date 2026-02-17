'use client';

import { useState, useCallback, useRef } from 'react';
import { detectAppMode } from '@/lib/api-client';
import type { DagGraph, BranchInfo, RelatedSessions, UnifiedDag, DagViewMode } from '@/components/dag/dag-types';

interface SessionDagState {
  sessionDag: { graph: DagGraph; team: any } | null;
  messageDag: { graph: DagGraph; branches: BranchInfo[] } | null;
  unifiedDag: UnifiedDag | null;
  related: RelatedSessions | null;
  loading: boolean;
  error: string | null;
}

async function fetchDagJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  const json = await res.json();
  // Unwrap { data: ... } wrappers (same as api-client fetchJson)
  if (json && typeof json === 'object') {
    if ('data' in json) return json.data as T;
    if ('result' in json) return json.result as T;
  }
  return json as T;
}

export function useSessionDag(sessionId: string | null) {
  const [state, setState] = useState<SessionDagState>({
    sessionDag: null,
    messageDag: null,
    unifiedDag: null,
    related: null,
    loading: false,
    error: null,
  });

  // Track which views have been fetched to avoid re-fetching
  const fetched = useRef<Set<DagViewMode>>(new Set());
  const lastSessionId = useRef<string | null>(null);

  // Reset when session changes
  if (sessionId !== lastSessionId.current) {
    lastSessionId.current = sessionId;
    fetched.current = new Set();
    // Don't setState here (causes render loop), the fetch functions will handle it
  }

  const getBaseUrl = useCallback(() => {
    return detectAppMode().baseUrl;
  }, []);

  const fetchSessionDag = useCallback(async () => {
    if (!sessionId) return;
    if (fetched.current.has('session') && lastSessionId.current === sessionId) return;

    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const baseUrl = getBaseUrl();
      const [dagResult, relatedResult] = await Promise.all([
        fetchDagJson<{ graph: DagGraph; team: any }>(`${baseUrl}/sessions/${sessionId}/session-dag?includeForks=true`),
        fetchDagJson<RelatedSessions>(`${baseUrl}/sessions/${sessionId}/related`),
      ]);
      fetched.current.add('session');
      setState(s => ({ ...s, sessionDag: dagResult, related: relatedResult, loading: false }));
    } catch (err: any) {
      setState(s => ({ ...s, loading: false, error: err.message || 'Failed to fetch session DAG' }));
    }
  }, [sessionId, getBaseUrl]);

  const fetchMessageDag = useCallback(async () => {
    if (!sessionId) return;
    if (fetched.current.has('message') && lastSessionId.current === sessionId) return;

    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const baseUrl = getBaseUrl();
      const result = await fetchDagJson<{ graph: DagGraph; branches: BranchInfo[] }>(
        `${baseUrl}/sessions/${sessionId}/dag`
      );
      fetched.current.add('message');
      setState(s => ({ ...s, messageDag: result, loading: false }));
    } catch (err: any) {
      setState(s => ({ ...s, loading: false, error: err.message || 'Failed to fetch message DAG' }));
    }
  }, [sessionId, getBaseUrl]);

  const fetchUnifiedDag = useCallback(async () => {
    if (!sessionId) return;
    if (fetched.current.has('unified') && lastSessionId.current === sessionId) return;

    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const baseUrl = getBaseUrl();
      const result = await fetchDagJson<UnifiedDag>(`${baseUrl}/dag/unified/${sessionId}`);
      fetched.current.add('unified');
      setState(s => ({ ...s, unifiedDag: result, loading: false }));
    } catch (err: any) {
      setState(s => ({ ...s, loading: false, error: err.message || 'Failed to fetch unified DAG' }));
    }
  }, [sessionId, getBaseUrl]);

  const refetch = useCallback(() => {
    fetched.current = new Set();
    setState({
      sessionDag: null,
      messageDag: null,
      unifiedDag: null,
      related: null,
      loading: false,
      error: null,
    });
  }, []);

  return {
    ...state,
    fetchSessionDag,
    fetchMessageDag,
    fetchUnifiedDag,
    refetch,
  };
}
