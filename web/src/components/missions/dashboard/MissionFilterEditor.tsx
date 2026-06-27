'use client';
import { useMemo } from 'react';
import type { MissionNode } from '@/lib/mission-graph-types';

const STATUSES = ['active', 'waiting', 'paused', 'blocked', 'done', 'failed'];
const DIRECTIONS = ['none', 'dependencies', 'dependents', 'children', 'parents', 'all'];

export type ExpandState = { direction: string; depth: number };

export function MissionFilterEditor({ nodes, statuses, tags, onToggleStatus, onToggleTag, expand, onExpandChange, onReset, onSaveView }: {
  nodes: MissionNode[];
  statuses: string[];
  tags: Record<string, string[]>;
  onToggleStatus: (s: string) => void;
  onToggleTag: (dim: string, val: string) => void;
  expand: ExpandState;
  onExpandChange: (e: ExpandState) => void;
  onReset: () => void;
  onSaveView: () => void;
}) {
  const present = useMemo(() => new Set(nodes.map((n) => n.status)), [nodes]);
  const tagDims = useMemo(() => {
    const dims = new Map<string, Set<string>>();
    for (const n of nodes) for (const [dim, vals] of Object.entries(n.tags ?? {})) {
      let set = dims.get(dim); if (!set) { set = new Set(); dims.set(dim, set); }
      for (const v of vals) set.add(v);
    }
    return [...dims.entries()].map(([dim, vals]) => ({ dim, vals: [...vals].sort() }));
  }, [nodes]);

  const chip = (on: boolean) => `rounded-full border px-2 py-0.5 text-xs ${on ? 'border-neutral-500 bg-neutral-700 text-neutral-100' : 'border-neutral-800 text-neutral-400 hover:border-neutral-600'}`;

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Filter</span>
        <div className="flex gap-2 text-[11px]">
          <button onClick={onReset} className="text-neutral-400 hover:text-neutral-100">Reset</button>
          <button onClick={onSaveView} className="text-blue-400 hover:text-blue-300">Save as view</button>
        </div>
      </div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">Status</div>
      <div className="flex flex-wrap gap-1.5">
        {STATUSES.filter((s) => present.has(s)).map((s) => (
          <button key={s} onClick={() => onToggleStatus(s)} className={chip(statuses.includes(s))}>{s}</button>
        ))}
      </div>
      {tagDims.map(({ dim, vals }) => (
        <div key={dim} className="mt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">{dim}</div>
          <div className="flex flex-wrap gap-1.5">
            {vals.map((v) => <button key={v} onClick={() => onToggleTag(dim, v)} className={chip((tags[dim] ?? []).includes(v))}>{v}</button>)}
          </div>
        </div>
      ))}
      <div className="mt-3">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">Expand (server)</div>
        <div className="flex items-center gap-1.5">
          <select value={expand.direction} onChange={(e) => onExpandChange({ ...expand, direction: e.target.value })} className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-xs text-neutral-200">
            {DIRECTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          {expand.direction !== 'none' && (
            <select value={expand.depth} onChange={(e) => onExpandChange({ ...expand, depth: Number(e.target.value) })} className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-xs text-neutral-200">
              {[1, 2, 3].map((d) => <option key={d} value={d}>depth {d}</option>)}
            </select>
          )}
        </div>
      </div>
    </div>
  );
}
