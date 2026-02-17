// DagNodeCard — SVG node renderer for DAG graphs
// Portable: no langmart-assistant-specific imports

import type { DagNode } from './dag-types';

interface DagNodeCardProps {
  node: DagNode;
  x: number;
  y: number;
  width: number;
  height: number;
  selected?: boolean;
  onClick?: (node: DagNode) => void;
  onHover?: (node: DagNode | null) => void;
}

// Color scheme per node type
const TYPE_COLORS: Record<string, string> = {
  session: '#3b82f6',    // blue
  subagent: '#8b5cf6',   // purple
  teammate: '#22c55e',   // green
  team_lead: '#3b82f6',  // blue
  fork: '#06b6d4',       // cyan (matches fork badge in session list)
  task: '#eab308',       // yellow
  user: '#14b8a6',       // teal
  assistant: '#6366f1',  // indigo
  tool_use: '#6b7280',   // gray
  tool_result: '#6b7280',
  system: '#9ca3af',
  summary: '#a78bfa',
  progress: '#6b7280',
  result: '#22c55e',
  queue_operation: '#6b7280',
};

const STATUS_COLORS: Record<string, string> = {
  running: '#3b82f6',
  completed: '#22c55e',
  error: '#ef4444',
  pending: '#f59e0b',
  unknown: '#6b7280',
};

function getTypeLabel(type: string): string {
  switch (type) {
    case 'session': return 'Session';
    case 'subagent': return 'Subagent';
    case 'teammate': return 'Teammate';
    case 'team_lead': return 'Lead';
    case 'fork': return 'Fork';
    case 'task': return 'Task';
    case 'user': return 'User';
    case 'assistant': return 'Assistant';
    case 'tool_use': return 'Tool';
    case 'tool_result': return 'Result';
    case 'summary': return 'Summary';
    case 'progress': return 'Progress';
    default: return type;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

export function DagNodeCard({ node, x, y, width, height, selected, onClick, onHover }: DagNodeCardProps) {
  const borderColor = TYPE_COLORS[node.type] || '#6b7280';
  const status = (node.metadata.status as string) || '';
  const statusColor = STATUS_COLORS[status] || undefined;
  const meta = node.metadata;

  // Responsive sizing: hide elements for small nodes
  const isCompact = height < 45;
  const isTiny = height < 35;
  const fontSize = isTiny ? 7 : isCompact ? 8 : 11;
  const typeFontSize = isTiny ? 6 : isCompact ? 7 : 9;
  const dotR = isTiny ? 2.5 : isCompact ? 3 : 4;

  // Build metadata line
  const metaParts: string[] = [];
  if (meta.model) metaParts.push(String(meta.model));
  if (meta.numTurns) metaParts.push(`${meta.numTurns}T`);
  if (meta.totalCostUsd) metaParts.push(`$${Number(meta.totalCostUsd).toFixed(3)}`);
  if (meta.agentType) metaParts.push(String(meta.agentType));
  const metaLine = metaParts.join(' · ');

  // Vertical positions
  const typeY = isTiny ? y + height * 0.55 : isCompact ? y + height * 0.45 : y + 17;
  const labelY = isCompact ? y + height * 0.78 : y + 34;
  const metaY = y + 50;
  const maxChars = Math.floor(width / (isTiny ? 4.5 : isCompact ? 5.5 : 6.5));

  return (
    <g
      onClick={() => onClick?.(node)}
      onMouseEnter={() => onHover?.(node)}
      onMouseLeave={() => onHover?.(null)}
      style={{ cursor: onClick ? 'pointer' : undefined }}
    >
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={isTiny ? 3 : 6}
        fill={selected ? 'var(--color-bg-surface, #1e293b)' : 'var(--color-bg-elevated, #0f172a)'}
        stroke={selected ? borderColor : `${borderColor}88`}
        strokeWidth={selected ? 2 : 1.5}
      />
      {/* Status dot */}
      {statusColor && (
        <circle
          cx={x + (isTiny ? 8 : 12)}
          cy={typeY - (isTiny ? 1 : isCompact ? 2 : 3)}
          r={dotR}
          fill={statusColor}
        />
      )}
      {/* Type badge */}
      <text
        x={x + (statusColor ? (isTiny ? 14 : isCompact ? 18 : 22) : (isTiny ? 4 : 8))}
        y={typeY}
        fontSize={typeFontSize}
        fill={borderColor}
        fontFamily="var(--font-mono, monospace)"
        fontWeight={600}
      >
        {getTypeLabel(node.type)}
      </text>
      {/* ID (short) — hide when tiny */}
      {!isTiny && meta.sessionId && (
        <text
          x={x + width - 8}
          y={typeY}
          fontSize={isCompact ? 6 : 8}
          fill="var(--color-text-tertiary, #64748b)"
          fontFamily="var(--font-mono, monospace)"
          textAnchor="end"
        >
          {String(meta.agentId || meta.sessionId).slice(0, 8)}
        </text>
      )}
      {/* Label */}
      {!isTiny && (
        <text
          x={x + 8}
          y={labelY}
          fontSize={fontSize}
          fill="var(--color-text-primary, #e2e8f0)"
          fontFamily="var(--font-ui, sans-serif)"
        >
          {truncate(node.label, maxChars)}
        </text>
      )}
      {/* Meta line — only at full size */}
      {!isCompact && metaLine && (
        <text
          x={x + 8}
          y={metaY}
          fontSize={9}
          fill="var(--color-text-tertiary, #64748b)"
          fontFamily="var(--font-mono, monospace)"
        >
          {truncate(metaLine, Math.floor(width / 5.5))}
        </text>
      )}
    </g>
  );
}
