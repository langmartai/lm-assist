'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, X, Clock, MessageSquare, Cpu, ListChecks, User, Users, ExternalLink, GitFork, ChevronDown } from 'lucide-react';
import { useHighlight } from '@/hooks/useHighlight';
import { useMachineContext } from '@/contexts/MachineContext';
import { formatTimeAgo, getSessionIdShort, formatCost, getModelShortName, formatBytes } from '@/lib/utils';
import type { useSessions } from '@/hooks/useSessions';
import type { SubagentSession } from '@/lib/types';
import { isProcessManaged, managedByLabel } from '@/lib/types';

interface SessionSidebarProps {
  sessionsHook: ReturnType<typeof useSessions>;
  selectedSessionId: string | null;
  sidebarHighlightId?: string;
  onSelectSession: (sessionId: string, machineId: string) => void;
  lastSuggestion?: { text: string; updatedAt?: string } | null;
  subagents?: SubagentSession[];
  gitProjectNames?: Set<string>;
  scrollToSessionId?: string | null;
}

export function SessionSidebar({
  sessionsHook,
  selectedSessionId,
  sidebarHighlightId,
  onSelectSession,
  lastSuggestion,
  subagents,
  gitProjectNames,
  scrollToSessionId,
}: SessionSidebarProps) {
  const { sessions, allSessions, isLoading, filters, setFilters, projectNames } = sessionsHook;
  const [displayLimit, setDisplayLimit] = useState(50);
  // Reset display limit when filters change
  const filterKey = `${filters.search}|${filters.machineId}|${filters.projectName}|${filters.timeRange}`;
  const prevFilterKeyRef = useRef(filterKey);
  if (filterKey !== prevFilterKeyRef.current) {
    prevFilterKeyRef.current = filterKey;
    setDisplayLimit(50);
  }
  const visibleSessions = sessions.slice(0, displayLimit);
  const hasMore = sessions.length > displayLimit;
  // Filter dropdown to only show git root projects
  const filteredProjectNames = gitProjectNames && gitProjectNames.size > 0
    ? projectNames.filter(name => gitProjectNames.has(name))
    : projectNames;
  const { isSingleMachine } = useMachineContext();

  // Scroll to URL-specified session once sessions load
  const scrolledToUrlRef = useRef(false);
  useEffect(() => {
    if (scrolledToUrlRef.current || !scrollToSessionId || sessions.length === 0 || isLoading) return;
    scrolledToUrlRef.current = true;
    const tryScroll = (delay: number) => {
      setTimeout(() => {
        const el = document.querySelector(`[data-session-id="${scrollToSessionId}"]`) as HTMLElement | null;
        if (!el) {
          if (delay < 2000) tryScroll(delay + 200);
          return;
        }
        let parent = el.parentElement;
        while (parent) {
          const style = getComputedStyle(parent);
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
            const containerRect = parent.getBoundingClientRect();
            const elRect = el.getBoundingClientRect();
            const offset = elRect.top - containerRect.top - (containerRect.height / 2) + (elRect.height / 2);
            parent.scrollTop = parent.scrollTop + offset;
            break;
          }
          parent = parent.parentElement;
        }
      }, delay);
    };
    tryScroll(300);
  }, [scrollToSessionId, sessions, isLoading]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '10px 12px',
        borderBottom: '1px solid var(--color-border-default)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            Sessions ({hasMore ? `${displayLimit}/${sessions.length}` : sessions.length})
          </span>
          {sessions.length !== allSessions.length && (
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              of {allSessions.length}
            </span>
          )}
        </div>
        {hasMore && (
          <button
            onClick={() => setDisplayLimit(prev => prev + 100)}
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '2px 10px',
              cursor: 'pointer',
              background: 'var(--color-accent-emphasis)',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              whiteSpace: 'nowrap',
            }}
          >
            <ChevronDown size={11} />
            More +100
          </button>
        )}
      </div>

      {/* Search */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border-subtle)' }}>
        <div style={{ position: 'relative' }}>
          <Search
            size={13}
            style={{
              position: 'absolute',
              left: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--color-text-tertiary)',
            }}
          />
          <input
            className="input"
            placeholder="Filter sessions..."
            value={filters.search}
            onChange={e => setFilters({ search: e.target.value })}
            style={{ paddingLeft: 28, fontSize: 12 }}
          />
          {filters.search && (
            <button
              onClick={() => setFilters({ search: '' })}
              style={{
                position: 'absolute',
                right: 6,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--color-text-tertiary)',
              }}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div style={{
        padding: '6px 12px',
        borderBottom: '1px solid var(--color-border-subtle)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
      }}>
        {/* Project filter */}
        <select
          className="input"
          style={{ width: 'auto', fontSize: 11, padding: '3px 6px' }}
          value={filters.projectName || ''}
          onChange={e => setFilters({ projectName: e.target.value || null })}
        >
          <option value="">All projects</option>
          {filteredProjectNames.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>

        {/* Time filter */}
        <select
          className="input"
          style={{ width: 'auto', fontSize: 11, padding: '3px 6px' }}
          value={filters.timeRange}
          onChange={e => setFilters({ timeRange: e.target.value as any })}
        >
          <option value="all">All time</option>
          <option value="today">Today</option>
          <option value="week">This week</option>
          <option value="month">This month</option>
        </select>

      </div>

      {/* Session list */}
      <div style={{ flex: 1, overflowY: 'auto' }} className="scrollbar-thin">
        {isLoading ? (
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="skeleton" style={{ height: 72 }} />
            ))}
          </div>
        ) : visibleSessions.length === 0 ? (
          <div className="empty-state" style={{ padding: 32 }}>
            <MessageSquare size={24} className="empty-state-icon" />
            <span style={{ fontSize: 12 }}>No sessions found</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {visibleSessions.map(session => {
              const effectiveSelectedId = sidebarHighlightId || selectedSessionId;
              const isSelected = effectiveSelectedId === session.sessionId;
              return (
                <div key={`${session.machineId}-${session.sessionId}`} data-session-id={session.sessionId}>
                  <SessionCard
                    session={session}
                    isSelected={isSelected}
                    showMachine={!isSingleMachine}
                    onClick={() => onSelectSession(session.sessionId, session.machineId)}
                  />
                  {/* Subagent list — expanded below selected session */}
                  {isSelected && subagents && subagents.length > 0 && (
                    <SubagentList
                      subagents={subagents}
                      lastSuggestion={lastSuggestion}
                      sessionId={session.sessionId}
                      machineId={session.machineId}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// Subagent List (expanded below selected session)
// ============================================

function getAgentTypeLabel(agent: SubagentSession): string {
  if (agent.type) return agent.type;
  const id = agent.agentId || '';
  if (id.startsWith('aprompt_suggestion')) return 'suggestion';
  if (id.startsWith('acompact')) return 'compact';
  return 'agent';
}

function SubagentList({ subagents, lastSuggestion, sessionId, machineId }: {
  subagents: SubagentSession[];
  lastSuggestion?: { text: string; updatedAt?: string } | null;
  sessionId: string;
  machineId: string;
}) {
  // Filter out suggestion/compact agents — show only Task-spawned agents, most recent first
  const taskAgents = subagents
    .filter(a => {
      const id = a.agentId || '';
      return !id.startsWith('aprompt_suggestion') && !id.startsWith('acompact');
    })
    .sort((a, b) => {
      const aTime = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
      const bTime = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
      return bTime - aTime;
    });

  if (taskAgents.length === 0 && !lastSuggestion) return null;

  return (
    <div style={{
      borderLeft: '2px solid var(--color-accent)',
      marginLeft: 2,
      background: 'var(--color-bg-hover)',
    }}>
      {/* Last suggestion */}
      {lastSuggestion && (
        <div style={{
          padding: '4px 10px 4px 12px',
          fontSize: 11,
          color: 'var(--color-text-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          borderBottom: taskAgents.length > 0 ? '1px solid var(--color-border-subtle)' : undefined,
        }}>
          <span style={{ opacity: 0.7, flexShrink: 0 }}>💡</span>
          <span className="truncate" style={{ flex: 1 }}>{lastSuggestion.text}</span>
          {lastSuggestion.updatedAt && (
            <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', flexShrink: 0, whiteSpace: 'nowrap' }}>
              {formatTimeAgo(lastSuggestion.updatedAt)}
            </span>
          )}
        </div>
      )}
      {/* Task agents */}
      {taskAgents.map(agent => (
        <div
          key={agent.agentId}
          style={{
            padding: '3px 10px 3px 12px',
            fontSize: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            cursor: 'pointer',
            borderBottom: '1px solid var(--color-border-subtle)',
          }}
          onClick={(e) => {
            e.stopPropagation();
            const params = new URLSearchParams();
            params.set('session', agent.agentId);
            params.set('parent', sessionId);
            params.set('machine', machineId);
            window.open(`/sessions?${params.toString()}`, '_blank');
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLDivElement).style.background = 'var(--color-bg-elevated)';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLDivElement).style.background = 'transparent';
          }}
          title={agent.prompt || `Open ${agent.agentId}`}
        >
          <Cpu size={9} style={{ flexShrink: 0, color: 'var(--color-text-quaternary, var(--color-text-tertiary))' }} />
          <span className="badge badge-default" style={{ fontSize: 8, padding: '0 4px', flexShrink: 0 }}>
            {getAgentTypeLabel(agent)}
          </span>
          <span className="truncate" style={{ color: 'var(--color-text-tertiary)', flex: 1, minWidth: 0 }}>
            {agent.prompt || agent.agentId?.slice(0, 12)}
          </span>
          {agent.status === 'completed' && (
            <span style={{ color: 'var(--color-status-green)', flexShrink: 0 }}>✓</span>
          )}
          {agent.status === 'running' && (
            <span className="status-dot running" style={{ flexShrink: 0 }} />
          )}
          {agent.lastActivityAt && (
            <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', flexShrink: 0, whiteSpace: 'nowrap' }}>
              {formatTimeAgo(agent.lastActivityAt)}
            </span>
          )}
          <ExternalLink size={8} style={{ flexShrink: 0, opacity: 0.4 }} />
        </div>
      ))}
    </div>
  );
}

// ============================================
// Session Card
// ============================================

interface SessionCardProps {
  session: import('@/lib/types').Session;
  isSelected: boolean;
  showMachine: boolean;
  onClick: () => void;
}

function SessionCard({ session, isSelected, showMachine, onClick }: SessionCardProps) {
  const hlClass = useHighlight(session.numTurns);
  return (
    <div
      onClick={onClick}
      className={`animate-fade-in${hlClass ? ` ${hlClass}` : ''}`}
      style={{
        padding: '10px 12px',
        cursor: 'pointer',
        borderBottom: '1px solid var(--color-border-subtle)',
        background: isSelected ? 'var(--color-accent-glow)' : 'transparent',
        borderLeft: isSelected ? '2px solid var(--color-accent)' : '2px solid transparent',
        transition: 'all 150ms ease',
      }}
      onMouseEnter={e => {
        if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'var(--color-bg-hover)';
      }}
      onMouseLeave={e => {
        if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'transparent';
      }}
    >
      {/* Top row: project name + running indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        {session.isRunning && <span className="status-dot running" />}
        {session.running && (
          <span className="badge" style={{
            fontSize: 8, padding: '0 4px',
            background: isProcessManaged(session.running.managedBy) ? 'rgba(34,197,94,0.15)' : 'rgba(251,146,60,0.15)',
            color: isProcessManaged(session.running.managedBy) ? 'var(--color-status-green)' : 'var(--color-status-orange)',
            border: `1px solid ${isProcessManaged(session.running.managedBy) ? 'rgba(34,197,94,0.3)' : 'rgba(251,146,60,0.3)'}`,
          }}>
            {managedByLabel(session.running.managedBy)}
          </span>
        )}
        <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }} className="truncate">
          {session.projectName}
        </span>
        {session.machineStatus === 'offline' && (
          <span className="badge badge-default" style={{ fontSize: 8, padding: '0 4px', opacity: 0.7 }}>
            Cached
          </span>
        )}
        {session.size !== undefined && session.size > 0 && (
          <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
            {formatBytes(session.size)}
          </span>
        )}
        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          {getSessionIdShort(session.sessionId)}
        </span>
      </div>

      {/* Summary preview */}
      {(session.lastUserMessage || session.summary) && (
        <div
          className="line-clamp-2"
          style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 6, lineHeight: 1.4 }}
        >
          {session.lastUserMessage || session.summary}
        </div>
      )}

      {/* Bottom row: meta badges */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', gap: 3 }}>
          <Clock size={10} />
          {formatTimeAgo(session.lastModified)}
        </span>
        {session.model && (
          <span className="badge badge-default" style={{ fontSize: 9, padding: '1px 5px' }}>
            {getModelShortName(session.model)}
          </span>
        )}
        {session.totalCostUsd !== undefined && session.totalCostUsd > 0 && (
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
            {formatCost(session.totalCostUsd)}
          </span>
        )}
        {session.numTurns !== undefined && (
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
            T:{session.numTurns}
          </span>
        )}
        {session.userPromptCount !== undefined && session.userPromptCount > 0 && (
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <User size={10} />{session.userPromptCount}
          </span>
        )}
        {session.taskCount !== undefined && session.taskCount > 0 && (
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <ListChecks size={10} />{session.taskCount}
          </span>
        )}
        {session.agentCount !== undefined && session.agentCount > 0 && (
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <Cpu size={10} />{session.agentCount}
          </span>
        )}
        {session.allTeams && session.allTeams.length > 1 ? (
          <span style={{ fontSize: 9, padding: '0px 4px', background: 'rgba(139,92,246,0.15)', color: '#8b5cf6', border: '1px solid rgba(139,92,246,0.3)', borderRadius: 3, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <Users size={10} />{session.allTeams.length} teams
          </span>
        ) : session.teamName ? (
          <span style={{ fontSize: 9, padding: '0px 4px', background: 'rgba(139,92,246,0.15)', color: '#8b5cf6', border: '1px solid rgba(139,92,246,0.3)', borderRadius: 3, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <Users size={10} />{session.teamName}
          </span>
        ) : null}
        {session.forkedFromSessionId && (
          <span style={{ fontSize: 9, padding: '0px 4px', background: 'rgba(6,182,212,0.15)', color: '#06b6d4', border: '1px solid rgba(6,182,212,0.3)', borderRadius: 3, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <GitFork size={10} />Fork
          </span>
        )}
      </div>
    </div>
  );
}
