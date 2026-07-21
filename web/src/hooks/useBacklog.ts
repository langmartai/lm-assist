'use client';
import { useCallback, useEffect, useState } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import type { BacklogGraphEdge, BacklogGraphNode, BacklogItemFull } from '@/lib/backlog-types';

type GraphData = { nodes: BacklogGraphNode[]; edges: BacklogGraphEdge[] };

export function useBacklogGraph(includeRemoved: boolean) {
  const { apiClient, proxy } = useAppMode();
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.fetchPath<GraphData>(
        `/backlog/graph${includeRemoved ? '?includeRemoved=true' : ''}`,
        { machineId: proxy.machineId || undefined },
      );
      setGraph({ nodes: data?.nodes ?? [], edges: data?.edges ?? [] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiClient, proxy.machineId, includeRemoved]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { graph, loading, error, refresh };
}

export function useBacklogItem(id: string | null, refreshKey = 0) {
  const { apiClient, proxy } = useAppMode();
  const [item, setItem] = useState<BacklogItemFull | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) { setItem(null); setError(null); setLoading(false); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    apiClient.fetchPath<{ item: BacklogItemFull }>(`/backlog/${encodeURIComponent(id)}`, { machineId: proxy.machineId || undefined })
      .then((d) => { if (!cancelled) setItem(d?.item ?? null); })
      .catch((e) => { if (!cancelled) { setItem(null); setError((e as Error).message); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, apiClient, proxy.machineId, refreshKey]);
  return { item, loading, error };
}

/** Write helpers — thin wrappers over the /backlog routes. Every mutation returns the
 *  updated item envelope; callers refresh the graph/detail views afterwards. Notes
 *  added from this UI self-declare as the `web` session kind. */
export function useBacklogActions() {
  const { apiClient, proxy } = useAppMode();
  const post = useCallback(<T = { item: BacklogItemFull; changed: boolean }>(path: string, body: Record<string, unknown>) =>
    apiClient.fetchPath<T>(path, { method: 'POST', body, machineId: proxy.machineId || undefined }),
  [apiClient, proxy.machineId]);
  return {
    create: (b: { title: string; description?: string; type?: string; priority?: string; tags?: string[] }) => post('/backlog', b),
    update: (id: string, b: Record<string, unknown>) => post(`/backlog/${encodeURIComponent(id)}`, b),
    link: (from: string, to: string, kind: string) => post(`/backlog/${encodeURIComponent(from)}/link`, { to, kind }),
    unlink: (from: string, to: string, kind?: string) => post(`/backlog/${encodeURIComponent(from)}/unlink`, { to, ...(kind ? { kind } : {}) }),
    discuss: (id: string, note: string) => post(`/backlog/${encodeURIComponent(id)}/discuss`, { note, session: { id: 'web-ui', kind: 'web' } }),
    review: (id: string, verdict: string, note?: string) => post(`/backlog/${encodeURIComponent(id)}/review`, { verdict, ...(note ? { note } : {}), by: 'web-ui' }),
    remove: (id: string, restore = false) => post(`/backlog/${encodeURIComponent(id)}/remove`, restore ? { restore: true } : {}),
    rollback: (id: string, toRev: number) => post(`/backlog/${encodeURIComponent(id)}/rollback`, { toRev }),
  };
}
