// web/src/components/missions/dashboard/MissionCard.tsx
'use client';
import type { MissionNode } from '@/lib/mission-graph-types';
import { formatProgressPercent } from '@/lib/mission-graph-adapter';

export interface MissionCardProps {
  node: MissionNode;
  x: number; y: number; width: number; height: number;
  selected: boolean; dimmed: boolean; live: boolean;
  rels: { deps: number; children: number; dependents: number };
  accent: string;
  majorTag?: string;
  fields: string[];
  onSelect: (id: string) => void;
}

export function MissionCard({ node, x, y, width, height, selected, dimmed, live, rels, accent, majorTag, fields, onSelect }: MissionCardProps) {
  const relParts: string[] = [];
  if (node.parentId) relParts.push('↑parent');
  if (rels.deps) relParts.push(`⛓${rels.deps}`);
  if (rels.children) relParts.push(`▽${rels.children}`);
  if (rels.dependents) relParts.push(`${rels.dependents}blk`);
  return (
    <div
      className="absolute overflow-hidden rounded-md border bg-neutral-900 px-2 py-1 text-xs"
      style={{
        left: x, top: y, width, height,
        opacity: dimmed ? 0.3 : 1,
        borderColor: selected ? '#fff' : accent,
        borderLeftWidth: 4,
        cursor: 'pointer',
        boxShadow: selected ? '0 0 0 1px #fff' : undefined,
      }}
      onClick={() => onSelect(node.id)}
    >
      <div className="flex items-center gap-1">
        {live && <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-400" style={{ boxShadow: '0 0 4px #34d399' }} />}
        <div className="truncate font-medium text-neutral-100">{node.title}</div>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-neutral-400">
        {fields.map((f) => (
          <span key={f}>{f === 'status' ? node.status : f === 'progress' ? formatProgressPercent(node.progressPercent) : String((node as unknown as Record<string, unknown>)[f] ?? '')}</span>
        ))}
        {majorTag && <span className="rounded bg-neutral-800 px-1 text-[9px] text-neutral-300">{majorTag}</span>}
      </div>
      {relParts.length > 0 && <div className="mt-0.5 truncate text-[9px] text-neutral-500">{relParts.join(' · ')}</div>}
    </div>
  );
}
