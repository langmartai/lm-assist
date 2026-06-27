// web/src/components/missions/dashboard/MissionGraphCanvas.tsx
'use client';
import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { computeMissionLayout, type MissionLayoutStrategy } from '@/lib/mission-layout';
import { colorForGroup } from '@/lib/mission-graph-adapter';
import { MissionCard } from './MissionCard';
import type { MissionNode, MissionEdge, MissionViewDisplay } from '@/lib/mission-graph-types';

const STATUS_COLOR: Record<string, string> = {
  active: '#34d399', waiting: '#fbbf24', paused: '#9ca3af', blocked: '#f87171', done: '#60a5fa', failed: '#ef4444', draft: '#6b7280',
};
const MIN_ZOOM = 0.05, MAX_ZOOM = 3;

/** Point on a card's border in the direction of (tx,ty), so edges meet card edges (not centers). */
function borderPoint(x: number, y: number, w: number, h: number, tx: number, ty: number) {
  const cx = x + w / 2, cy = y + h / 2, dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx !== 0 ? (w / 2) / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? (h / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

export function MissionGraphCanvas({ nodes, edges, strategy, selectedId, liveIds, display, onSelect }: {
  nodes: MissionNode[]; edges: MissionEdge[]; strategy: MissionLayoutStrategy;
  selectedId: string | null; liveIds: Set<string>; display?: MissionViewDisplay;
  onSelect: (id: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const layout = useMemo(
    () => computeMissionLayout({ nodes: nodes.map((n) => ({ id: n.id })), edges, strategy, selectedId, liveIds }),
    [nodes, edges, strategy, selectedId, liveIds],
  );

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // relationship counts per node (parent edge {from:parent,to:child}; dependsOn {from:mission,to:dep})
  const relsById = useMemo(() => {
    const m = new Map<string, { deps: number; children: number; dependents: number }>();
    const get = (id: string) => { let r = m.get(id); if (!r) { r = { deps: 0, children: 0, dependents: 0 }; m.set(id, r); } return r; };
    for (const e of edges) { if (e.type === 'parent') get(e.from).children += 1; else { get(e.from).deps += 1; get(e.to).dependents += 1; } }
    return m;
  }, [edges]);

  const fitToView = useCallback(() => {
    const el = containerRef.current;
    if (!el || layout.width === 0) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const z = Math.min(Math.max(Math.min((rect.width - 20) / layout.width, (rect.height - 20) / layout.height), MIN_ZOOM), MAX_ZOOM);
    setZoom(z);
    setPan({ x: Math.max(0, (rect.width - layout.width * z) / 2), y: Math.max(0, (rect.height - layout.height * z) / 2) });
  }, [layout.width, layout.height]);

  // auto-fit when the layout changes (stable dep — layout is memoized)
  useEffect(() => {
    const t = requestAnimationFrame(fitToView);
    return () => cancelAnimationFrame(t);
  }, [fitToView]);

  if (nodes.length === 0) {
    return <div className="flex h-full items-center justify-center text-neutral-500">No missions match this view.</div>;
  }

  const W = layout.width, H = layout.height;

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden" style={{ touchAction: 'none' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}>
        <svg width={W} height={H} style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' }}>
          <defs>
            <marker id="mg-arrow" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
              <polygon points="0 0, 9 3.5, 0 7" fill="#475569" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const a = layout.positions.get(e.from), b = layout.positions.get(e.to);
            if (!a || !b) return null;
            const ac = { x: a.x + layout.nodeW / 2, y: a.y + layout.nodeH / 2 };
            const bc = { x: b.x + layout.nodeW / 2, y: b.y + layout.nodeH / 2 };
            const p1 = borderPoint(a.x, a.y, layout.nodeW, layout.nodeH, bc.x, bc.y);
            const p2 = borderPoint(b.x, b.y, layout.nodeW, layout.nodeH, ac.x, ac.y);
            return <line key={i} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="#475569" strokeWidth={1.2} strokeOpacity={0.5} markerEnd="url(#mg-arrow)" />;
          })}
        </svg>
        {nodes.map((n) => {
          const p = layout.positions.get(n.id);
          if (!p) return null;
          const t = n.tags ?? {};
          const majorTag = display?.groupBy ? (t[display.groupBy] ?? [])[0] : (Object.entries(t).find(([d]) => !d.startsWith('ctl:'))?.[1] ?? [])[0];
          const accent = (display?.groupBy ? colorForGroup((t[display.groupBy] ?? [])[0] ?? '∅') : undefined) || STATUS_COLOR[n.status] || '#6b7280';
          return (
            <MissionCard
              key={n.id}
              node={n}
              x={p.x} y={p.y} width={layout.nodeW} height={layout.nodeH}
              selected={n.id === selectedId}
              dimmed={layout.dimmed?.has(n.id) ?? false}
              live={liveIds.has(n.id)}
              rels={relsById.get(n.id) ?? { deps: 0, children: 0, dependents: 0 }}
              accent={accent}
              majorTag={majorTag}
              fields={display?.nodeFields?.length ? display.nodeFields : ['status', 'progress']}
              onSelect={(id) => onSelect(id === selectedId ? null : id)}
            />
          );
        })}
      </div>
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1 text-[10px] text-neutral-400">
        <button onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.2))} className="rounded border border-neutral-700 px-1.5 py-0.5" title="Zoom in">+</button>
        <button onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z * 0.8))} className="rounded border border-neutral-700 px-1.5 py-0.5" title="Zoom out">−</button>
        <button onClick={fitToView} className="rounded border border-neutral-700 px-1.5 py-0.5" title="Fit">Fit</button>
        <span className="font-mono">{Math.round(zoom * 100)}%</span>
      </div>
    </div>
  );
}
