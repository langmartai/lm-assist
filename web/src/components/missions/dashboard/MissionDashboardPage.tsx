'use client';
import { useMemo, useState } from 'react';
import { useMissionViews } from '@/hooks/useMissionViews';
import { useMissionGraph, type GraphSource } from '@/hooks/useMissionGraph';
import { applyQuickFilters, matchesSearch } from '@/lib/mission-graph-adapter';
import { MissionGraphCanvas } from './MissionGraphCanvas';
import { MissionViewPicker } from './MissionViewPicker';
import { MissionQuickFilters } from './MissionQuickFilters';
import { MissionSearchBox } from './MissionSearchBox';
import { MissionNodeDetail } from './MissionNodeDetail';

export function MissionDashboardPage() {
  const { views, loading: viewsLoading, refresh: refreshViews } = useMissionViews();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [tags, setTags] = useState<Record<string, string[]>>({});
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const source: GraphSource = activeId ? { viewId: activeId } : {};
  const { graph, view, loading, error, refresh } = useMissionGraph(source);

  const rawNodes = graph?.nodes ?? [];
  const filteredNodes = useMemo(
    () => applyQuickFilters(rawNodes, { statuses, tags }).filter((n) => matchesSearch(n, search)),
    [rawNodes, statuses, tags, search],
  );
  const nodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes]);
  const filteredEdges = useMemo(() => (graph?.edges ?? []).filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)), [graph, nodeIds]);

  const toggleStatus = (s: string) => setStatuses((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const toggleTag = (dim: string, val: string) => setTags((cur) => {
    const vals = cur[dim] ?? [];
    const next = vals.includes(val) ? vals.filter((x) => x !== val) : [...vals, val];
    const out = { ...cur, [dim]: next };
    if (next.length === 0) delete out[dim];
    return out;
  });
  const selectView = (id: string | null) => { setActiveId(id); setSelectedId(null); setStatuses([]); setTags({}); setSearch(''); };

  const activeView = views.find((v) => v.id === activeId);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2 text-xs text-neutral-400">
        <span className="font-semibold text-neutral-200">Mission Graph</span>
        <span>{filteredNodes.length} shown / {rawNodes.length} total</span>
        <span>· {activeView ? activeView.name : 'ad-hoc'}</span>
        {view?.display?.groupBy && <span>· grouped by {view.display.groupBy}</span>}
        <button onClick={() => { refreshViews(); refresh(); }} className="ml-auto text-neutral-400 hover:text-neutral-100" disabled={loading}>↻ Refresh</button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-neutral-800">
          <MissionViewPicker views={views} activeId={activeId} onSelect={selectView} onRefresh={() => { refreshViews(); refresh(); }} loading={viewsLoading} />
          <MissionSearchBox value={search} onChange={setSearch} />
          <MissionQuickFilters nodes={rawNodes} statuses={statuses} onToggleStatus={toggleStatus} tags={tags} onToggleTag={toggleTag} />
        </div>
        <div className="relative flex-1">
          {loading && <div className="absolute left-2 top-2 z-10 text-xs text-neutral-500">Loading…</div>}
          {error && <div className="absolute left-2 top-2 z-10 text-xs text-red-400">{error}</div>}
          <MissionGraphCanvas nodes={filteredNodes} edges={filteredEdges} display={view?.display} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
        <MissionNodeDetail nodeId={selectedId} edges={graph?.edges ?? []} onSelect={setSelectedId} onClose={() => setSelectedId(null)} />
      </div>
    </div>
  );
}
