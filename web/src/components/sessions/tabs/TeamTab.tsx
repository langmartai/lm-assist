'use client';

import { useState, useMemo } from 'react';
import {
  Users,
  MessageSquare,
  ListChecks,
  Send,
  UserPlus,
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { SessionMessage } from '@/lib/types';

// ============================================
// Types
// ============================================

interface TeamTabProps {
  messages: SessionMessage[];
  teamName?: string;
  allTeams?: string[];
  taskSubjects?: Record<string, string>;
}

interface TeamMember {
  name: string;
  type?: string;
  model?: string;
  color?: string;
  joinedTurn?: number;
}

interface TeamMessage {
  type: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response';
  sender?: string;
  recipient?: string;
  summary?: string;
  content?: string;
  turnIndex?: number;
}

interface TeamTaskEvent {
  tool: 'TaskCreate' | 'TaskUpdate' | 'TaskList' | 'TaskGet';
  taskId?: string;
  subject?: string;
  status?: string;
  owner?: string;
  description?: string;
  turnIndex?: number;
}

interface TeamEvent {
  kind: 'spawn' | 'cleanup' | 'message' | 'task';
  turnIndex?: number;
  data: TeamMember | TeamMessage | TeamTaskEvent;
}

// ============================================
// Data extraction
// ============================================

function extractTeamData(messages: SessionMessage[], taskSubjects?: Record<string, string>) {
  const members: TeamMember[] = [];
  const teamMessages: TeamMessage[] = [];
  const taskEvents: TeamTaskEvent[] = [];
  const timeline: TeamEvent[] = [];
  let teamName: string | undefined;

  for (const msg of messages) {
    if (!msg.toolName) continue;
    const inp = msg.toolInput || {};

    if (msg.toolName === 'Teammate') {
      const op = String(inp.operation || 'spawnTeam');
      if (op === 'spawnTeam') {
        teamName = String(inp.team_name || '');
        const member: TeamMember = {
          name: String(inp.team_name || ''),
          type: String(inp.agent_type || ''),
          joinedTurn: msg.turnIndex,
        };
        // Don't add team spawn as a member -- it's the team itself
        timeline.push({ kind: 'spawn', turnIndex: msg.turnIndex, data: member });
      } else if (op === 'cleanup') {
        timeline.push({ kind: 'cleanup', turnIndex: msg.turnIndex, data: { name: '', joinedTurn: msg.turnIndex } });
      }
    }

    // Task tool calls that spawn agents (subagent_type set)
    if (msg.toolName === 'Task' && inp.team_name) {
      const member: TeamMember = {
        name: String(inp.name || ''),
        type: String(inp.subagent_type || 'agent'),
        model: String(inp.model || ''),
        color: String(inp.color || ''),
        joinedTurn: msg.turnIndex,
      };
      members.push(member);
      timeline.push({ kind: 'spawn', turnIndex: msg.turnIndex, data: member });
    }

    if (msg.toolName === 'SendMessage') {
      const tmsg: TeamMessage = {
        type: (inp.type as TeamMessage['type']) || 'message',
        sender: undefined, // determined from context
        recipient: inp.recipient ? String(inp.recipient) : undefined,
        summary: inp.summary ? String(inp.summary) : undefined,
        content: inp.content ? String(inp.content) : undefined,
        turnIndex: msg.turnIndex,
      };
      teamMessages.push(tmsg);
      timeline.push({ kind: 'message', turnIndex: msg.turnIndex, data: tmsg });
    }

    if (['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'].includes(msg.toolName)) {
      // Resolve subject from backend-provided taskSubjects map
      let resolvedSubject = inp.subject ? String(inp.subject) : undefined;
      if (!resolvedSubject && inp.taskId && taskSubjects) {
        resolvedSubject = taskSubjects[String(inp.taskId)];
      }

      const evt: TeamTaskEvent = {
        tool: msg.toolName as TeamTaskEvent['tool'],
        taskId: inp.taskId ? String(inp.taskId) : undefined,
        subject: resolvedSubject,
        status: inp.status ? String(inp.status) : undefined,
        owner: inp.owner ? String(inp.owner) : undefined,
        description: inp.description ? String(inp.description) : undefined,
        turnIndex: msg.turnIndex,
      };
      taskEvents.push(evt);
      timeline.push({ kind: 'task', turnIndex: msg.turnIndex, data: evt });
    }
  }

  // Sort timeline by turnIndex
  timeline.sort((a, b) => (a.turnIndex || 0) - (b.turnIndex || 0));

  return { teamName, members, teamMessages, taskEvents, timeline };
}

// ============================================
// Member colors
// ============================================

const MEMBER_COLORS = [
  { bg: 'rgba(139,92,246,0.15)', fg: '#8b5cf6', border: 'rgba(139,92,246,0.3)' },
  { bg: 'rgba(59,130,246,0.15)', fg: '#3b82f6', border: 'rgba(59,130,246,0.3)' },
  { bg: 'rgba(16,185,129,0.15)', fg: '#10b981', border: 'rgba(16,185,129,0.3)' },
  { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b', border: 'rgba(245,158,11,0.3)' },
  { bg: 'rgba(236,72,153,0.15)', fg: '#ec4899', border: 'rgba(236,72,153,0.3)' },
  { bg: 'rgba(20,184,166,0.15)', fg: '#14b8a6', border: 'rgba(20,184,166,0.3)' },
];

function getMemberColor(index: number) {
  return MEMBER_COLORS[index % MEMBER_COLORS.length];
}

// ============================================
// Tab views
// ============================================

type TeamViewMode = 'timeline' | 'messages' | 'tasks' | 'members';

export function TeamTab({ messages, teamName: teamNameProp, allTeams, taskSubjects }: TeamTabProps) {
  const [viewMode, setViewMode] = useState<TeamViewMode>('timeline');

  const { teamName, members, teamMessages, taskEvents, timeline } = useMemo(
    () => extractTeamData(messages, taskSubjects),
    [messages, taskSubjects],
  );

  const displayTeams = allTeams && allTeams.length > 0 ? allTeams : (teamNameProp || teamName) ? [teamNameProp || teamName!] : [];
  const totalEntries = timeline.length;

  if (totalEntries === 0) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <Users size={28} className="empty-state-icon" />
        <span style={{ fontSize: 13 }}>No team activity in this session</span>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          Teammate, SendMessage, and Task tool calls will appear here
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '6px 16px',
        borderBottom: '1px solid var(--color-border-default)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        {displayTeams.map(t => (
          <span key={t} style={{
            fontSize: 12,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 4,
            background: 'rgba(139,92,246,0.15)',
            color: '#8b5cf6',
            border: '1px solid rgba(139,92,246,0.3)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}>
            <Users size={12} />
            {t}
          </span>
        ))}

        <div style={{ width: 1, height: 14, background: 'var(--color-border-default)' }} />

        {/* View mode tabs */}
        {([
          { id: 'timeline' as TeamViewMode, icon: Clock, label: 'Timeline' },
          { id: 'messages' as TeamViewMode, icon: MessageSquare, label: 'Messages' },
          { id: 'tasks' as TeamViewMode, icon: ListChecks, label: 'Tasks' },
          { id: 'members' as TeamViewMode, icon: Users, label: 'Members' },
        ]).map(v => (
          <button
            key={v.id}
            className={`btn btn-sm ${viewMode === v.id ? 'btn-secondary' : 'btn-ghost'}`}
            onClick={() => setViewMode(v.id)}
            style={{ gap: 4 }}
          >
            <v.icon size={12} />
            {v.label}
            {v.id === 'messages' && teamMessages.length > 0 && (
              <span style={{ fontSize: 9, opacity: 0.7 }}>({teamMessages.length})</span>
            )}
            {v.id === 'tasks' && taskEvents.length > 0 && (
              <span style={{ fontSize: 9, opacity: 0.7 }}>({taskEvents.length})</span>
            )}
            {v.id === 'members' && members.length > 0 && (
              <span style={{ fontSize: 9, opacity: 0.7 }}>({members.length})</span>
            )}
          </button>
        ))}

        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          {members.length} members · {teamMessages.length} msgs · {taskEvents.length} task ops
        </span>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }} className="scrollbar-thin">
        {viewMode === 'timeline' && <TimelineView timeline={timeline} members={members} />}
        {viewMode === 'messages' && <MessagesView messages={teamMessages} members={members} />}
        {viewMode === 'tasks' && <TaskEventsView events={taskEvents} />}
        {viewMode === 'members' && <MembersView members={members} />}
      </div>
    </div>
  );
}

