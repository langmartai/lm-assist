'use client';
import type { MissionView } from '@/lib/mission-graph-types';

export function MissionViewPicker({ views, activeId, onSelect, onRefresh, loading }: {
  views: MissionView[]; activeId: string | null; onSelect: (id: string | null) => void; onRefresh: () => void; loading: boolean;
}) {
  return (
    <div className="border-b border-neutral-800 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Views</span>
        <button onClick={onRefresh} className="text-xs text-neutral-400 hover:text-neutral-100" disabled={loading}>↻</button>
      </div>
      <button onClick={() => onSelect(null)} className={`mb-1 block w-full rounded px-2 py-1 text-left text-sm ${activeId === null ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-300 hover:bg-neutral-800/50'}`}>All missions (ad-hoc)</button>
      {views.map((v) => (
        <button key={v.id} onClick={() => onSelect(v.id)} className={`block w-full truncate rounded px-2 py-1 text-left text-sm ${activeId === v.id ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-300 hover:bg-neutral-800/50'}`}>{v.name}</button>
      ))}
      {views.length === 0 && !loading && <div className="px-2 py-1 text-xs text-neutral-500">No saved views. Create one via the mission_view_set MCP tool.</div>}
    </div>
  );
}
