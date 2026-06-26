'use client';
import { useMemo } from 'react';
import type { MissionNode } from '@/lib/mission-graph-types';

const STATUSES = ['active', 'waiting', 'paused', 'blocked', 'done', 'failed'];

export function MissionQuickFilters({ nodes, statuses, onToggleStatus }: {
  nodes: MissionNode[]; statuses: string[]; onToggleStatus: (s: string) => void;
}) {
  const present = useMemo(() => new Set(nodes.map((n) => n.status)), [nodes]);
  return (
    <div className="p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">Status</div>
      <div className="flex flex-wrap gap-1.5">
        {STATUSES.filter((s) => present.has(s)).map((s) => (
          <button key={s} onClick={() => onToggleStatus(s)} className={`rounded-full border px-2 py-0.5 text-xs ${statuses.includes(s) ? 'border-neutral-500 bg-neutral-700 text-neutral-100' : 'border-neutral-800 text-neutral-400 hover:border-neutral-600'}`}>{s}</button>
        ))}
      </div>
    </div>
  );
}
