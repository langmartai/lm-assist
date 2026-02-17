'use client';

import { useState, useMemo } from 'react';
import {
  Cpu,
  CheckCircle2,
  AlertCircle,
  Circle,
  Users,
  HardDrive,
} from 'lucide-react';
import type { SubagentSession } from '@/lib/types';

interface AgentsTabProps {
  subagents: SubagentSession[];
  sessionId?: string;
  machineId?: string;
  projectPath?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AgentsTab({ subagents, sessionId, machineId, projectPath }: AgentsTabProps) {
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  // Compute unique agent types for filter bar
  const agentTypes = useMemo(() => {
    const types = new Map<string, number>();
    for (const agent of subagents) {
      const t = agent.type || 'agent';
      types.set(t, (types.get(t) || 0) + 1);
    }
    return Array.from(types.entries()).sort((a, b) => b[1] - a[1]);
  }, [subagents]);

  // Filter and sort
  const filteredAgents = useMemo(() => {
    let list = subagents;
    if (activeFilter) {
      list = list.filter(a => (a.type || 'agent') === activeFilter);
    }
    return [...list].sort((a, b) => {
      const aTime = a.lastActivityAt || '';
      const bTime = b.lastActivityAt || '';
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    });
  }, [subagents, activeFilter]);

  if (subagents.length === 0) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <Users size={28} className="empty-state-icon" />
        <span style={{ fontSize: 13 }}>No subagents spawned</span>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          Task tool invocations will appear here
        </span>
      </div>
    );
  }

  const completed = subagents.filter(s => s.status === 'completed').length;
  const running = subagents.filter(s => s.status === 'running').length;
  const errored = subagents.filter(s => s.status === 'error').length;

  return (
    <div style={{ padding: 12, overflowY: 'auto', height: '100%' }} className="scrollbar-thin">
      {/* Summary */}
      <div style={{ display: 'flex', gap: 12, fontSize: 11, marginBottom: 8 }}>
        <span style={{ color: 'var(--color-status-purple)' }}>
          {subagents.length} subagent{subagents.length !== 1 ? 's' : ''}
        </span>
        {completed > 0 && (
          <span style={{ color: 'var(--color-status-green)' }}>{completed} completed</span>
        )}
        {running > 0 && (
          <span style={{ color: 'var(--color-status-blue)' }}>{running} running</span>
        )}
        {errored > 0 && (
          <span style={{ color: 'var(--color-status-red)' }}>{errored} errored</span>
        )}
      </div>

      {/* Filter bar */}
      {agentTypes.length > 1 && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
          marginBottom: 10,
          paddingBottom: 8,
          borderBottom: '1px solid var(--color-border-subtle)',
        }}>
          <button
            onClick={() => setActiveFilter(null)}
            style={{
              padding: '2px 8px',
              fontSize: 10,
              borderRadius: 10,
              border: '1px solid',
              borderColor: !activeFilter ? 'var(--color-accent)' : 'var(--color-border-default)',
              background: !activeFilter ? 'var(--color-accent-bg)' : 'transparent',
              color: !activeFilter ? 'var(--color-accent)' : 'var(--color-text-secondary)',
              cursor: 'pointer',
            }}
          >
            All ({subagents.length})
          </button>
          {agentTypes.map(([type, count]) => (
            <button
              key={type}
              onClick={() => setActiveFilter(activeFilter === type ? null : type)}
              style={{
                padding: '2px 8px',
                fontSize: 10,
                borderRadius: 10,
                border: '1px solid',
                borderColor: activeFilter === type ? 'var(--color-accent)' : 'var(--color-border-default)',
                background: activeFilter === type ? 'var(--color-accent-bg)' : 'transparent',
                color: activeFilter === type ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                cursor: 'pointer',
              }}
            >
              {type} ({count})
            </button>
          ))}
        </div>
      )}

      {/* Agent list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filteredAgents.map((agent, idx) => (
          <AgentCard key={agent.agentId || idx} agent={agent} sessionId={sessionId} machineId={machineId} projectPath={projectPath} />
        ))}
      </div>
    </div>
  );
}

function AgentCard({ agent, sessionId, machineId, projectPath }: { agent: SubagentSession; sessionId?: string; machineId?: string; projectPath?: string }) {
  const handleClick = () => {
    if (!agent.agentId) return;
    const params = new URLSearchParams();
    params.set('session', agent.agentId);
    if (sessionId) params.set('parent', sessionId);
    if (machineId) params.set('machine', machineId);
    if (projectPath) params.set('project', projectPath);
    window.open(`/sessions?${params.toString()}`, '_blank');
  };

  const StatusIcon = agent.status === 'running'
    ? Circle
    : agent.status === 'completed'
    ? CheckCircle2
    : agent.status === 'error'
    ? AlertCircle
    : Circle;

  const statusColor = agent.status === 'running'
    ? 'var(--color-status-blue)'
    : agent.status === 'completed'
    ? 'var(--color-status-green)'
    : agent.status === 'error'
    ? 'var(--color-status-red)'
    : 'var(--color-status-yellow)';

  return (
    <div
      style={{
        padding: '10px 12px',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border-default)',
        background: 'var(--color-bg-surface)',
        cursor: agent.agentId ? 'pointer' : undefined,
        transition: 'border-color 150ms ease',
      }}
      onClick={handleClick}
      onMouseEnter={e => { if (agent.agentId) (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--color-accent)'; }}
      onMouseLeave={e => { if (agent.agentId) (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--color-border-default)'; }}
      title={agent.agentId ? 'Open agent session in new tab' : undefined}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <StatusIcon size={12} style={{ color: statusColor, flexShrink: 0 }} />
        <span className="badge badge-purple" style={{ fontSize: 10 }}>
          <Cpu size={10} style={{ marginRight: 3 }} />
          {agent.type || 'agent'}
        </span>
        {agent.agentId && (
          <span style={{
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-text-tertiary)',
          }}>
            {agent.agentId.slice(0, 12)}
          </span>
        )}
        {agent.model && (
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
            {agent.model}
          </span>
        )}
        {agent.fileSize !== undefined && agent.fileSize > 0 && (
          <span style={{
            fontSize: 10,
            color: 'var(--color-text-tertiary)',
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 3,
          }}>
            <HardDrive size={9} />
            {formatFileSize(agent.fileSize)}
          </span>
        )}
      </div>

      {/* Prompt */}
      {agent.prompt && (
        <p style={{
          fontSize: 11,
          color: 'var(--color-text-secondary)',
          marginBottom: 8,
          lineHeight: 1.5,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {agent.prompt.length > 200 ? agent.prompt.slice(0, 200) + '...' : agent.prompt}
        </p>
      )}

      {/* Stats */}
      <div style={{
        display: 'flex',
        gap: 12,
        fontSize: 10,
        color: 'var(--color-text-tertiary)',
        borderTop: '1px solid var(--color-border-subtle)',
        paddingTop: 6,
      }}>
        {agent.turns !== undefined && <span>{agent.turns} turns</span>}
        {agent.toolUses !== undefined && <span>{agent.toolUses} tool uses</span>}
        {agent.tokensUsed !== undefined && (
          <span>{(agent.tokensUsed / 1000).toFixed(1)}k tokens</span>
        )}
      </div>

      {/* Tool summary badges */}
      {agent.toolSummary && Object.keys(agent.toolSummary).length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
          {Object.entries(agent.toolSummary).slice(0, 5).map(([name, count]) => (
            <span key={name} className="badge badge-default" style={{ fontSize: 9 }}>
              {name} ({count})
            </span>
          ))}
        </div>
      )}

      {/* Last response preview */}
      {agent.lastResponse && (
        <div style={{
          marginTop: 8,
          padding: 8,
          borderRadius: 'var(--radius-sm)',
          background: 'var(--color-bg-base)',
          fontSize: 10,
          color: 'var(--color-text-tertiary)',
          lineHeight: 1.5,
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {agent.lastResponse.slice(0, 300)}
        </div>
      )}
    </div>
  );
}
