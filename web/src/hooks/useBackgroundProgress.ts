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

// ============================================
// Helper — resolve tier-agent API base URL
// ============================================

function getTierAgentBase(): string {
  if (typeof window === 'undefined') {
    const ssrPort = process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100';
    return `http://localhost:${ssrPort}`;
  }
  const proxyInfo = detectProxyInfo();
  if (proxyInfo.isProxied) return '/_coreapi';
  const { baseUrl } = detectAppMode();
  return baseUrl || `http://localhost:${process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100'}`;
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
  const KNOWLEDGE_DESC = 'Generates knowledge documents from explore sessions';

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

  const hasActiveProcess = cacheStatus.state === 'running';

  return { cacheStatus, knowledge, hasActiveProcess };
}
