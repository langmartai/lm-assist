'use client';
import { useState, useEffect, useCallback } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import type { MissionView, MissionNode, MissionEdge, MissionFilter } from '@/lib/mission-graph-types';

export type GraphSource = { viewId: string } | { filter?: MissionFilter[]; expand?: { direction?: string; depth?: number } } | null;
type GraphData = { nodes: MissionNode[]; edges: MissionEdge[] };

export function useMissionGraph(source: GraphSource) {
  const { apiClient, proxy } = useAppMode();
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [view, setView] = useState<MissionView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = source ? JSON.stringify(source) : '';
  const refresh = useCallback(async () => {
    if (!source) { setGraph(null); setView(null); return; }
    setLoading(true);
    setError(null);
    try {
      if ('viewId' in source) {
        const data = await apiClient.fetchPath<{ view: MissionView; nodes: MissionNode[]; edges: MissionEdge[] }>(
          `/mission/views/${encodeURIComponent(source.viewId)}/graph`,
          { machineId: proxy.machineId || undefined },
        );
        setView(data?.view ?? null);
        setGraph({ nodes: data?.nodes ?? [], edges: data?.edges ?? [] });
      } else {
        const data = await apiClient.fetchPath<GraphData>('/mission/graph', { method: 'POST', body: source, machineId: proxy.machineId || undefined });
        setView(null);
        setGraph({ nodes: data?.nodes ?? [], edges: data?.edges ?? [] });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiClient, proxy.machineId, key]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { graph, view, loading, error, refresh };
}
