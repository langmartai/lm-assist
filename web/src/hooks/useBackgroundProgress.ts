'use client';

import { useState, useEffect, useMemo } from 'react';
import { detectAppMode, detectProxyInfo } from '@/lib/api-client';

// ============================================
// Types
// ============================================

export type ProcessState = 'idle' | 'running' | 'complete' | 'error';

export interface ProcessStatus {
  state: ProcessState;
  percent: number;
  label: string;
  detail?: string;
  description: string;
}

interface SessionCacheStats {
  memoryCacheSize: number;
  rawMemoryCacheSize: number;
  isWatching: boolean;
  lmdb?: {
    sessionCount: number;
    rawCount: number;
  };
}

interface KnowledgeGenerateStats {
  candidates: number;
  generated: number;
}

interface MilestonePipelineStatus {
  vectors: {
    total: number;
    session: number;
    milestone: number;
    isInitialized: boolean;
  };
  pipeline: {
    status: string;
    queueSize: number;
    processed: number;
    errors: number;
    vectorsIndexed: number;
    vectorErrors: number;
  };
}

// ============================================
// Helper — resolve tier-agent API base URL
// ============================================

function getTierAgentBase(): string {
  if (typeof window === 'undefined') return 'http://localhost:3100';
  const proxyInfo = detectProxyInfo();
  if (proxyInfo.isProxied) {
    // In proxy mode, tier-agent endpoints aren't directly reachable.
    // Return empty string — fetches will fail silently and chips won't show.
    return '';
  }
  const { baseUrl } = detectAppMode();
  return baseUrl || 'http://localhost:3100';
}

async function fetchStatus<T>(path: string): Promise<T | null> {
  try {
    const base = getTierAgentBase();
    if (!base) return null;
    const res = await fetch(`${base}${path}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json && typeof json === 'object' && 'data' in json) return json.data as T;
    return json as T;
  } catch {
    return null;
  }
}

// ============================================
// Hook
// ============================================

export function useBackgroundProgress() {
  const [cacheData, setCacheData] = useState<SessionCacheStats | null>(null);
  const [pipelineData, setPipelineData] = useState<MilestonePipelineStatus | null>(null);
  const [knowledgeData, setKnowledgeData] = useState<KnowledgeGenerateStats | null>(null);

  // Adaptive polling for cache stats — uses returned data to pick next interval
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const poll = async () => {
      const data = await fetchStatus<SessionCacheStats>('/session-cache/stats');
      if (cancelled) return;
      setCacheData(data);
      const interval = 30000;
      timeout = setTimeout(poll, interval);
    };

    poll();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, []);

  // Adaptive polling for pipeline status
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const poll = async () => {
      const data = await fetchStatus<MilestonePipelineStatus>('/milestone-pipeline/status');
      if (cancelled) return;
      setPipelineData(data);
      const interval = data?.pipeline?.status === 'processing' ? 3000 : 30000;
      timeout = setTimeout(poll, interval);
    };

    poll();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, []);

  // Knowledge generate stats — scans all projects for candidates
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const poll = async () => {
      const data = await fetchStatus<KnowledgeGenerateStats>('/knowledge/generate/stats');
      if (cancelled) return;
      setKnowledgeData(data);
      timeout = setTimeout(poll, 60000);
    };

    poll();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, []);

  // Derive states
  const CACHE_DESC = 'LMDB-backed session cache (instant reads via mmap)';
  const MILESTONE_DESC = 'Extracts milestones from sessions and indexes them';
  const KNOWLEDGE_DESC = 'Generates knowledge documents from explore sessions';
  const VECTORS_DESC = 'Semantic search index for sessions and milestones';

  const cacheStatus = useMemo((): ProcessStatus => {
    if (!cacheData) return { state: 'idle', percent: 0, label: 'Cache', description: CACHE_DESC };
    const sessions = cacheData.lmdb?.sessionCount ?? cacheData.memoryCacheSize ?? 0;
    const raw = cacheData.lmdb?.rawCount ?? cacheData.rawMemoryCacheSize ?? 0;
    if (sessions > 0) {
      return {
        state: 'complete',
        percent: 100,
        label: 'Cache',
        description: CACHE_DESC,
        detail: `${sessions.toLocaleString()} sessions, ${raw} raw${cacheData.isWatching ? ' · watching' : ''}`,
      };
    }
    return { state: 'idle', percent: 0, label: 'Cache', description: CACHE_DESC };
  }, [cacheData]);

  const milestone = useMemo((): ProcessStatus => {
    const p = pipelineData?.pipeline;
    if (!p) return { state: 'idle', percent: 0, label: 'Milestone', description: MILESTONE_DESC };
    if (p.status === 'processing') {
      const total = p.queueSize + p.processed;
      const percent = total > 0 ? Math.round((p.processed / total) * 100) : 0;
      return { state: 'running', percent, label: 'Milestone', description: MILESTONE_DESC, detail: `${p.processed}/${total} processed, ${p.vectorsIndexed} vectors` };
    }
    if (p.errors > 0 || p.vectorErrors > 0) {
      return { state: 'error', percent: 100, label: 'Milestone', description: MILESTONE_DESC, detail: `${p.errors + p.vectorErrors} error${p.errors + p.vectorErrors > 1 ? 's' : ''}` };
    }
    if (p.processed > 0) {
      return { state: 'complete', percent: 100, label: 'Milestone', description: MILESTONE_DESC, detail: `${p.processed} processed, ${p.vectorsIndexed} vectors` };
    }
    return { state: 'idle', percent: 0, label: 'Milestone', description: MILESTONE_DESC };
  }, [pipelineData]);

  const knowledge = useMemo((): ProcessStatus => {
    if (!knowledgeData) return { state: 'idle', percent: 0, label: 'Knowledge', description: KNOWLEDGE_DESC };
    const generated = knowledgeData.generated ?? 0;
    const candidates = knowledgeData.candidates ?? 0;
    const total = generated + candidates;
    if (total === 0) return { state: 'idle', percent: 0, label: 'Knowledge', description: KNOWLEDGE_DESC };
    const percent = Math.round((generated / total) * 100);
    return {
      state: candidates > 0 ? 'running' : 'complete',
      percent,
      label: 'Knowledge',
      description: KNOWLEDGE_DESC,
      detail: `${generated} generated, ${candidates} candidates remaining`,
    };
  }, [knowledgeData]);

  const vectorStore = useMemo((): ProcessStatus => {
    const v = pipelineData?.vectors;
    if (!v) return { state: 'idle', percent: 0, label: 'Vectors', description: VECTORS_DESC };
    if (!v.isInitialized) {
      return { state: 'running', percent: 0, label: 'Vectors', description: VECTORS_DESC, detail: 'Loading vector store...' };
    }
    if (v.total > 0) {
      return { state: 'complete', percent: 100, label: 'Vectors', description: VECTORS_DESC, detail: `${v.total} vectors (${v.session} session, ${v.milestone} milestone)` };
    }
    return { state: 'idle', percent: 0, label: 'Vectors', description: VECTORS_DESC, detail: 'No vectors indexed' };
  }, [pipelineData]);

  const hasActiveProcess = cacheStatus.state === 'running' || milestone.state === 'running' || vectorStore.state === 'running';

  return { cacheStatus, milestone, knowledge, vectorStore, hasActiveProcess };
}
