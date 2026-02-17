'use client';

import { useState, useMemo } from 'react';
import {
  CheckSquare,
  Clock,
  Loader2,
  CheckCircle2,
  Circle,
  ArrowRight,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  List,
  GitBranch,
  X,
} from 'lucide-react';
import type { SessionTask } from '@/lib/types';

interface TasksTabProps {
  tasks: SessionTask[];
}

type ViewMode = 'kanban' | 'list' | 'sequence' | 'graph';

const STATUS_CONFIG = {
  pending: { label: 'Pending', icon: Circle, color: 'var(--color-status-yellow)', bgClass: 'badge-yellow' },
  in_progress: { label: 'In Progress', icon: Loader2, color: 'var(--color-status-blue)', bgClass: 'badge-blue' },
  completed: { label: 'Completed', icon: CheckCircle2, color: 'var(--color-status-green)', bgClass: 'badge-green' },
};

export function TasksTab({ tasks }: TasksTabProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('kanban');
  const [selectedTask, setSelectedTask] = useState<SessionTask | null>(null);

  const grouped = useMemo(() => ({
    pending: tasks.filter(t => t.status === 'pending'),
    in_progress: tasks.filter(t => t.status === 'in_progress'),
    completed: tasks.filter(t => t.status === 'completed'),
  }), [tasks]);

  if (tasks.length === 0) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <CheckSquare size={28} className="empty-state-icon" />
        <span style={{ fontSize: 13 }}>No tasks in this session</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* View mode bar */}
      <div style={{
        padding: '6px 16px',
        borderBottom: '1px solid var(--color-border-default)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginRight: 4 }}>View:</span>
        {([
          { id: 'kanban' as ViewMode, icon: LayoutGrid, label: 'Kanban' },
          { id: 'list' as ViewMode, icon: List, label: 'List' },
          { id: 'sequence' as ViewMode, icon: ArrowRight, label: 'Sequence' },
          { id: 'graph' as ViewMode, icon: GitBranch, label: 'Graph' },
        ]).map(v => (
          <button
            key={v.id}
            className={`btn btn-sm ${viewMode === v.id ? 'btn-secondary' : 'btn-ghost'}`}
            onClick={() => setViewMode(v.id)}
            style={{ gap: 4 }}
          >
            <v.icon size={12} />
            {v.label}
          </button>
        ))}

        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          {grouped.pending.length} pending · {grouped.in_progress.length} active · {grouped.completed.length} done
        </span>
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }} className="scrollbar-thin">
        {viewMode === 'kanban' && (
          <KanbanView grouped={grouped} onSelect={setSelectedTask} />
        )}
        {viewMode === 'list' && (
          <ListView tasks={tasks} onSelect={setSelectedTask} />
        )}
        {viewMode === 'sequence' && (
          <SequenceView tasks={tasks} onSelect={setSelectedTask} />
        )}
        {viewMode === 'graph' && (
          <GraphView tasks={tasks} onSelect={setSelectedTask} />
        )}
      </div>

      {/* Task detail popup */}
      {selectedTask && (
        <TaskDetailPopup task={selectedTask} allTasks={tasks} onClose={() => setSelectedTask(null)} />
      )}
    </div>
  );
}

// ============================================
// Kanban View
// ============================================

