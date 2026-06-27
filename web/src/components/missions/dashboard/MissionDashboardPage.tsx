'use client';
import { useMemo, useState } from 'react';
import { useMissionViews } from '@/hooks/useMissionViews';
import { useMissionGraph, type GraphSource } from '@/hooks/useMissionGraph';
import { applyQuickFilters, matchesSearch, buildFilter, expandToComponents } from '@/lib/mission-graph-adapter';
import type { MissionLayoutStrategy } from '@/lib/mission-layout';
import { MissionGraphCanvas } from './MissionGraphCanvas';
import { MissionViewPicker } from './MissionViewPicker';
import { MissionFilterEditor, type ExpandState } from './MissionFilterEditor';
import { MissionSearchBox } from './MissionSearchBox';
import { MissionNodeDetail } from './MissionNodeDetail';
import { MissionLayoutPicker } from './MissionLayoutPicker';
import { useMissionActivity } from '@/hooks/useMissionActivity';

export function MissionDashboardPage() {
  const { views, loading: viewsLoading, refresh: refreshViews, saveView } = useMissionViews();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [tags, setTags] = useState<Record<string, string[]>>({});
  const [expand, setExpand] = useState<ExpandState>({ direction: 'none', depth: 1 });
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<MissionLayoutStrategy>('clusters');
  const { liveIds } = useMissionActivity();

  // server source: a saved view, OR ad-hoc — with a server-side filter only when expand/scope is active
  const source: GraphSource = useMemo(() => {
    if (activeId) return { viewId: activeId };
    if (expand.direction !== 'none') { const { filter, expand: ex } = buildFilter({ statuses, tags, expand }); return { filter, expand: ex }; }
    return {};
  }, [activeId, expand, statuses, tags]);
  const { graph, view, loading, error, refresh } = useMissionGraph(source);

  const rawNodes = useMemo(() => graph?.nodes ?? [], [graph]);
  const filteredNodes = useMemo(() => {
    const base = expand.direction !== 'none' ? rawNodes : applyQuickFilters(rawNodes, { statuses, tags });
    const matched = base.filter((n) => matchesSearch(n, search));
    if (!search.trim()) return matched;
    // search active → reveal each match's whole connected group (over the full graph edges)
    const reveal = expandToComponents(rawNodes, graph?.edges ?? [], new Set(matched.map((n) => n.id)));
    return rawNodes.filter((n) => reveal.has(n.id));
  }, [rawNodes, statuses, tags, search, expand.direction, graph]);
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
  const selectView = (id: string | null) => { setActiveId(id); setSelectedId(null); setStatuses([]); setTags({}); setSearch(''); setExpand({ direction: 'none', depth: 1 }); };
  const resetFilter = () => { setActiveId(null); setStatuses([]); setTags({}); setExpand({ direction: 'none', depth: 1 }); setSearch(''); };
  const onSaveView = async () => {
    const name = typeof window !== 'undefined' ? window.prompt('View name?') : null;
    if (!name) return;
    const { filter, expand: ex } = buildFilter({ statuses, tags, expand });
    try { await saveView({ name, query: { filter, expand: ex }, display: view?.display ?? {} }); } catch { /* surfaced by the view list not updating */ }
  };

  const activeView = views.find((v) => v.id === activeId);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2 text-xs text-neutral-400">
        <span className="font-semibold text-neutral-200">Mission Graph</span>
        <span>{filteredNodes.length} shown / {rawNodes.length} total</span>
        <span>· {activeView ? activeView.name : 'ad-hoc filter'}</span>
        {view?.display?.groupBy && <span>· grouped by {view.display.groupBy}</span>}
        <button onClick={() => { refreshViews(); refresh(); }} className="ml-auto text-neutral-400 hover:text-neutral-100" disabled={loading}>↻ Refresh</button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-neutral-800">
          <MissionViewPicker views={views} activeId={activeId} onSelect={selectView} onRefresh={() => { refreshViews(); refresh(); }} loading={viewsLoading} />
          <MissionSearchBox value={search} onChange={setSearch} />
          <MissionFilterEditor nodes={rawNodes} statuses={statuses} tags={tags} onToggleStatus={toggleStatus} onToggleTag={toggleTag} expand={expand} onExpandChange={setExpand} onReset={resetFilter} onSaveView={onSaveView} />
          <MissionLayoutPicker strategy={strategy} onChange={setStrategy} hasSelection={!!selectedId} />
        </div>
        <div className="relative flex-1">
          {loading && <div className="absolute left-2 top-2 z-10 text-xs text-neutral-500">Loading…</div>}
          {error && <div className="absolute left-2 top-2 z-10 text-xs text-red-400">{error}</div>}
          <MissionGraphCanvas nodes={filteredNodes} edges={filteredEdges} strategy={strategy} selectedId={selectedId} liveIds={liveIds} display={view?.display} onSelect={setSelectedId} />
        </div>
        <MissionNodeDetail nodeId={selectedId} edges={graph?.edges ?? []} onSelect={setSelectedId} onClose={() => setSelectedId(null)} />
      </div>
    </div>
  );
}
