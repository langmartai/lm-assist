// web/src/components/backlog/BacklogGraphCanvas.tsx — the mission-graph canvas
// pattern (HTML cards + SVG edges in ONE CSS-transform div — kills the foreignObject
// zoom-ghost; wheel/pinch zoom, drag pan, double-click/Fit) applied to backlog items
// with typed, color-coded edges. Layout reuses computeMissionLayout verbatim.
'use client';
import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { computeMissionLayout, type MissionLayoutStrategy } from '@/lib/mission-layout';
import { BacklogCard } from './BacklogCard';
import { EDGE_COLOR, type BacklogGraphEdge, type BacklogGraphNode } from '@/lib/backlog-types';

const MIN_ZOOM = 0.05, MAX_ZOOM = 3;

/** Point on a card's border in the direction of (tx,ty), so edges meet card edges. */
function borderPoint(x: number, y: number, w: number, h: number, tx: number, ty: number) {
  const cx = x + w / 2, cy = y + h / 2, dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx !== 0 ? (w / 2) / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? (h / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

const markerId = (kind: string) => `bg-arrow-${kind.replace(/[^a-z-]/g, '')}`;

export function BacklogGraphCanvas({ nodes, edges, strategy, selectedId, onSelect }: {
  nodes: BacklogGraphNode[]; edges: BacklogGraphEdge[]; strategy: MissionLayoutStrategy;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const pinchRef = useRef<{ dist: number; zoom: number; cx: number; cy: number } | null>(null);

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

  // mission-layout expects 'parent'|'dependsOn' edge types; parent-of maps to the
  // tree-ish treatment, every other kind to the dependency flow.
  const layoutEdges = useMemo(
    () => edges.map((e) => ({ from: e.from, to: e.to, type: (e.kind === 'parent-of' ? 'parent' : 'dependsOn') as 'parent' | 'dependsOn' })),
    [edges],
  );
  const layout = useMemo(
    () => computeMissionLayout({ nodes: nodes.map((n) => ({ id: n.id })), edges: layoutEdges, strategy, selectedId, nodeH: 84 }),
    [nodes, layoutEdges, strategy, selectedId],
  );

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
    return <div className="flex h-full items-center justify-center text-neutral-500">No backlog items match. Create one with “+ New item”.</div>;
  }

  const W = layout.width, H = layout.height;
  const kindsInUse = [...new Set(edges.map((e) => e.kind))];

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
            {Object.entries(EDGE_COLOR).map(([kind, color]) => (
              <marker key={kind} id={markerId(kind)} markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
                <polygon points="0 0, 9 3.5, 0 7" fill={color} />
              </marker>
            ))}
          </defs>
          {edges.map((e, i) => {
            const a = layout.positions.get(e.from), b = layout.positions.get(e.to);
            if (!a || !b) return null;
            const ac = { x: a.x + layout.nodeW / 2, y: a.y + layout.nodeH / 2 };
            const bc = { x: b.x + layout.nodeW / 2, y: b.y + layout.nodeH / 2 };
            const p1 = borderPoint(a.x, a.y, layout.nodeW, layout.nodeH, bc.x, bc.y);
            const p2 = borderPoint(b.x, b.y, layout.nodeW, layout.nodeH, ac.x, ac.y);
            const color = EDGE_COLOR[e.kind] ?? '#475569';
            const hot = !!selectedId && (e.from === selectedId || e.to === selectedId);
            return <line key={i} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
              stroke={color}
              strokeWidth={hot ? 2.2 : 1.4}
              strokeOpacity={hot ? 0.95 : (selectedId ? 0.12 : 0.6)}
              strokeDasharray={e.kind === 'relates-to' ? '4 3' : e.kind === 'duplicate-of' ? '2 3' : undefined}
              markerEnd={`url(#${markerId(e.kind)})`} />;
          })}
        </svg>
        {nodes.map((n) => {
          const p = layout.positions.get(n.id);
          if (!p) return null;
          const dimmed =
            (layout.dimmed?.has(n.id) ?? false) ||
            (!!connectedToSelected && !connectedToSelected.has(n.id));
          return (
            <BacklogCard
              key={n.id}
              node={n}
              x={p.x} y={p.y} width={layout.nodeW} height={layout.nodeH}
              selected={n.id === selectedId}
              dimmed={dimmed}
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
      {kindsInUse.length > 0 && (
        <div className="absolute bottom-2 left-2 z-10 flex flex-wrap items-center gap-2 rounded bg-neutral-900/80 px-2 py-1 text-[10px] text-neutral-400">
          {kindsInUse.map((k) => (
            <span key={k} className="flex items-center gap-1">
              <span className="inline-block h-0.5 w-4" style={{ background: EDGE_COLOR[k] ?? '#475569' }} />
              {k}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