function KanbanView({
  grouped,
  onSelect,
}: {
  grouped: Record<string, SessionTask[]>;
  onSelect: (t: SessionTask) => void;
}) {
  return (
    <div className="kanban-board">
      {(['pending', 'in_progress', 'completed'] as const).map(status => {
        const config = STATUS_CONFIG[status];
        const tasks = grouped[status] || [];
        return (
          <div key={status} className="kanban-column">
            <div className="kanban-column-header">
              <config.icon size={14} style={{ color: config.color }} />
              <span>{config.label}</span>
              <span className={`badge ${config.bgClass}`} style={{ fontSize: 10 }}>{tasks.length}</span>
            </div>
            <div className="kanban-column-body">
              {tasks.map(task => (
                <TaskCard key={task.id} task={task} onClick={() => onSelect(task)} />
              ))}
              {tasks.length === 0 && (
                <div style={{ padding: 12, fontSize: 11, color: 'var(--color-text-tertiary)', textAlign: 'center' }}>
                  No tasks
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================
// List View
// ============================================

function ListView({
  tasks,
  onSelect,
}: {
  tasks: SessionTask[];
  onSelect: (t: SessionTask) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Header */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '32px 1fr 100px 80px',
        gap: 8,
        padding: '4px 8px',
        fontSize: 10,
        fontWeight: 600,
        color: 'var(--color-text-tertiary)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
      }}>
        <span>#</span>
        <span>Subject</span>
        <span>Status</span>
        <span>Deps</span>
      </div>
      {tasks.map(task => {
        const config = STATUS_CONFIG[task.status];
        const blockedByCount = task.blockedBy?.length || 0;
        const blocksCount = task.blocks?.length || 0;
        return (
          <div
            key={task.id}
            onClick={() => onSelect(task)}
            style={{
              display: 'grid',
              gridTemplateColumns: '32px 1fr 100px 80px',
              gap: 8,
              padding: '6px 8px',
              fontSize: 12,
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              borderLeft: `2px solid ${config.color}`,
            }}
            className="card"
          >
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)', fontSize: 11 }}>
              {task.id}
            </span>
            <span style={{ color: 'var(--color-text-primary)' }}>{task.subject}</span>
            <span className={`badge ${config.bgClass}`} style={{ fontSize: 10, width: 'fit-content' }}>
              {config.label}
            </span>
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
              {blockedByCount > 0 && <span title="Blocked by">←{blockedByCount} </span>}
              {blocksCount > 0 && <span title="Blocks">→{blocksCount}</span>}
              {blockedByCount === 0 && blocksCount === 0 && '—'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ============================================
// Sequence View
// ============================================

function SequenceView({
  tasks,
  onSelect,
}: {
  tasks: SessionTask[];
  onSelect: (t: SessionTask) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, position: 'relative' }}>
      {/* Vertical line */}
      <div style={{
        position: 'absolute',
        left: 15,
        top: 0,
        bottom: 0,
        width: 2,
        background: 'var(--color-border-default)',
      }} />

      {tasks.map((task, i) => {
        const config = STATUS_CONFIG[task.status];
        const StatusIcon = config.icon;
        return (
          <div
            key={task.id}
            onClick={() => onSelect(task)}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              padding: '8px 0',
              cursor: 'pointer',
              position: 'relative',
            }}
          >
            {/* Node */}
            <div style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: 'var(--color-bg-surface)',
              border: `2px solid ${config.color}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              zIndex: 1,
            }}>
              <StatusIcon size={14} style={{ color: config.color }} />
            </div>

            {/* Content */}
            <div className="card" style={{ flex: 1, padding: '8px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                  #{task.id}
                </span>
                <span className={`badge ${config.bgClass}`} style={{ fontSize: 9 }}>{config.label}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-primary)', fontWeight: 500 }}>
                {task.subject}
              </div>
              {task.description && (
                <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 4, lineHeight: 1.5 }}>
                  {task.description.length > 150 ? task.description.slice(0, 150) + '...' : task.description}
                </div>
              )}
              {/* Dependencies */}
              {((task.blockedBy?.length || 0) > 0 || (task.blocks?.length || 0) > 0) && (
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  {task.blockedBy && task.blockedBy.length > 0 && (
                    <span style={{ fontSize: 10, color: 'var(--color-status-red)', display: 'flex', alignItems: 'center', gap: 2 }}>
                      <ArrowLeft size={10} /> Blocked by: {task.blockedBy.join(', ')}
                    </span>
                  )}
                  {task.blocks && task.blocks.length > 0 && (
                    <span style={{ fontSize: 10, color: 'var(--color-status-blue)', display: 'flex', alignItems: 'center', gap: 2 }}>
                      <ArrowRight size={10} /> Blocks: {task.blocks.join(', ')}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================
// Dependency Graph View (SVG)
// ============================================

function GraphView({
  tasks,
  onSelect,
}: {
  tasks: SessionTask[];
  onSelect: (t: SessionTask) => void;
}) {
  const { nodes, edges, width, height } = useMemo(() => {
    // Build adjacency and compute layers via topological sort
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();

    for (const t of tasks) {
      inDegree.set(t.id, 0);
      adj.set(t.id, []);
    }
    for (const t of tasks) {
      if (t.blockedBy) {
        for (const dep of t.blockedBy) {
          if (taskMap.has(dep)) {
            adj.get(dep)!.push(t.id);
            inDegree.set(t.id, (inDegree.get(t.id) || 0) + 1);
          }
        }
      }
    }

    // BFS layering
    const layers: string[][] = [];
    const visited = new Set<string>();
    let queue = tasks.filter(t => (inDegree.get(t.id) || 0) === 0).map(t => t.id);

    while (queue.length > 0) {
      layers.push([...queue]);
      queue.forEach(id => visited.add(id));
      const next: string[] = [];
      for (const id of queue) {
        for (const child of (adj.get(id) || [])) {
          if (!visited.has(child)) {
            const remaining = (inDegree.get(child) || 0) - 1;
            inDegree.set(child, remaining);
            if (remaining <= 0 && !next.includes(child)) {
              next.push(child);
            }
          }
        }
      }
      queue = next;
    }

    // Add any remaining (cycles)
    const unvisited = tasks.filter(t => !visited.has(t.id)).map(t => t.id);
    if (unvisited.length > 0) layers.push(unvisited);

    const nodeW = 160;
    const nodeH = 48;
    const layerGap = 100;
    const nodeGap = 16;

    const nodePositions: { id: string; x: number; y: number; task: SessionTask }[] = [];

    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      const totalH = layer.length * nodeH + (layer.length - 1) * nodeGap;
      const startY = Math.max(0, (400 - totalH) / 2);
      for (let ni = 0; ni < layer.length; ni++) {
        const task = taskMap.get(layer[ni]);
        if (task) {
          nodePositions.push({
            id: task.id,
            x: 20 + li * (nodeW + layerGap),
            y: startY + ni * (nodeH + nodeGap),
            task,
          });
        }
      }
    }

    const posMap = new Map(nodePositions.map(n => [n.id, n]));
    const edgeList: { from: { x: number; y: number }; to: { x: number; y: number }; fromId: string; toId: string }[] = [];

    for (const t of tasks) {
      if (t.blockedBy) {
        for (const dep of t.blockedBy) {
          const fromNode = posMap.get(dep);
          const toNode = posMap.get(t.id);
          if (fromNode && toNode) {
            edgeList.push({
              from: { x: fromNode.x + nodeW, y: fromNode.y + nodeH / 2 },
              to: { x: toNode.x, y: toNode.y + nodeH / 2 },
              fromId: dep,
              toId: t.id,
            });
          }
        }
      }
    }

    const graphW = Math.max(600, 40 + layers.length * (nodeW + layerGap));
    const maxNodesInLayer = Math.max(1, ...layers.map(l => l.length));
    const graphH = Math.max(400, maxNodesInLayer * (nodeH + nodeGap) + 40);

    return { nodes: nodePositions, edges: edgeList, width: graphW, height: graphH };
  }, [tasks]);

  return (
    <div style={{ overflow: 'auto', width: '100%', height: '100%' }} className="scrollbar-thin">
      <svg width={width} height={height} style={{ minWidth: width }}>
        <defs>
          <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="var(--color-text-tertiary)" />
          </marker>
        </defs>

        {/* Edges */}
        {edges.map((edge, i) => {
          const dx = edge.to.x - edge.from.x;
          const cpx = dx * 0.5;
          return (
            <path
              key={i}
              d={`M ${edge.from.x} ${edge.from.y} C ${edge.from.x + cpx} ${edge.from.y}, ${edge.to.x - cpx} ${edge.to.y}, ${edge.to.x} ${edge.to.y}`}
              fill="none"
              stroke="var(--color-border-default)"
              strokeWidth={1.5}
              markerEnd="url(#arrowhead)"
            />
          );
        })}

        {/* Nodes */}
        {nodes.map(node => {
          const config = STATUS_CONFIG[node.task.status];
          return (
            <g key={node.id} onClick={() => onSelect(node.task)} style={{ cursor: 'pointer' }}>
              <rect
                x={node.x}
                y={node.y}
                width={160}
                height={48}
                rx={6}
                fill="var(--color-bg-elevated)"
                stroke={config.color}
                strokeWidth={1.5}
              />
              <text
                x={node.x + 8}
                y={node.y + 16}
                fontSize={10}
                fill="var(--color-text-tertiary)"
                fontFamily="var(--font-mono)"
              >
                #{node.id}
              </text>
              <text
                x={node.x + 8}
                y={node.y + 34}
                fontSize={11}
                fill="var(--color-text-primary)"
                fontFamily="var(--font-ui)"
              >
                {node.task.subject.length > 20 ? node.task.subject.slice(0, 20) + '...' : node.task.subject}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ============================================
// Task Card (used in kanban)
// ============================================

function TaskCard({ task, onClick }: { task: SessionTask; onClick: () => void }) {
  const config = STATUS_CONFIG[task.status];
  const isBlocked = task.blockedBy && task.blockedBy.length > 0 &&
    task.status !== 'completed';

  return (
    <div
      className="kanban-card"
      onClick={onClick}
      style={{
        borderLeftColor: isBlocked ? 'var(--color-status-red)' : config.color,
        opacity: isBlocked ? 0.7 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-tertiary)' }}>
          #{task.id}
        </span>
        {task.owner && (
          <span className="badge badge-default" style={{ fontSize: 9 }}>{task.owner}</span>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--color-text-primary)', lineHeight: 1.4 }}>
        {task.subject}
      </div>
      {/* Dependencies */}
      {((task.blockedBy?.length || 0) > 0 || (task.blocks?.length || 0) > 0) && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6, fontSize: 10 }}>
          {task.blockedBy && task.blockedBy.length > 0 && (
            <span style={{ color: 'var(--color-status-red)', display: 'flex', alignItems: 'center', gap: 2 }}>
              <ArrowLeft size={9} /> {task.blockedBy.length}
            </span>
          )}
          {task.blocks && task.blocks.length > 0 && (
            <span style={{ color: 'var(--color-status-blue)', display: 'flex', alignItems: 'center', gap: 2 }}>
              <ArrowRight size={9} /> {task.blocks.length}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================
// Task Detail Popup
// ============================================

function TaskDetailPopup({
  task,
  allTasks,
  onClose,
}: {
  task: SessionTask;
  allTasks: SessionTask[];
  onClose: () => void;
}) {
  const config = STATUS_CONFIG[task.status];
  const blockedByTasks = (task.blockedBy || [])
    .map(id => allTasks.find(t => t.id === id))
    .filter(Boolean) as SessionTask[];
  const blocksTasks = (task.blocks || [])
    .map(id => allTasks.find(t => t.id === id))
    .filter(Boolean) as SessionTask[];

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          width: 520,
          maxHeight: '80vh',
          overflow: 'auto',
          padding: 24,
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                #{task.id}
              </span>
              <span className={`badge ${config.bgClass}`}>{config.label}</span>
            </div>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>
              {task.subject}
            </h3>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {/* Description */}
        {task.description && (
          <div style={{ marginBottom: 16 }}>
            <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6, textTransform: 'uppercase' }}>
              Description
            </h4>
            <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap' }}>
              {task.description}
            </p>
          </div>
        )}

        {/* Active Form */}
        {task.activeForm && (
          <div style={{ marginBottom: 16 }}>
            <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6, textTransform: 'uppercase' }}>
              Active Form
            </h4>
            <span style={{ fontSize: 12, color: 'var(--color-status-blue)' }}>{task.activeForm}</span>
          </div>
        )}

        {/* Owner */}
        {task.owner && (
          <div style={{ marginBottom: 16 }}>
            <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6, textTransform: 'uppercase' }}>
              Owner
            </h4>
            <span className="badge badge-default">{task.owner}</span>
          </div>
        )}

        {/* Dependencies */}
        {blockedByTasks.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6, textTransform: 'uppercase' }}>
              Blocked By
            </h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {blockedByTasks.map(t => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <ArrowLeft size={10} style={{ color: 'var(--color-status-red)' }} />
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>#{t.id}</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{t.subject}</span>
                  <span className={`badge ${STATUS_CONFIG[t.status].bgClass}`} style={{ fontSize: 9 }}>
                    {STATUS_CONFIG[t.status].label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {blocksTasks.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6, textTransform: 'uppercase' }}>
              Blocks
            </h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {blocksTasks.map(t => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <ArrowRight size={10} style={{ color: 'var(--color-status-blue)' }} />
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>#{t.id}</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{t.subject}</span>
                  <span className={`badge ${STATUS_CONFIG[t.status].bgClass}`} style={{ fontSize: 9 }}>
                    {STATUS_CONFIG[t.status].label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Cross-reference */}
        {(task.projectName || task.machineHostname || task.sessionId) && (
          <div style={{ marginBottom: 16 }}>
            <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6, textTransform: 'uppercase' }}>
              Context
            </h4>
            <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '4px 12px', fontSize: 12 }}>
              {task.projectName && (
                <>
                  <span style={{ color: 'var(--color-text-tertiary)' }}>Project</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{task.projectName}</span>
                </>
              )}
              {task.machineHostname && (
                <>
                  <span style={{ color: 'var(--color-text-tertiary)' }}>Machine</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{task.machineHostname}</span>
                </>
              )}
              {task.sessionId && (
                <>
                  <span style={{ color: 'var(--color-text-tertiary)' }}>Session</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-secondary)' }}>
                    {task.sessionId.slice(0, 8)}
                  </span>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
