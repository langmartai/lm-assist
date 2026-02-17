'use client';

import { useState, useMemo } from 'react';
import type { ArchitectureComponent } from '@/lib/types';
import { typeColors, getDominantType } from './colors';

interface Rect {
  x: number; y: number; w: number; h: number;
  component: ArchitectureComponent;
  color: string;
}

// Squarified treemap layout
function squarify(
  items: Array<{ value: number; component: ArchitectureComponent; color: string }>,
  x: number, y: number, w: number, h: number
): Rect[] {
  if (items.length === 0) return [];
  if (items.length === 1) {
    return [{ x, y, w, h, component: items[0].component, color: items[0].color }];
  }

  const total = items.reduce((sum, it) => sum + it.value, 0);
  if (total === 0) return [];

  // Sort descending by value
  const sorted = [...items].sort((a, b) => b.value - a.value);

  const rects: Rect[] = [];
  let remaining = [...sorted];
  let cx = x, cy = y, cw = w, ch = h;

  while (remaining.length > 0 && cw > 0.5 && ch > 0.5) {
    const isWide = cw >= ch;
    const side = isWide ? ch : cw;
    const remTotal = remaining.reduce((s, it) => s + it.value, 0);

    // Find best row
    let row: typeof remaining = [];
    let rowSum = 0;
    let bestAspect = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      row.push(remaining[i]);
      rowSum += remaining[i].value;
      const rowWidth = (rowSum / remTotal) * (isWide ? cw : ch);

      // Check worst aspect ratio in this row
      let worstAspect = 0;
      for (const item of row) {
        const itemH = (item.value / rowSum) * side;
        const aspect = Math.max(rowWidth / itemH, itemH / rowWidth);
        worstAspect = Math.max(worstAspect, aspect);
      }

      if (worstAspect > bestAspect && row.length > 1) {
        row.pop();
        rowSum -= remaining[i].value;
        break;
      }
      bestAspect = worstAspect;
    }

    // Lay out the row
    const rowWidth = (rowSum / remTotal) * (isWide ? cw : ch);
    let offset = 0;

    for (const item of row) {
      const itemSize = (item.value / rowSum) * side;
      if (isWide) {
        rects.push({ x: cx, y: cy + offset, w: rowWidth, h: itemSize, component: item.component, color: item.color });
      } else {
        rects.push({ x: cx + offset, y: cy, w: itemSize, h: rowWidth, component: item.component, color: item.color });
      }
      offset += itemSize;
    }

    // Reduce remaining area
    if (isWide) {
      cx += rowWidth;
      cw -= rowWidth;
    } else {
      cy += rowWidth;
      ch -= rowWidth;
    }

    remaining = remaining.slice(row.length);
  }

  return rects;
}

interface Props {
  components: ArchitectureComponent[];
  onSelectDir: (dir: string | null) => void;
}

export function ActivityTreemap({ components, onSelectDir }: Props) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string; subtext: string } | null>(null);

  const WIDTH = 800;
  const HEIGHT = 280;

  // Take top 30 components for treemap
  const topComponents = useMemo(() =>
    [...components]
      .sort((a, b) => b.milestoneCount - a.milestoneCount)
      .slice(0, 30)
      .filter(c => c.milestoneCount > 0),
    [components]
  );

  const rects = useMemo(() => {
    const items = topComponents.map(c => ({
      value: c.milestoneCount,
      component: c,
      color: typeColors[getDominantType(c.types)] || '#94a3b8',
    }));
    return squarify(items, 0, 0, WIDTH, HEIGHT);
  }, [topComponents]);

  return (
    <div style={{ position: 'relative', marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Activity Map
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        style={{ width: '100%', height: 'auto', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}
      >
        {rects.map((rect, i) => {
          const isHovered = hoveredIdx === i;
          const label = rect.component.directory === '(project root)' ? '(root)' : rect.component.directory.split('/').pop() || '';
          const showLabel = rect.w > 40 && rect.h > 20;

          return (
            <g key={i}>
              <rect
                x={rect.x + 1}
                y={rect.y + 1}
                width={Math.max(0, rect.w - 2)}
                height={Math.max(0, rect.h - 2)}
                rx={3}
                fill={rect.color}
                opacity={isHovered ? 0.95 : 0.7}
                stroke={isHovered ? '#fff' : 'transparent'}
                strokeWidth={isHovered ? 2 : 0}
                style={{ cursor: 'pointer', transition: 'opacity 0.15s' }}
                onClick={() => {
                  const dir = rect.component.directory === '(project root)' ? null : rect.component.directory;
                  onSelectDir(dir);
                }}
                onMouseEnter={(e) => {
                  setHoveredIdx(i);
                  const svgRect = (e.target as SVGRectElement).ownerSVGElement?.getBoundingClientRect();
                  if (svgRect) {
                    const scaleX = svgRect.width / WIDTH;
                    const px = svgRect.left + (rect.x + rect.w / 2) * scaleX;
                    const py = svgRect.top + (rect.y) * (svgRect.height / HEIGHT) - 8;
                    setTooltip({
                      x: px, y: py,
                      text: rect.component.directory === '(project root)' ? '(root)' : rect.component.directory,
                      subtext: `${rect.component.milestoneCount} milestones · ${rect.component.fileCount} files`,
                    });
                  }
                }}
                onMouseLeave={() => { setHoveredIdx(null); setTooltip(null); }}
              />
              {showLabel && (
                <text
                  x={rect.x + rect.w / 2}
                  y={rect.y + rect.h / 2}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="#fff"
                  fontSize={Math.min(11, rect.w / label.length * 1.2)}
                  fontWeight={600}
                  style={{ pointerEvents: 'none', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}
                >
                  {label.length > rect.w / 7 ? label.slice(0, Math.floor(rect.w / 7)) + '...' : label}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <div style={{
          position: 'fixed', left: tooltip.x, top: tooltip.y,
          transform: 'translate(-50%, -100%)',
          background: 'var(--color-bg-primary)',
          border: '1px solid var(--color-border-default)',
          borderRadius: 'var(--radius-sm)',
          padding: '6px 10px',
          fontSize: 11, lineHeight: 1.4,
          pointerEvents: 'none',
          zIndex: 1000,
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
        }}>
          <div style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{tooltip.text}</div>
          <div style={{ color: 'var(--color-text-tertiary)' }}>{tooltip.subtext}</div>
        </div>
      )}
    </div>
  );
}
