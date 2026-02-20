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
  milestones?: {
    total: number;
    phase1: number;
    phase2: number;
    inRange: number;
    inRangePhase1: number;
    inRangePhase2: number;
  };
  scanRangeDays?: number | null;
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
    // In proxy mode, use same-origin relative paths — the proxy shim rewrites them
    return '';
  }
  const { baseUrl } = detectAppMode();
  return baseUrl || 'http://localhost:3100';
}

async function fetchStatus<T>(path: string): Promise<T | null> {
  try {
    const base = getTierAgentBase();
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
  const VECTORS_LOADING_DESC = 'Initializing vector store — may take a few minutes on first startup while the index loads from disk.';

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
    const m = pipelineData?.milestones;
    const hasRange = pipelineData?.scanRangeDays !== null && pipelineData?.scanRangeDays !== undefined;
    const detected = m ? (hasRange ? m.inRange : m.total) : 0;
    const enriched = m ? (hasRange ? m.inRangePhase2 : m.phase2) : 0;
    const enrichPct = detected > 0 ? Math.round((enriched / detected) * 100) : 0;
    // Compact label shown directly in the topbar chip
    const countLabel = detected > 0 ? `${detected} / ${enriched}` : 'Milestone';
    const countDetail = detected > 0 ? `${detected} detected · ${enriched} enriched (${enrichPct}%)` : undefined;

    if (!p) return { state: 'idle', percent: 0, label: countLabel, description: MILESTONE_DESC, detail: countDetail };

    if (p.status === 'processing') {
      const total = p.queueSize + p.processed;
      const percent = total > 0 ? Math.round((p.processed / total) * 100) : 0;
      return { state: 'running', percent, label: countLabel, description: MILESTONE_DESC, detail: `${p.processed}/${total} enriching · ${countDetail ?? ''}`.trim().replace(/·\s*$/, '') };
    }
    if (detected > 0) {
      return { state: 'complete', percent: enrichPct, label: countLabel, description: MILESTONE_DESC, detail: countDetail };
    }
    if (p.processed > 0 || p.errors > 0 || p.vectorErrors > 0) {
      const totalErrors = p.errors + p.vectorErrors;
      const state: ProcessState = p.status === 'processing' && totalErrors > 0 ? 'error' : 'complete';
      const parts: string[] = [];
      if (p.processed > 0) parts.push(`${p.processed} processed`);
      if (p.vectorsIndexed > 0) parts.push(`${p.vectorsIndexed} vectors`);
      if (totalErrors > 0) parts.push(`${totalErrors} error${totalErrors > 1 ? 's' : ''}`);
      return { state, percent: 100, label: 'Milestone', description: MILESTONE_DESC, detail: parts.join(', ') };
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
      // Show as loading — vector store auto-initializes on first status poll,
      // but LanceDB may take a minute or two to connect and load the index.
      return { state: 'running', percent: 0, label: 'Vectors', description: VECTORS_LOADING_DESC, detail: 'Loading vector index...' };
    }
    if (v.total > 0) {
      const parts: string[] = [];
      if (v.session > 0) parts.push(`${v.session} session`);
      if (v.milestone > 0) parts.push(`${v.milestone} milestone`);
      if ((v as any).knowledge > 0) parts.push(`${(v as any).knowledge} knowledge`);
      const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      return { state: 'complete', percent: 100, label: 'Vectors', description: VECTORS_DESC, detail: `${v.total} vectors${breakdown}` };
    }
    return { state: 'idle', percent: 0, label: 'Vectors', description: VECTORS_DESC, detail: 'No vectors indexed' };
  }, [pipelineData]);

  const hasActiveProcess = cacheStatus.state === 'running' || milestone.state === 'running' || vectorStore.state === 'running';

  return { cacheStatus, milestone, knowledge, vectorStore, hasActiveProcess };
}
