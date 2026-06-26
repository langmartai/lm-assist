'use client';
import { useMemo, useState } from 'react';
import { useMissionViews } from '@/hooks/useMissionViews';
import { useMissionGraph, type GraphSource } from '@/hooks/useMissionGraph';
import { applyQuickFilters } from '@/lib/mission-graph-adapter';
import { MissionGraphCanvas } from './MissionGraphCanvas';
import { MissionViewPicker } from './MissionViewPicker';
import { MissionQuickFilters } from './MissionQuickFilters';
import { MissionNodeDetail } from './MissionNodeDetail';

export function MissionDashboardPage() {
  const { views, loading: viewsLoading, refresh: refreshViews } = useMissionViews();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const source: GraphSource = activeId ? { viewId: activeId } : {};
  const { graph, view, loading, error } = useMissionGraph(source);

  const rawNodes = graph?.nodes ?? [];
  const filteredNodes = useMemo(() => applyQuickFilters(rawNodes, { statuses }), [rawNodes, statuses]);
  const nodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes]);
  const filteredEdges = useMemo(() => (graph?.edges ?? []).filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)), [graph, nodeIds]);
  const selectedNode = useMemo(() => filteredNodes.find((n) => n.id === selectedId) ?? null, [filteredNodes, selectedId]);

  const toggleStatus = (s: string) => setStatuses((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <div className="flex h-full">
      <div className="flex w-64 shrink-0 flex-col border-r border-neutral-800">
        <MissionViewPicker views={views} activeId={activeId} onSelect={(id) => { setActiveId(id); setSelectedId(null); }} onRefresh={refreshViews} loading={viewsLoading} />
        <MissionQuickFilters nodes={rawNodes} statuses={statuses} onToggleStatus={toggleStatus} />
      </div>
      <div className="relative flex-1">
        {loading && <div className="absolute left-2 top-2 z-10 text-xs text-neutral-500">Loading…</div>}
        {error && <div className="absolute left-2 top-2 z-10 text-xs text-red-400">{error}</div>}
        <MissionGraphCanvas nodes={filteredNodes} edges={filteredEdges} display={view?.display} selectedId={selectedId} onSelect={setSelectedId} />
      </div>
      <MissionNodeDetail node={selectedNode} onClose={() => setSelectedId(null)} />
    </div>
  );
}
