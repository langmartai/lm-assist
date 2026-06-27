'use client';
import { useCallback, useEffect, useState } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';

type SessionRow = { missionId: string | null };

export function useMissionActivity() {
  const { apiClient, proxy } = useAppMode();
  const [liveIds, setLiveIds] = useState<Set<string>>(new Set());
  const refresh = useCallback(async () => {
    try {
      const data = await apiClient.fetchPath<{ sessions: SessionRow[] }>('/mission/sessions', { machineId: proxy.machineId || undefined });
      const ids = new Set<string>();
      for (const s of data?.sessions ?? []) if (s.missionId) ids.add(s.missionId);
      setLiveIds(ids);
    } catch {
      setLiveIds(new Set());
    }
  }, [apiClient, proxy.machineId]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { liveIds, refresh };
}
