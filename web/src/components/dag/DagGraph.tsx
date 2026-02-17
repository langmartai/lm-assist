// DagGraph — SVG DAG renderer with zoom/pan
// Portable: uses only React + local dag-types/layout

'use client';

import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import type { DagNode, DagGraph as DagGraphType, DagLayoutOptions } from './dag-types';
import { computeDagLayout } from './dag-layout';
import { DagNodeCard } from './DagNodeCard';

interface DagGraphProps {
  graph: DagGraphType;
  layoutOptions?: DagLayoutOptions;
  selectedNodeId?: string | null;
  highlightDepth?: number;
  onNodeClick?: (node: DagNode) => void;
  onNodeHover?: (node: DagNode | null) => void;
  renderNode?: (props: {
    node: DagNode;
    x: number;
    y: number;
    width: number;
    height: number;
    selected: boolean;
  }) => React.ReactNode;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 3;

export function DagGraph({ graph, layoutOptions, selectedNodeId, highlightDepth = 1, onNodeClick, onNodeHover, renderNode }: DagGraphProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const layout = useMemo(() => computeDagLayout(graph, layoutOptions), [graph, layoutOptions]);

  const nodeW = layout.nodeW;
  const nodeH = layout.nodeH;

  // Auto-fit when graph changes
  useEffect(() => {
    if (layout.nodes.length === 0 || !containerRef.current) return;
    const timer = requestAnimationFrame(() => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const scaleX = (rect.width - 20) / layout.width;
      const scaleY = (rect.height - 20) / layout.height;
      const newZoom = Math.min(Math.max(Math.min(scaleX, scaleY), MIN_ZOOM), MAX_ZOOM);
      // Center the graph
      const contentW = layout.width * newZoom;
      const contentH = layout.height * newZoom;
      const cx = Math.max(0, (rect.width - contentW) / 2);
      const cy = Math.max(0, (rect.height - contentH) / 2);
      setZoom(newZoom);
      setPan({ x: cx, y: cy });
    });
    return () => cancelAnimationFrame(timer);
  }, [layout]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom(z => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * delta)));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as SVGElement;
    if (target.tagName === 'rect' || target.tagName === 'text' || target.tagName === 'circle') return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    });
  }, [dragging]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const fitToView = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const scaleX = (rect.width - 20) / layout.width;
    const scaleY = (rect.height - 20) / layout.height;
    const newZoom = Math.min(Math.max(Math.min(scaleX, scaleY), MIN_ZOOM), MAX_ZOOM);
    const contentW = layout.width * newZoom;
    const contentH = layout.height * newZoom;
    const cx = Math.max(0, (rect.width - contentW) / 2);
    const cy = Math.max(0, (rect.height - contentH) / 2);
    setZoom(newZoom);
    setPan({ x: cx, y: cy });
  }, [layout.width, layout.height]);

  // Multi-level connection highlighting
  const { connectedEdgeIds, connectedNodeIds } = useMemo(() => {
    const edgeSet = new Set<number>();
    const nodeSet = new Set<string>();
    if (!selectedNodeId) return { connectedEdgeIds: edgeSet, connectedNodeIds: nodeSet };

    nodeSet.add(selectedNodeId);
    let frontier = new Set<string>([selectedNodeId]);

    for (let depth = 0; depth < highlightDepth; depth++) {
      const nextFrontier = new Set<string>();
      layout.edges.forEach((e, i) => {
        if (frontier.has(e.fromId) && !nodeSet.has(e.toId)) {
          edgeSet.add(i);
          nodeSet.add(e.toId);
          nextFrontier.add(e.toId);
        }
        if (frontier.has(e.toId) && !nodeSet.has(e.fromId)) {
          edgeSet.add(i);
          nodeSet.add(e.fromId);
          nextFrontier.add(e.fromId);
        }
        // Also mark edges between already-known connected nodes
        if (frontier.has(e.fromId) || frontier.has(e.toId)) {
          if (nodeSet.has(e.fromId) && nodeSet.has(e.toId)) edgeSet.add(i);
        }
      });
      frontier = nextFrontier;
      if (nextFrontier.size === 0) break;
    }

    return { connectedEdgeIds: edgeSet, connectedNodeIds: nodeSet };
  }, [selectedNodeId, highlightDepth, layout.edges]);

  if (graph.nodes.length === 0) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>No nodes to display</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', overflow: 'hidden', position: 'relative' }}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Controls */}
      <div style={{
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 10,
        display: 'flex',
        gap: 4,
        fontSize: 10,
      }}>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setZoom(z => Math.min(MAX_ZOOM, z * 1.2))}
          title="Zoom in"
          style={{ padding: '2px 6px', fontSize: 12, lineHeight: 1 }}
        >
          +
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setZoom(z => Math.max(MIN_ZOOM, z * 0.8))}
          title="Zoom out"
          style={{ padding: '2px 6px', fontSize: 12, lineHeight: 1 }}
        >
          −
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={fitToView}
          title="Fit to view"
          style={{ padding: '2px 6px', fontSize: 10 }}
        >
          Fit
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={resetView}
          title="Reset zoom"
          style={{ padding: '2px 6px', fontSize: 10 }}
        >
          1:1
        </button>
        <span style={{
          fontSize: 9,
          color: 'var(--color-text-tertiary)',
          padding: '3px 4px',
          fontFamily: 'var(--font-mono)',
        }}>
          {Math.round(zoom * 100)}%
        </span>
      </div>

      <svg
        width="100%"
        height="100%"
        style={{ cursor: dragging ? 'grabbing' : 'grab' }}
      >
        <defs>
          <marker id="dag-arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="var(--color-text-tertiary, #64748b)" />
          </marker>
          <marker id="dag-arrowhead-hl" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="var(--color-accent, #3b82f6)" />
          </marker>
        </defs>

        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          {/* Edges */}
          {layout.edges.map((edge, i) => {
            const highlighted = connectedEdgeIds.has(i);
            const dx = edge.to.x - edge.from.x;
            const dy = edge.to.y - edge.from.y;
            let d: string;

            // Determine edge direction and use appropriate curve
            const isHorizontal = Math.abs(dx) > Math.abs(dy);
            if (isHorizontal && dx >= 0) {
              // Forward horizontal: standard cubic bezier
              const cpx = dx * 0.4;
              d = `M ${edge.from.x} ${edge.from.y} C ${edge.from.x + cpx} ${edge.from.y}, ${edge.to.x - cpx} ${edge.to.y}, ${edge.to.x} ${edge.to.y}`;
            } else if (!isHorizontal && dy >= 0) {
              // Downward vertical (cross-band connectors)
              const cpy = dy * 0.4;
              d = `M ${edge.from.x} ${edge.from.y} C ${edge.from.x} ${edge.from.y + cpy}, ${edge.to.x} ${edge.to.y - cpy}, ${edge.to.x} ${edge.to.y}`;
            } else {
              // Backward or upward: loop edge with larger control offset
              const offset = Math.max(40, Math.min(Math.abs(dx), Math.abs(dy)) * 0.5);
              d = `M ${edge.from.x} ${edge.from.y} C ${edge.from.x + offset} ${edge.from.y + offset}, ${edge.to.x - offset} ${edge.to.y - offset}, ${edge.to.x} ${edge.to.y}`;
            }

            return (
              <path
                key={i}
                d={d}
                fill="none"
                stroke={highlighted ? 'var(--color-accent, #3b82f6)' : 'var(--color-border-default, #334155)'}
                strokeWidth={highlighted ? 2 : 1.5}
                strokeOpacity={highlighted ? 1 : selectedNodeId ? 0.15 : 0.6}
                markerEnd={highlighted ? 'url(#dag-arrowhead-hl)' : 'url(#dag-arrowhead)'}
              />
            );
          })}

          {/* Nodes */}
          {layout.nodes.map(ln => {
            const isSelected = ln.id === selectedNodeId;
            const isConnected = connectedNodeIds.has(ln.id);
            const dimmed = !!selectedNodeId && !isConnected;
            if (renderNode) {
              return (
                <g key={ln.id} opacity={dimmed ? 0.25 : 1}>
                  {renderNode({
                    node: ln.node,
                    x: ln.x,
                    y: ln.y,
                    width: nodeW,
                    height: nodeH,
                    selected: isSelected || isConnected,
                  })}
                </g>
              );
            }
            return (
              <g key={ln.id} opacity={dimmed ? 0.25 : 1}>
                <DagNodeCard
                  node={ln.node}
                  x={ln.x}
                  y={ln.y}
                  width={nodeW}
                  height={nodeH}
                  selected={isSelected || isConnected}
                  onClick={onNodeClick}
                  onHover={onNodeHover}
                />
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
