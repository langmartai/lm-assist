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
  const [tags, setTags] = useState<Record<string, string[]>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const source: GraphSource = activeId ? { viewId: activeId } : {};
  const { graph, view, loading, error, refresh } = useMissionGraph(source);

  const rawNodes = graph?.nodes ?? [];
  const filteredNodes = useMemo(() => applyQuickFilters(rawNodes, { statuses, tags }), [rawNodes, statuses, tags]);
  const nodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes]);
  const filteredEdges = useMemo(() => (graph?.edges ?? []).filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)), [graph, nodeIds]);
  const selectedNode = useMemo(() => filteredNodes.find((n) => n.id === selectedId) ?? null, [filteredNodes, selectedId]);

  const toggleStatus = (s: string) => setStatuses((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const toggleTag = (dim: string, val: string) => setTags((cur) => {
    const vals = cur[dim] ?? [];
    const next = vals.includes(val) ? vals.filter((x) => x !== val) : [...vals, val];
    const out = { ...cur, [dim]: next };
    if (next.length === 0) delete out[dim];
    return out;
  });
  const selectView = (id: string | null) => { setActiveId(id); setSelectedId(null); setStatuses([]); setTags({}); };

  return (
    <div className="flex h-full">
      <div className="flex w-64 shrink-0 flex-col border-r border-neutral-800">
        <MissionViewPicker views={views} activeId={activeId} onSelect={selectView} onRefresh={() => { refreshViews(); refresh(); }} loading={viewsLoading} />
        <MissionQuickFilters nodes={rawNodes} statuses={statuses} onToggleStatus={toggleStatus} tags={tags} onToggleTag={toggleTag} />
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
