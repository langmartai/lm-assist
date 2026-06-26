'use client';
import { useState, useEffect, useCallback } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import type { MissionView } from '@/lib/mission-graph-types';

export function useMissionViews() {
  const { apiClient, proxy } = useAppMode();
  const [views, setViews] = useState<MissionView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.fetchPath<{ views: MissionView[] }>('/mission/views', { machineId: proxy.machineId || undefined });
      setViews(data?.views ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiClient, proxy.machineId]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { views, loading, error, refresh };
}