// ============================================
// Timeline View
// ============================================

function TimelineView({ timeline, members }: { timeline: TeamEvent[]; members: TeamMember[] }) {
  const memberColorMap = useMemo(() => {
    const map = new Map<string, ReturnType<typeof getMemberColor>>();
    members.forEach((m, i) => map.set(m.name, getMemberColor(i)));
    return map;
  }, [members]);

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

      {timeline.map((event, i) => (
        <TimelineItem key={i} event={event} memberColorMap={memberColorMap} />
      ))}
    </div>
  );
}

function TimelineItem({ event, memberColorMap }: { event: TeamEvent; memberColorMap: Map<string, ReturnType<typeof getMemberColor>> }) {
  const [expanded, setExpanded] = useState(false);

  const getIcon = () => {
    switch (event.kind) {
      case 'spawn': return UserPlus;
      case 'cleanup': return XCircle;
      case 'message': return Send;
      case 'task': return ListChecks;
      default: return Circle;
    }
  };

  const getColor = () => {
    switch (event.kind) {
      case 'spawn': return '#8b5cf6';
      case 'cleanup': return '#f87171';
      case 'message': return '#3b82f6';
      case 'task': return '#a5b4fc';
      default: return 'var(--color-text-tertiary)';
    }
  };

  const Icon = getIcon();
  const color = getColor();

  const renderContent = () => {
    switch (event.kind) {
      case 'spawn': {
        const m = event.data as TeamMember;
        return (
          <div>
            <span style={{ fontWeight: 500 }}>Team spawned</span>
            {m.name && <span style={{ marginLeft: 6, fontFamily: 'var(--font-mono)', color: '#8b5cf6' }}>{m.name}</span>}
            {m.type && <span className="badge badge-default" style={{ fontSize: 9, marginLeft: 6 }}>{m.type}</span>}
          </div>
        );
      }
      case 'cleanup':
        return <span style={{ color: 'var(--color-status-red)' }}>Team cleanup</span>;
      case 'message': {
        const m = event.data as TeamMessage;
        return (
          <div>
            <span style={{
              fontSize: 9,
              padding: '0 4px',
              borderRadius: 3,
              background: m.type === 'broadcast' ? 'rgba(245,158,11,0.15)' : 'rgba(59,130,246,0.15)',
              color: m.type === 'broadcast' ? '#f59e0b' : '#3b82f6',
              border: `1px solid ${m.type === 'broadcast' ? 'rgba(245,158,11,0.3)' : 'rgba(59,130,246,0.3)'}`,
            }}>
              {m.type.toUpperCase()}
            </span>
            {m.recipient && (
              <span style={{ marginLeft: 6, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {'\u2192'} {m.recipient}
              </span>
            )}
            {m.summary && (
              <span style={{ marginLeft: 6, color: 'var(--color-text-secondary)', fontSize: 11 }}>
                {m.summary}
              </span>
            )}
            {expanded && m.content && (
              <div style={{
                marginTop: 6,
                padding: '6px 8px',
                borderRadius: 4,
                background: 'var(--color-bg-base)',
                fontSize: 11,
                color: 'var(--color-text-tertiary)',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                maxHeight: 200,
                overflow: 'auto',
              }} className="scrollbar-thin">
                {m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content}
              </div>
            )}
          </div>
        );
      }
      case 'task': {
        const t = event.data as TeamTaskEvent;
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 9,
              padding: '0 4px',
              borderRadius: 3,
              background: t.tool === 'TaskCreate' ? 'rgba(16,185,129,0.15)' : 'rgba(99,102,241,0.15)',
              color: t.tool === 'TaskCreate' ? '#10b981' : '#6366f1',
              border: `1px solid ${t.tool === 'TaskCreate' ? 'rgba(16,185,129,0.3)' : 'rgba(99,102,241,0.3)'}`,
            }}>
              {t.tool === 'TaskCreate' ? 'CREATE' : t.tool === 'TaskUpdate' ? 'UPDATE' : t.tool === 'TaskGet' ? 'GET' : 'LIST'}
            </span>
            {t.taskId && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                #{t.taskId}
              </span>
            )}
            {t.status && (
              <span className={`badge ${t.status === 'completed' ? 'badge-green' : t.status === 'in_progress' ? 'badge-blue' : 'badge-default'}`} style={{ fontSize: 9 }}>
                {t.status}
              </span>
            )}
            {t.owner && (
              <span className="badge badge-default" style={{ fontSize: 9 }}>{t.owner}</span>
            )}
            {t.subject && (
              <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {t.subject.length > 80 ? t.subject.slice(0, 80) + '...' : t.subject}
              </span>
            )}
          </div>
        );
      }
      default:
        return null;
    }
  };

  const hasExpandable = event.kind === 'message' && (event.data as TeamMessage).content;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '6px 0',
        position: 'relative',
        cursor: hasExpandable ? 'pointer' : undefined,
      }}
      onClick={hasExpandable ? () => setExpanded(!expanded) : undefined}
    >
      {/* Node */}
      <div style={{
        width: 32,
        height: 32,
        borderRadius: '50%',
        background: 'var(--color-bg-surface)',
        border: `2px solid ${color}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        zIndex: 1,
      }}>
        <Icon size={14} style={{ color }} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0, paddingTop: 4 }}>
        <div style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
          {hasExpandable && (
            expanded ? <ChevronDown size={10} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                     : <ChevronRight size={10} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
          )}
          {renderContent()}
        </div>
      </div>

      {/* Turn index */}
      {event.turnIndex !== undefined && (
        <span style={{
          fontSize: 9,
          color: 'var(--color-text-tertiary)',
          fontFamily: 'var(--font-mono)',
          flexShrink: 0,
          paddingTop: 8,
        }}>
          T{event.turnIndex}
        </span>
      )}
    </div>
  );
}

// ============================================
// Messages View
// ============================================

function MessagesView({ messages, members }: { messages: TeamMessage[]; members: TeamMember[] }) {
  if (messages.length === 0) {
    return (
      <div className="empty-state" style={{ padding: 32 }}>
        <MessageSquare size={24} className="empty-state-icon" />
        <span style={{ fontSize: 12 }}>No team messages</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {messages.map((msg, i) => (
        <div key={i} style={{
          padding: '8px 12px',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--color-border-default)',
          background: 'var(--color-bg-surface)',
        }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{
              fontSize: 9,
              padding: '0 4px',
              borderRadius: 3,
              background: msg.type === 'broadcast' ? 'rgba(245,158,11,0.15)' : 'rgba(59,130,246,0.15)',
              color: msg.type === 'broadcast' ? '#f59e0b' : '#3b82f6',
              border: `1px solid ${msg.type === 'broadcast' ? 'rgba(245,158,11,0.3)' : 'rgba(59,130,246,0.3)'}`,
            }}>
              {msg.type.toUpperCase()}
            </span>
            {msg.recipient && (
              <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                {'\u2192'} {msg.recipient}
              </span>
            )}
            {msg.turnIndex !== undefined && (
              <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', marginLeft: 'auto' }}>
                T{msg.turnIndex}
              </span>
            )}
          </div>

          {/* Summary */}
          {msg.summary && (
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-primary)', marginBottom: 2 }}>
              {msg.summary}
            </div>
          )}

          {/* Content */}
          {msg.content && (
            <div style={{
              fontSize: 11,
              color: 'var(--color-text-tertiary)',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              maxHeight: 150,
              overflow: 'auto',
            }} className="scrollbar-thin">
              {msg.content.length > 500 ? msg.content.slice(0, 500) + '...' : msg.content}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ============================================
// Task Events View
// ============================================

function TaskEventsView({ events }: { events: TeamTaskEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="empty-state" style={{ padding: 32 }}>
        <ListChecks size={24} className="empty-state-icon" />
        <span style={{ fontSize: 12 }}>No task operations</span>
      </div>
    );
  }

  // Build task state by replaying events
  const taskStates = useMemo(() => {
    const states = new Map<string, { id: string; subject: string; status: string; owner?: string; description?: string }>();
    for (const evt of events) {
      if (evt.tool === 'TaskCreate' && evt.subject) {
        const id = evt.taskId || String(states.size + 1);
        states.set(id, {
          id,
          subject: evt.subject,
          status: 'pending',
          owner: evt.owner,
          description: evt.description,
        });
      }
      if (evt.tool === 'TaskUpdate' && evt.taskId) {
        const existing = states.get(evt.taskId);
        if (existing) {
          if (evt.status) existing.status = evt.status;
          if (evt.owner) existing.owner = evt.owner;
          if (evt.subject) existing.subject = evt.subject;
        }
      }
    }
    return Array.from(states.values());
  }, [events]);

  const STATUS_CONFIG: Record<string, { icon: typeof Circle; color: string; bgClass: string }> = {
    pending: { icon: Circle, color: 'var(--color-status-yellow)', bgClass: 'badge-yellow' },
    in_progress: { icon: Loader2, color: 'var(--color-status-blue)', bgClass: 'badge-blue' },
    completed: { icon: CheckCircle2, color: 'var(--color-status-green)', bgClass: 'badge-green' },
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Current task state summary */}
      {taskStates.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 8, textTransform: 'uppercase' }}>
            Task Summary
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {taskStates.map(task => {
              const cfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;
              const StatusIcon = cfg.icon;
              return (
                <div key={task.id} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--color-border-default)',
                  background: 'var(--color-bg-surface)',
                  borderLeft: `3px solid ${cfg.color}`,
                }}>
                  <StatusIcon size={12} style={{ color: cfg.color, flexShrink: 0 }} />
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                    #{task.id}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--color-text-primary)', flex: 1 }}>
                    {task.subject}
                  </span>
                  <span className={`badge ${cfg.bgClass}`} style={{ fontSize: 9 }}>
                    {task.status}
                  </span>
                  {task.owner && (
                    <span className="badge badge-default" style={{ fontSize: 9 }}>{task.owner}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Event log */}
      <div>
        <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 8, textTransform: 'uppercase' }}>
          Event Log ({events.length})
        </h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {events.map((evt, i) => (
            <div key={i} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 8px',
              fontSize: 11,
              borderRadius: 'var(--radius-sm)',
              background: i % 2 === 0 ? 'transparent' : 'var(--color-bg-hover)',
            }}>
              <span style={{
                fontSize: 9,
                padding: '0 4px',
                borderRadius: 3,
                background: evt.tool === 'TaskCreate' ? 'rgba(16,185,129,0.15)'
                  : evt.tool === 'TaskUpdate' ? 'rgba(99,102,241,0.15)'
                  : 'rgba(107,114,128,0.15)',
                color: evt.tool === 'TaskCreate' ? '#10b981'
                  : evt.tool === 'TaskUpdate' ? '#6366f1'
                  : '#6b7280',
                border: `1px solid ${evt.tool === 'TaskCreate' ? 'rgba(16,185,129,0.3)'
                  : evt.tool === 'TaskUpdate' ? 'rgba(99,102,241,0.3)'
                  : 'rgba(107,114,128,0.3)'}`,
                flexShrink: 0,
              }}>
                {evt.tool.replace('Task', '')}
              </span>
              {evt.taskId && (
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)', fontSize: 10 }}>
                  #{evt.taskId}
                </span>
              )}
              {evt.status && (
                <span className={`badge ${evt.status === 'completed' ? 'badge-green' : evt.status === 'in_progress' ? 'badge-blue' : 'badge-default'}`} style={{ fontSize: 9 }}>
                  {evt.status}
                </span>
              )}
              {evt.owner && (
                <span className="badge badge-default" style={{ fontSize: 9 }}>{evt.owner}</span>
              )}
              {evt.subject && (
                <span style={{ color: 'var(--color-text-secondary)', flex: 1 }} className="truncate">
                  {evt.subject}
                </span>
              )}
              {evt.turnIndex !== undefined && (
                <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                  T{evt.turnIndex}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================
// Members View
// ============================================

function MembersView({ members }: { members: TeamMember[] }) {
  if (members.length === 0) {
    return (
      <div className="empty-state" style={{ padding: 32 }}>
        <Users size={24} className="empty-state-icon" />
        <span style={{ fontSize: 12 }}>No team members detected</span>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          Members are detected from Task tool calls with team_name
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {members.map((member, i) => {
        const color = getMemberColor(i);
        return (
          <div key={i} style={{
            padding: '10px 12px',
            borderRadius: 'var(--radius-md)',
            border: `1px solid ${color.border}`,
            background: color.bg,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                background: color.bg,
                border: `2px solid ${color.fg}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <Users size={14} style={{ color: color.fg }} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  {member.name || 'Unknown'}
                </div>
                <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', display: 'flex', gap: 6 }}>
                  {member.type && <span>{member.type}</span>}
                  {member.model && <span>{member.model}</span>}
                  {member.joinedTurn !== undefined && <span>joined at T{member.joinedTurn}</span>}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
