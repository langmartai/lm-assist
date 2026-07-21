'use client';
import type { MissionLayoutStrategy } from '@/lib/mission-layout';

const OPTIONS: { value: MissionLayoutStrategy; label: string; hint: string }[] = [
  { value: 'clusters', label: 'Clusters', hint: 'Related items grouped; standalone in a grid' },
  { value: 'hubs', label: 'Hubs', hint: 'Most-connected item centered in each group' },
  { value: 'focus', label: 'Focus', hint: 'Radial around the selected item' },
  { value: 'recent', label: 'Recent', hint: 'Largest groups surfaced first' },
];

export function BacklogLayoutPicker({ strategy, onChange, hasSelection }: {
  strategy: MissionLayoutStrategy;
  onChange: (s: MissionLayoutStrategy) => void;
  hasSelection: boolean;
}) {
  const active = OPTIONS.find((o) => o.value === strategy);
  return (
    <div className="border-b border-neutral-800 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">Layout</div>
      <select
        value={strategy}
        onChange={(e) => onChange(e.target.value as MissionLayoutStrategy)}
        className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
      >
        {OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <div className="mt-1 text-[10px] text-neutral-500">{active?.hint}</div>
      {strategy === 'focus' && !hasSelection && <div className="mt-1 text-[10px] text-amber-500/80">Select an item to focus on.</div>}
    </div>
  );
}
