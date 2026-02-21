'use client';

import { useTasks, TaskFilters } from '@/hooks/useTasks';
import { useMachineContext } from '@/contexts/MachineContext';
import { MachineBadge } from '@/components/shared/MachineBadge';
import {
  CheckSquare,
  Circle,
  Loader2,
  CheckCircle2,
  ArrowLeft,
  ArrowRight,
  LayoutGrid,
  List,
  X,
  SlidersHorizontal,
} from 'lucide-react';
import type { SessionTask } from '@/lib/types';
import { useState } from 'react';
import { useDeviceInfo } from '@/hooks/useDeviceInfo';

const STATUS_CONFIG = {
  pending: { label: 'Pending', icon: Circle, color: 'var(--color-status-yellow)', bgClass: 'badge-yellow' },
  in_progress: { label: 'In Progress', icon: Loader2, color: 'var(--color-status-blue)', bgClass: 'badge-blue' },
  completed: { label: 'Completed', icon: CheckCircle2, color: 'var(--color-status-green)', bgClass: 'badge-green' },
};

export default function TasksPage() {
  const {
    groups, filteredTasks, isLoading, error, filters, setFilters,
    refetch, projectNames, counts, allTasks,
  } = useTasks();
  const { machines, isSingleMachine } = useMachineContext();
  const [viewLayout, setViewLayout] = useState<'kanban' | 'list'>('kanban');
  const [selectedTask, setSelectedTask] = useState<SessionTask | null>(null);
  const { viewMode } = useDeviceInfo();
  const isMobile = viewMode === 'mobile';
  const [filterOpen, setFilterOpen] = useState(false);
  const [kanbanStatus, setKanbanStatus] = useState<'pending' | 'in_progress' | 'completed'>('pending');

  // Total counts across all groups for FAB bar
  const totalPending = filteredTasks.filter(t => t.status === 'pending').length;
  const totalInProgress = filteredTasks.filter(t => t.status === 'in_progress').length;
  const totalCompleted = filteredTasks.filter(t => t.status === 'completed').length;

  return (
    <div className="tasks-layout" style={{ display: 'flex', height: '100%' }}>
      {/* Mobile filter toggle */}
      <button
        className="tasks-filter-toggle"
        onClick={() => setFilterOpen(!filterOpen)}
      >
        <SlidersHorizontal size={14} />
        <span>Filters</span>
        {(filters.status !== 'all' || filters.projectName || filters.machineId) && (
          <span className="badge badge-amber" style={{ fontSize: 9 }}>Active</span>
        )}
      </button>

      {/* Left filter panel */}
      <div
        className={`tasks-filter-panel scrollbar-thin ${filterOpen ? 'open' : ''}`}
        style={{
          borderRight: '1px solid var(--color-border-default)',
          padding: 16,
          overflow: 'auto',
          flexShrink: 0,
        }}
      >
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>Tasks</h3>

        {/* Summary */}
        <div style={{
          padding: 10,
          background: 'var(--color-bg-surface)',
          borderRadius: 'var(--radius-md)',
          marginBottom: 16,
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
        }}>
          <div style={{ color: 'var(--color-text-secondary)', marginBottom: 4 }}>
            {counts.total} total tasks
          </div>
          <div style={{ color: 'var(--color-status-yellow)' }}>
            {counts.pending} pending
          </div>
          <div style={{ color: 'var(--color-status-blue)' }}>
            {counts.inProgress} in progress
          </div>
          <div style={{ color: 'var(--color-status-green)' }}>
            {counts.completed} completed
          </div>
        </div>

        {/* Group by */}
        <div style={{ marginBottom: 16 }}>
          <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 8, textTransform: 'uppercase' }}>
            Group by
          </h4>
          {(['project', 'machine', 'session', 'none'] as const).map(g => (
            <label key={g} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              padding: '3px 0',
              cursor: 'pointer',
              color: filters.groupBy === g ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
            }}>
              <input
                type="radio"
                name="groupBy"
                checked={filters.groupBy === g}
                onChange={() => setFilters({ ...filters, groupBy: g })}
                style={{ accentColor: 'var(--color-accent)' }}
              />
              {g === 'none' ? 'Flat' : g.charAt(0).toUpperCase() + g.slice(1)}
            </label>
          ))}
        </div>

        {/* Status filter */}
        <div style={{ marginBottom: 16 }}>
          <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 8, textTransform: 'uppercase' }}>
            Status
          </h4>
          {(['all', 'pending', 'in_progress', 'completed'] as const).map(s => (
            <label key={s} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              padding: '3px 0',
              cursor: 'pointer',
              color: filters.status === s ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
            }}>
              <input
                type="radio"
                name="status"
                checked={filters.status === s}
                onChange={() => setFilters({ ...filters, status: s })}
                style={{ accentColor: 'var(--color-accent)' }}
              />
              {s === 'all' ? 'All' : s === 'in_progress' ? 'In Progress' : s.charAt(0).toUpperCase() + s.slice(1)}
            </label>
          ))}
        </div>

        {/* Machine filter */}
        {!isSingleMachine && (
          <div style={{ marginBottom: 16 }}>
            <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 8, textTransform: 'uppercase' }}>
              Machine
            </h4>
            <select
              className="input"
              value={filters.machineId || ''}
              onChange={e => setFilters({ ...filters, machineId: e.target.value || undefined })}
              style={{ width: '100%', fontSize: 11 }}
            >
              <option value="">All machines</option>
              {machines.map(m => (
                <option key={m.id} value={m.id}>{m.hostname}</option>
              ))}
            </select>
          </div>
        )}

        {/* Project filter */}
        {projectNames.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 8, textTransform: 'uppercase' }}>
              Project
            </h4>
            <select
              className="input"
              value={filters.projectName || ''}
              onChange={e => setFilters({ ...filters, projectName: e.target.value || undefined })}
              style={{ width: '100%', fontSize: 11 }}
            >
              <option value="">All projects</option>
              {projectNames.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
        )}

        {/* View toggle */}
        <div>
          <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 8, textTransform: 'uppercase' }}>
            View
          </h4>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              className={`btn btn-sm ${viewLayout === 'kanban' ? 'btn-secondary' : 'btn-ghost'}`}
              onClick={() => setViewLayout('kanban')}
              style={{ gap: 4 }}
            >
              <LayoutGrid size={12} /> Kanban
            </button>
            <button
              className={`btn btn-sm ${viewLayout === 'list' ? 'btn-secondary' : 'btn-ghost'}`}
              onClick={() => setViewLayout('list')}
              style={{ gap: 4 }}
            >
              <List size={12} /> List
            </button>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }} className="scrollbar-thin">
        {isLoading && allTasks.length === 0 && (
          <div className="empty-state" style={{ height: '100%' }}>
            <Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: 12 }}>Loading tasks...</span>
          </div>
        )}

        {error && (
          <div className="empty-state" style={{ height: '100%' }}>
            <span style={{ fontSize: 13, color: 'var(--color-status-red)' }}>{error}</span>
            <button className="btn btn-sm btn-secondary" onClick={refetch}>Retry</button>
          </div>
        )}

        {!isLoading && filteredTasks.length === 0 && (
          <div className="empty-state" style={{ height: '100%' }}>
            <CheckSquare size={28} className="empty-state-icon" />
            <span style={{ fontSize: 13 }}>
              {counts.totalAll > 0 ? 'No matching tasks' : 'No tasks found'}
            </span>
            {counts.totalAll > 0 && (
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                Try adjusting your filters
              </span>
            )}
          </div>
        )}

        {groups.map(group => (
          <div key={group.key} style={{ marginBottom: 24 }}>
            {/* Group header */}
            {filters.groupBy !== 'none' && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 12,
                padding: '8px 12px',
                background: 'var(--color-bg-surface)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border-default)',
              }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{group.label}</span>
                {group.sublabel && (
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                    {group.sublabel}
                  </span>
                )}
                {group.machineHostname && !isSingleMachine && (
                  <MachineBadge
                    hostname={group.machineHostname}
                    platform={group.machinePlatform || 'linux'}
                    status={group.machineStatus || 'online'}
                  />
                )}
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                  {group.tasks.length} task{group.tasks.length !== 1 ? 's' : ''}
                </span>
              </div>
            )}

            {viewLayout === 'kanban' ? (
              <KanbanRow tasks={group.tasks} onSelect={setSelectedTask} mobileActiveStatus={isMobile ? kanbanStatus : undefined} />
            ) : (
              <TaskListView tasks={group.tasks} onSelect={setSelectedTask} />
            )}
          </div>
        ))}
      </div>

      {/* Task detail popup */}
      {selectedTask && (
        <TaskPopup
          task={selectedTask}
          allTasks={allTasks}
          onClose={() => setSelectedTask(null)}
        />
      )}

      {/* Mobile kanban status FAB bar */}
      {isMobile && viewLayout === 'kanban' && (
        <div className="kanban-fab-bar">
          {([
            { status: 'pending' as const, count: totalPending },
            { status: 'in_progress' as const, count: totalInProgress },
            { status: 'completed' as const, count: totalCompleted },
          ]).map(({ status, count }) => {
            const config = STATUS_CONFIG[status];
            return (
              <button
                key={status}
                className={`kanban-fab-btn ${kanbanStatus === status ? 'active' : ''}`}
                style={{ '--fab-color': config.color } as React.CSSProperties}
                onClick={() => setKanbanStatus(status)}
              >
                <config.icon size={12} />
                <span>{config.label}</span>
                <span className="kanban-fab-count">{count}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function KanbanRow({ tasks, onSelect, mobileActiveStatus }: { tasks: SessionTask[]; onSelect: (t: SessionTask) => void; mobileActiveStatus?: string }) {
  const pending = tasks.filter(t => t.status === 'pending');
  const inProgress = tasks.filter(t => t.status === 'in_progress');
  const completed = tasks.filter(t => t.status === 'completed');

  const columns = [
    { status: 'pending' as const, items: pending },
    { status: 'in_progress' as const, items: inProgress },
    { status: 'completed' as const, items: completed },
  ];

  return (
    <div className="kanban-board">
      {columns.map(({ status, items }) => {
        const config = STATUS_CONFIG[status];
        // On mobile, only show the active status column
        if (mobileActiveStatus && status !== mobileActiveStatus) return null;
        return (
          <div key={status} className="kanban-column">
            <div className="kanban-column-header">
              <config.icon size={14} style={{ color: config.color }} />
              <span>{config.label}</span>
              <span className={`badge ${config.bgClass}`} style={{ fontSize: 10 }}>{items.length}</span>
            </div>
            <div className="kanban-column-body">
              {items.map(task => (
                <TaskCardCompact key={task.id} task={task} onClick={() => onSelect(task)} />
              ))}
              {items.length === 0 && (
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

function TaskCardCompact({ task, onClick }: { task: SessionTask; onClick: () => void }) {
  const isBlocked = task.blockedBy && task.blockedBy.length > 0 && task.status !== 'completed';
  const config = STATUS_CONFIG[task.status];

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
        {task.projectName && (
          <span className="badge badge-default" style={{ fontSize: 9 }}>{task.projectName}</span>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--color-text-primary)', lineHeight: 1.4 }}>
        {task.subject}
      </div>
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

function TaskListView({ tasks, onSelect }: { tasks: SessionTask[]; onSelect: (t: SessionTask) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {tasks.map(task => {
        const config = STATUS_CONFIG[task.status];
        return (
          <div
            key={task.id}
            onClick={() => onSelect(task)}
            className="card"
            style={{
              display: 'grid',
              gridTemplateColumns: '32px 1fr 100px 80px',
              gap: 8,
              padding: '6px 8px',
              fontSize: 12,
              cursor: 'pointer',
              borderLeft: `2px solid ${config.color}`,
            }}
          >
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)', fontSize: 11 }}>
              {task.id}
            </span>
            <span style={{ color: 'var(--color-text-primary)' }}>{task.subject}</span>
            <span className={`badge ${config.bgClass}`} style={{ fontSize: 10, width: 'fit-content' }}>
              {config.label}
            </span>
            <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
              {task.projectName || '—'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TaskPopup({
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
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 520, maxHeight: '80vh', overflow: 'auto', padding: 24 }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>#{task.id}</span>
              <span className={`badge ${config.bgClass}`}>{config.label}</span>
            </div>
            <h3 style={{ fontSize: 16, fontWeight: 600 }}>{task.subject}</h3>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose}><X size={14} /></button>
        </div>

        {task.description && (
          <div style={{ marginBottom: 16 }}>
            <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6, textTransform: 'uppercase' }}>Description</h4>
            <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap' }}>{task.description}</p>
          </div>
        )}

        {blockedByTasks.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6, textTransform: 'uppercase' }}>Blocked By</h4>
            {blockedByTasks.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '2px 0' }}>
                <ArrowLeft size={10} style={{ color: 'var(--color-status-red)' }} />
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>#{t.id}</span>
                <span style={{ color: 'var(--color-text-secondary)' }}>{t.subject}</span>
                <span className={`badge ${STATUS_CONFIG[t.status].bgClass}`} style={{ fontSize: 9 }}>{STATUS_CONFIG[t.status].label}</span>
              </div>
            ))}
          </div>
        )}

        {blocksTasks.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6, textTransform: 'uppercase' }}>Blocks</h4>
            {blocksTasks.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '2px 0' }}>
                <ArrowRight size={10} style={{ color: 'var(--color-status-blue)' }} />
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>#{t.id}</span>
                <span style={{ color: 'var(--color-text-secondary)' }}>{t.subject}</span>
                <span className={`badge ${STATUS_CONFIG[t.status].bgClass}`} style={{ fontSize: 9 }}>{STATUS_CONFIG[t.status].label}</span>
              </div>
            ))}
          </div>
        )}

        {(task.projectName || task.machineHostname || task.sessionId) && (
          <div>
            <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6, textTransform: 'uppercase' }}>Context</h4>
            <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '4px 12px', fontSize: 12 }}>
              {task.projectName && (
                <><span style={{ color: 'var(--color-text-tertiary)' }}>Project</span><span style={{ color: 'var(--color-text-secondary)' }}>{task.projectName}</span></>
              )}
              {task.machineHostname && (
                <><span style={{ color: 'var(--color-text-tertiary)' }}>Machine</span><span style={{ color: 'var(--color-text-secondary)' }}>{task.machineHostname}</span></>
              )}
              {task.sessionId && (
                <><span style={{ color: 'var(--color-text-tertiary)' }}>Session</span><span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-secondary)' }}>{task.sessionId.slice(0, 8)}</span></>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
