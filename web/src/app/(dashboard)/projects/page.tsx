'use client';

import { useState } from 'react';
import { useProjects } from '@/hooks/useProjects';
import { useMachineContext } from '@/contexts/MachineContext';
import { MachineBadge } from '@/components/shared/MachineBadge';
import {
  FolderOpen,
  Loader2,
  Search,
  MessageSquare,
  Clock,
  HardDrive,
  FileText,
  Plus,
  Info,
  Network,
} from 'lucide-react';
import { formatTimeAgo, formatBytes } from '@/lib/utils';
import Link from 'next/link';

export default function ProjectsPage() {
  const { projects, isLoading, error, refetch } = useProjects();
  const { isSingleMachine } = useMachineContext();
  const [search, setSearch] = useState('');

  const handleNewSession = (e: React.MouseEvent, project: typeof projects[0]) => {
    e.preventDefault();
    e.stopPropagation();
    const params = new URLSearchParams({ projectPath: project.projectPath, newSession: 'true' });
    // Only pass machineId in multi-machine mode — the console page interprets
    // machineId as "hub mode" and would call a hub API that doesn't exist locally
    if (!isSingleMachine && project.machineId) params.set('machineId', project.machineId);
    window.open(`/console?${params.toString()}`, '_blank');
  };

  const handleViewArchitecture = (e: React.MouseEvent, project: typeof projects[0]) => {
    e.preventDefault();
    e.stopPropagation();
    const params = new URLSearchParams({ project: project.projectPath });
    if (!isSingleMachine && project.machineId) params.set('machine', project.machineId);
    window.location.href = `/projects/architecture?${params.toString()}`;
  };

  // Filter out non-git projects, then apply search
  const gitProjects = projects.filter(p => p.isGitProject !== false);
  const filtered = search
    ? gitProjects.filter(p =>
        p.projectName.toLowerCase().includes(search.toLowerCase()) ||
        p.projectPath.toLowerCase().includes(search.toLowerCase())
      )
    : gitProjects;

  return (
    <div style={{ padding: 20, overflowY: 'auto', height: '100%' }} className="scrollbar-thin">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>Projects</h2>
        <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          {gitProjects.length} project{gitProjects.length !== 1 ? 's' : ''}
        </span>
        <span
          title="Only git root projects are shown. Subfolders and non-git directories are hidden."
          style={{ display: 'inline-flex', alignItems: 'center', cursor: 'help', color: 'var(--color-text-tertiary)' }}
        >
          <Info size={13} />
        </span>
        <div style={{ flex: 1 }} />
        <div style={{ position: 'relative' }}>
          <Search size={14} style={{
            position: 'absolute',
            left: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--color-text-tertiary)',
          }} />
          <input
            className="input"
            placeholder="Search projects..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ paddingLeft: 28, width: 220, fontSize: 12 }}
          />
        </div>
      </div>

      {isLoading && projects.length === 0 && (
        <div className="empty-state">
          <Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} />
          <span style={{ fontSize: 12 }}>Loading projects...</span>
        </div>
      )}

      {error && (
        <div className="empty-state">
          <span style={{ fontSize: 13, color: 'var(--color-status-red)' }}>{error}</span>
          <button className="btn btn-sm btn-secondary" onClick={refetch}>Retry</button>
        </div>
      )}

      {!isLoading && !error && filtered.length === 0 && (
        <div className="empty-state">
          <FolderOpen size={40} className="empty-state-icon" />
          <span style={{ fontSize: 14 }}>No projects found</span>
          {search && (
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              Try adjusting your search
            </span>
          )}
        </div>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
        gap: 12,
      }}>
        {filtered.map(project => {
          const accentColors = ['var(--color-accent)', 'var(--color-status-blue)', 'var(--color-status-green)', 'var(--color-status-purple)', 'var(--color-status-cyan)'];
          const colorIndex = Math.abs(project.projectName.charCodeAt(0)) % accentColors.length;
          const accent = accentColors[colorIndex];

          return (
            <Link
              key={`${project.machineId}-${project.projectPath}`}
              href={`/sessions?project=${encodeURIComponent(project.projectName)}&machine=${project.machineId}`}
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <div className="card" style={{
                padding: 16,
                cursor: 'pointer',
                borderTop: `2px solid ${accent}`,
                transition: 'border-color 0.2s',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <FolderOpen size={16} style={{ color: accent, flexShrink: 0 }} />
                  <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>{project.projectName}</span>
                  <button
                    onClick={(e) => handleViewArchitecture(e, project)}
                    title="View project architecture"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 26,
                      height: 26,
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid transparent',
                      background: 'transparent',
                      color: 'var(--color-text-tertiary)',
                      cursor: 'pointer',
                      flexShrink: 0,
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(34, 211, 238, 0.1)';
                      e.currentTarget.style.borderColor = 'rgba(34, 211, 238, 0.3)';
                      e.currentTarget.style.color = '#22d3ee';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent';
                      e.currentTarget.style.borderColor = 'transparent';
                      e.currentTarget.style.color = 'var(--color-text-tertiary)';
                    }}
                  >
                    <Network size={14} />
                  </button>
                  <button
                    onClick={(e) => handleNewSession(e, project)}
                    title="Start new Claude Code session"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 26,
                      height: 26,
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid transparent',
                      background: 'transparent',
                      color: 'var(--color-text-tertiary)',
                      cursor: 'pointer',
                      flexShrink: 0,
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(74, 222, 128, 0.1)';
                      e.currentTarget.style.borderColor = 'rgba(74, 222, 128, 0.3)';
                      e.currentTarget.style.color = 'var(--color-status-green)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent';
                      e.currentTarget.style.borderColor = 'transparent';
                      e.currentTarget.style.color = 'var(--color-text-tertiary)';
                    }}
                  >
                    <Plus size={14} />
                  </button>
                  {!isSingleMachine && (
                    <MachineBadge
                      hostname={project.machineHostname}
                      platform={project.machinePlatform}
                      status={project.machineStatus}
                    />
                  )}
                </div>

                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--color-text-tertiary)',
                  marginBottom: 12,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {project.projectPath}
                </div>

                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 8,
                  fontSize: 11,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <MessageSquare size={11} style={{ color: 'var(--color-text-tertiary)' }} />
                    <span style={{ color: 'var(--color-text-secondary)' }}>
                      {project.sessionCount}
                      {project.runningSessionCount > 0 && (
                        <span style={{ color: 'var(--color-status-green)' }}> ({project.runningSessionCount})</span>
                      )}
                    </span>
                  </div>

                  {(project.storageSize ?? 0) > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <HardDrive size={11} style={{ color: 'var(--color-text-tertiary)' }} />
                      <span style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
                        {formatBytes(project.storageSize!)}
                      </span>
                    </div>
                  )}

                  {project.lastActivity && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Clock size={11} style={{ color: 'var(--color-text-tertiary)' }} />
                      <span style={{ color: 'var(--color-text-tertiary)' }}>
                        {formatTimeAgo(project.lastActivity)}
                      </span>
                    </div>
                  )}
                </div>

                {/* Task counts */}
                {project.taskCounts && project.taskCounts.total > 0 && (
                  <div style={{
                    marginTop: 8,
                    paddingTop: 8,
                    borderTop: '1px solid var(--color-border-default)',
                    fontSize: 10,
                    color: 'var(--color-text-tertiary)',
                    fontFamily: 'var(--font-mono)',
                  }}>
                    Tasks: {project.taskCounts.pending ?? 0} pending · {project.taskCounts.inProgress ?? 0} active · {project.taskCounts.completed ?? 0} done
                  </div>
                )}

                {/* Last user message */}
                {project.lastUserMessage && (
                  <div style={{
                    marginTop: 8,
                    paddingTop: 8,
                    borderTop: '1px solid var(--color-border-default)',
                    fontSize: 11,
                    color: 'var(--color-text-secondary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    <FileText size={10} style={{ color: 'var(--color-text-tertiary)', marginRight: 4, display: 'inline', verticalAlign: 'middle' }} />
                    {project.lastUserMessage}
                  </div>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
