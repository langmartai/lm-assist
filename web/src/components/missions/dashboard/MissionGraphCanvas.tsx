'use client';
import { useMemo } from 'react';
import { DagGraph } from '@/components/dag/DagGraph';
import type { DagNode } from '@/components/dag/dag-types';
import { toDagGraph } from '@/lib/mission-graph-adapter';
import type { MissionNode, MissionEdge, MissionViewDisplay } from '@/lib/mission-graph-types';

const STATUS_COLOR: Record<string, string> = {
  active: '#34d399', waiting: '#fbbf24', paused: '#9ca3af', blocked: '#f87171', done: '#60a5fa', failed: '#ef4444', draft: '#6b7280',
};

export function MissionGraphCanvas({ nodes, edges, display, selectedId, onSelect }: {
  nodes: MissionNode[];
  edges: MissionEdge[];
  display?: MissionViewDisplay;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const graph = useMemo(() => toDagGraph({ nodes, edges }, display), [nodes, edges, display]);
  const groups = useMemo(() => {
    if (!display?.groupBy) return [] as Array<{ value: string; color: string }>;
    const seen = new Map<string, string>();
    for (const n of graph.nodes) {
      const v = ((n.metadata.tags as Record<string, string[]>)?.[display.groupBy] ?? [])[0] ?? '∅';
      if (!seen.has(v)) seen.set(v, (n.metadata.groupColor as string | undefined) ?? '#6b7280');
    }
    return [...seen.entries()].map(([value, color]) => ({ value, color }));
  }, [graph, display?.groupBy]);

  if (graph.nodes.length === 0) {
    return <div className="flex h-full items-center justify-center text-neutral-500">No missions match this view.</div>;
  }

  const renderNode = ({ node, x, y, width, height, selected }: { node: DagNode; x: number; y: number; width: number; height: number; selected: boolean }) => {
    const dimmed = node.metadata.highlighted === false;
    const accent = (node.metadata.groupColor as string) || STATUS_COLOR[node.metadata.status as string] || '#6b7280';
    const fields = (display?.nodeFields?.length ? display.nodeFields : ['status', 'progress']) as string[];
    return (
      <foreignObject x={x} y={y} width={width} height={height}>
        <div
          className="h-full w-full overflow-hidden rounded-md border bg-neutral-900 px-2 py-1 text-xs"
          style={{ opacity: dimmed ? 0.35 : 1, borderColor: selected ? '#fff' : accent, borderLeftWidth: 4 }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => onSelect(node.id === selectedId ? null : node.id)}
        >
          <div className="truncate font-medium text-neutral-100">{node.label}</div>
          <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-neutral-400">
            {fields.map((f) => (
              <span key={f}>{f === 'status' ? String(node.metadata.status) : f === 'progress' ? `${node.metadata.progressPercent ?? 0}%` : String((node.metadata as Record<string, unknown>)[f] ?? '')}</span>
            ))}
          </div>
        </div>
      </foreignObject>
    );
  };

  return (
    <div className="relative h-full w-full">
      <DagGraph
        graph={graph}
        selectedNodeId={selectedId}
        onNodeClick={(n) => onSelect(n.id === selectedId ? null : n.id)}
        renderNode={renderNode}
      />
      {groups.length > 0 && (
        <div className="absolute right-2 top-2 rounded-md border border-neutral-800 bg-neutral-900/90 p-2 text-xs">
          <div className="mb-1 text-neutral-400">{display?.groupBy}</div>
          {groups.map((g) => (
            <div key={g.value} className="flex items-center gap-1.5 text-neutral-200">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: g.color }} />
              {g.value}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
