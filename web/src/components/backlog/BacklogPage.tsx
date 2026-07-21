'use client';
import { useMemo, useState } from 'react';
import type { MissionLayoutStrategy } from '@/lib/mission-layout';
import { useBacklogGraph } from '@/hooks/useBacklog';
import { BACKLOG_STATUSES, BACKLOG_TYPES, STATUS_COLOR, TYPE_COLOR } from '@/lib/backlog-types';
import { BacklogGraphCanvas } from './BacklogGraphCanvas';
import { BacklogNodeDetail } from './BacklogNodeDetail';
import { BacklogCreatePanel } from './BacklogCreatePanel';
import { BacklogLayoutPicker } from './BacklogLayoutPicker';

export function BacklogPage() {
  const [includeRemoved, setIncludeRemoved] = useState(false);
  const { graph, loading, error, refresh } = useBacklogGraph(includeRemoved);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<MissionLayoutStrategy>('clusters');
  const [statuses, setStatuses] = useState<string[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [search, setSearch] = useState('');

  const rawNodes = useMemo(() => graph?.nodes ?? [], [graph]);
  const filteredNodes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rawNodes
      .filter((n) => statuses.length === 0 || statuses.includes(n.status))
      .filter((n) => types.length === 0 || types.includes(n.type))
      .filter((n) => !q || n.title.toLowerCase().includes(q) || n.id.includes(q) || n.tags.some((t) => t.toLowerCase().includes(q)));
  }, [rawNodes, statuses, types, search]);
  const nodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes]);
  const filteredEdges = useMemo(() => (graph?.edges ?? []).filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)), [graph, nodeIds]);

  const toggle = (list: string[], set: (v: string[]) => void, v: string) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2 text-xs text-neutral-400">
        <span className="font-semibold text-neutral-200">Backlog Graph</span>
        <span>{filteredNodes.length} shown / {rawNodes.length} total</span>
        <span className="text-neutral-600">ideas · features · issues · bugs · tasks — not yet missions</span>
        <button onClick={() => void refresh()} className="ml-auto text-neutral-400 hover:text-neutral-100" disabled={loading}>↻ Refresh</button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-neutral-800">
          <BacklogCreatePanel onCreated={(id) => { setSelectedId(id); void refresh(); }} />
          <div className="border-b border-neutral-800 p-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title / tag / id…"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
            />
          </div>
          <div className="border-b border-neutral-800 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">Type</div>
            <div className="flex flex-wrap gap-1">
              {BACKLOG_TYPES.map((t) => (
                <button key={t} onClick={() => toggle(types, setTypes, t)}
                  className={`rounded border px-1.5 py-0.5 text-[11px] ${types.includes(t) ? 'border-neutral-400 text-neutral-100' : 'border-neutral-700 text-neutral-400'}`}
                  style={types.includes(t) ? { borderColor: TYPE_COLOR[t], color: TYPE_COLOR[t] } : {}}
                >{t}</button>
              ))}
            </div>
            <div className="mb-2 mt-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">Status</div>
            <div className="flex flex-wrap gap-1">
              {BACKLOG_STATUSES.map((s) => (
                <button key={s} onClick={() => toggle(statuses, setStatuses, s)}
                  className={`rounded border px-1.5 py-0.5 text-[11px] ${statuses.includes(s) ? 'border-neutral-400 text-neutral-100' : 'border-neutral-700 text-neutral-400'}`}
                  style={statuses.includes(s) ? { borderColor: STATUS_COLOR[s], color: STATUS_COLOR[s] } : {}}
                >{s}</button>
              ))}
            </div>
            <label className="mt-3 flex items-center gap-1.5 text-[11px] text-neutral-400">
              <input type="checkbox" checked={includeRemoved} onChange={(e) => setIncludeRemoved(e.target.checked)} />
              show removed
            </label>
            {(statuses.length > 0 || types.length > 0 || search) && (
              <button onClick={() => { setStatuses([]); setTypes([]); setSearch(''); }} className="mt-2 text-[11px] text-blue-400 hover:underline">Reset filters</button>
            )}
          </div>
          <BacklogLayoutPicker strategy={strategy} onChange={setStrategy} hasSelection={!!selectedId} />
        </div>
        <div className="relative flex-1">
          {loading && <div className="absolute left-2 top-2 z-10 text-xs text-neutral-500">Loading…</div>}
          {error && <div className="absolute left-2 top-2 z-10 text-xs text-red-400">{error}</div>}
          <BacklogGraphCanvas nodes={filteredNodes} edges={filteredEdges} strategy={strategy} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
        <BacklogNodeDetail
          nodeId={selectedId}
          nodes={rawNodes}
          edges={graph?.edges ?? []}
          onSelect={setSelectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => void refresh()}
        />
      </div>
    </div>
  );
}
