'use client';
import { useMemo } from 'react';
import type { MissionNode } from '@/lib/mission-graph-types';

const STATUSES = ['active', 'waiting', 'paused', 'blocked', 'done', 'failed'];

export function MissionQuickFilters({ nodes, statuses, onToggleStatus, tags, onToggleTag }: {
  nodes: MissionNode[];
  statuses: string[];
  onToggleStatus: (s: string) => void;
  tags: Record<string, string[]>;
  onToggleTag: (dim: string, val: string) => void;
}) {
  const present = useMemo(() => new Set(nodes.map((n) => n.status)), [nodes]);
  const tagDims = useMemo(() => {
    const dims = new Map<string, Set<string>>();
    for (const n of nodes) {
      for (const [dim, vals] of Object.entries(n.tags ?? {})) {
        let set = dims.get(dim);
        if (!set) { set = new Set(); dims.set(dim, set); }
        for (const v of vals) set.add(v);
      }
    }
    return [...dims.entries()].map(([dim, vals]) => ({ dim, vals: [...vals].sort() }));
  }, [nodes]);

  return (
    <div className="p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">Status</div>
      <div className="flex flex-wrap gap-1.5">
        {STATUSES.filter((s) => present.has(s)).map((s) => (
          <button key={s} onClick={() => onToggleStatus(s)} className={`rounded-full border px-2 py-0.5 text-xs ${statuses.includes(s) ? 'border-neutral-500 bg-neutral-700 text-neutral-100' : 'border-neutral-800 text-neutral-400 hover:border-neutral-600'}`}>{s}</button>
        ))}
      </div>
      {tagDims.map(({ dim, vals }) => (
        <div key={dim} className="mt-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">{dim}</div>
          <div className="flex flex-wrap gap-1.5">
            {vals.map((v) => {
              const on = (tags[dim] ?? []).includes(v);
              return (
                <button key={v} onClick={() => onToggleTag(dim, v)} className={`rounded-full border px-2 py-0.5 text-xs ${on ? 'border-neutral-500 bg-neutral-700 text-neutral-100' : 'border-neutral-800 text-neutral-400 hover:border-neutral-600'}`}>{v}</button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
