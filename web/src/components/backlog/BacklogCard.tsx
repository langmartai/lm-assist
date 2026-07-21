'use client';
import type { BacklogGraphNode } from '@/lib/backlog-types';
import { PRIORITY_LABEL, STATUS_COLOR, TYPE_COLOR } from '@/lib/backlog-types';

export function BacklogCard({ node, x, y, width, height, selected, dimmed, onSelect }: {
  node: BacklogGraphNode;
  x: number; y: number; width: number; height: number;
  selected: boolean; dimmed: boolean;
  onSelect: (id: string) => void;
}) {
  const accent = TYPE_COLOR[node.type] ?? '#6b7280';
  const statusColor = STATUS_COLOR[node.status] ?? '#9ca3af';
  const hot = node.priority === 'critical' || node.priority === 'high';
  return (
    <div
      className="absolute overflow-hidden rounded-md border bg-neutral-900 px-2 py-1 text-xs"
      style={{
        left: x, top: y, width, height,
        opacity: dimmed ? 0.3 : node.removed ? 0.45 : 1,
        borderColor: selected ? '#fff' : accent,
        borderLeftWidth: 4,
        cursor: 'pointer',
        boxShadow: selected ? '0 0 0 1px #fff' : undefined,
      }}
      onClick={() => onSelect(node.id)}
    >
      <div className="flex items-center gap-1">
        <span className="shrink-0 rounded bg-neutral-800 px-1 text-[9px] uppercase tracking-wide" style={{ color: accent }}>{node.type}</span>
        <div className={`truncate font-medium text-neutral-100 ${node.removed ? 'line-through' : ''}`}>{node.title}</div>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-neutral-400">
        <span className="rounded px-1" style={{ background: statusColor + '26', color: statusColor }}>{node.status}</span>
        {hot && <span className="rounded bg-red-500/15 px-1 font-semibold text-red-400">{PRIORITY_LABEL[node.priority]}</span>}
        {node.tags.slice(0, 2).map((t) => <span key={t} className="rounded bg-neutral-800 px-1 text-[9px] text-neutral-300">{t}</span>)}
      </div>
      {(node.counts.discussion > 0 || node.counts.reviews > 0) && (
        <div className="mt-0.5 truncate text-[9px] text-neutral-500">
          {node.counts.discussion > 0 && `💬${node.counts.discussion}`} {node.counts.reviews > 0 && `✓${node.counts.reviews}`}
        </div>
      )}
    </div>
  );
}
