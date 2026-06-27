// web/src/components/missions/dashboard/MissionGraphCanvas.tsx
'use client';
import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { computeMissionLayout, type MissionLayoutStrategy } from '@/lib/mission-layout';
import { colorForGroup, matchesHighlight } from '@/lib/mission-graph-adapter';
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

  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const pinchRef = useRef<{ dist: number; zoom: number; cx: number; cy: number } | null>(null);

  // Zoom toward a focal point, keeping it fixed (reads zoom/pan from closure — proven 0.1.118 pattern).
  const zoomAt = useCallback((factor: number, fx: number, fy: number) => {
    const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
    const ratio = nz / zoom;
    setPan({ x: fx - (fx - pan.x) * ratio, y: fy - (fy - pan.y) * ratio });
    setZoom(nz);
  }, [zoom, pan]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    movedRef.current = false;
    draggingRef.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - dragStart.current.x, dy = e.clientY - dragStart.current.y;
    if (!movedRef.current && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) movedRef.current = true;
    setPan({ x: dragStart.current.panX + dx, y: dragStart.current.panY + dy });
  }, []);
  const onMouseUp = useCallback(() => { draggingRef.current = false; }, []);

  const layout = useMemo(
    () => computeMissionLayout({ nodes: nodes.map((n) => ({ id: n.id })), edges, strategy, selectedId, liveIds }),
    [nodes, edges, strategy, selectedId, liveIds],
  );

  // relationship counts per node (parent edge {from:parent,to:child}; dependsOn {from:mission,to:dep})
  const relsById = useMemo(() => {
    const m = new Map<string, { deps: number; children: number; dependents: number }>();
    const get = (id: string) => { let r = m.get(id); if (!r) { r = { deps: 0, children: 0, dependents: 0 }; m.set(id, r); } return r; };
    for (const e of edges) { if (e.type === 'parent') get(e.from).children += 1; else { get(e.from).deps += 1; get(e.to).dependents += 1; } }
    return m;
  }, [edges]);

  // 1-hop neighborhood of the selected node — for click-to-isolate dimming + edge emphasis.
  const connectedToSelected = useMemo(() => {
    if (!selectedId) return null;
    const set = new Set<string>([selectedId]);
    for (const e of edges) {
      if (e.from === selectedId) set.add(e.to);
      if (e.to === selectedId) set.add(e.from);
    }
    return set;
  }, [selectedId, edges]);

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

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rectXY = (cx: number, cy: number) => { const r = el.getBoundingClientRect(); return { x: cx - r.left, y: cy - r.top }; };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x, y } = rectXY(e.clientX, e.clientY);
      zoomAt(e.deltaY > 0 ? 0.9 : 1.1, x, y);
    };
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t: TouchList) => rectXY((t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2);
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        draggingRef.current = false;
        const m = mid(e.touches);
        pinchRef.current = { dist: dist(e.touches), zoom, cx: m.x, cy: m.y };
      } else if (e.touches.length === 1) {
        movedRef.current = false; draggingRef.current = true;
        dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, panX: pan.x, panY: pan.y };
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchRef.current) {
        e.preventDefault();
        const pr = pinchRef.current;
        if (!pr.dist) return;
        const ratio = dist(e.touches) / pr.dist;
        const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pr.zoom * ratio));
        const r = nz / zoom;
        setPan((p) => ({ x: pr.cx - (pr.cx - p.x) * r, y: pr.cy - (pr.cy - p.y) * r }));
        setZoom(nz);
      } else if (e.touches.length === 1 && draggingRef.current) {
        e.preventDefault();
        const dx = e.touches[0].clientX - dragStart.current.x, dy = e.touches[0].clientY - dragStart.current.y;
        if (!movedRef.current && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) movedRef.current = true;
        setPan({ x: dragStart.current.panX + dx, y: dragStart.current.panY + dy });
      }
    };
    const onTouchEnd = (e: TouchEvent) => { if (e.touches.length < 2) pinchRef.current = null; if (e.touches.length === 0) draggingRef.current = false; };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [zoomAt, zoom, pan]);

  if (nodes.length === 0) {
    return <div className="flex h-full items-center justify-center text-neutral-500">No missions match this view.</div>;
  }

  const W = layout.width, H = layout.height;

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden"
      style={{ touchAction: 'none', cursor: 'grab' }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onDoubleClick={fitToView}
      onClickCapture={(e) => { if (movedRef.current) e.stopPropagation(); }}
    >
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
            const hot = !!selectedId && (e.from === selectedId || e.to === selectedId);
            return <line key={i} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
              stroke={hot ? '#3b82f6' : '#475569'}
              strokeWidth={hot ? 2 : 1.2}
              strokeOpacity={hot ? 0.95 : (selectedId ? 0.12 : 0.5)}
              markerEnd="url(#mg-arrow)" />;
          })}
        </svg>
        {nodes.map((n) => {
          const p = layout.positions.get(n.id);
          if (!p) return null;
          const t = n.tags ?? {};
          const majorTag = display?.groupBy ? (t[display.groupBy] ?? [])[0] : (Object.entries(t).find(([d]) => !d.startsWith('ctl:'))?.[1] ?? [])[0];
          const accent = (display?.groupBy ? colorForGroup((t[display.groupBy] ?? [])[0] ?? '∅') : undefined) || STATUS_COLOR[n.status] || '#6b7280';
          const dimmed =
            (layout.dimmed?.has(n.id) ?? false) ||
            (!!connectedToSelected && !connectedToSelected.has(n.id)) ||
            (display?.highlight?.length ? !matchesHighlight(n, display.highlight) : false);
          return (
            <MissionCard
              key={n.id}
              node={n}
              x={p.x} y={p.y} width={layout.nodeW} height={layout.nodeH}
              selected={n.id === selectedId}
              dimmed={dimmed}
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
        <button onClick={() => { const r = containerRef.current?.getBoundingClientRect(); zoomAt(1.2, r ? r.width / 2 : 0, r ? r.height / 2 : 0); }} className="rounded border border-neutral-700 px-1.5 py-0.5" title="Zoom in">+</button>
        <button onClick={() => { const r = containerRef.current?.getBoundingClientRect(); zoomAt(0.8, r ? r.width / 2 : 0, r ? r.height / 2 : 0); }} className="rounded border border-neutral-700 px-1.5 py-0.5" title="Zoom out">−</button>
        <button onClick={fitToView} className="rounded border border-neutral-700 px-1.5 py-0.5" title="Fit">Fit</button>
        <span className="font-mono">{Math.round(zoom * 100)}%</span>
      </div>
    </div>
  );
}
