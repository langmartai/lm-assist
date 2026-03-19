'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Zap, ChevronLeft, ChevronRight, Clock, User, Cpu, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { formatTimeAgo, getSessionIdShort, formatCost, getModelShortName, formatBytes } from '@/lib/utils';

interface SkillDetailData {
  skillName: string;
  pluginName: string;
  shortName: string;
  description: string;
  fullDescription?: string;
  pluginVersion: string;
  totalInvocations: number;
  successCount: number;
  failCount: number;
  directInvocations?: number;
  lastUsed: string;
  firstUsed: string;
  sessions: Array<{
    sessionId: string;
    project: string;
    timestamp: string;
    success?: boolean;
    toolUseCount: number;
    subagentCount: number;
    isSubagentSession: boolean;
    lastMessage?: string;
    model?: string;
    totalCostUsd?: number;
    numTurns?: number;
    userPromptCount?: number;
    agentCount?: number;
    size?: number;
    subagents?: Array<{
      agentId: string;
      type: string;
      description?: string;
      status: string;
      totalCostUsd?: number;
      lastMessage?: string;
    }>;
  }>;
  totalSessions: number;
}

interface SkillDetailProps {
  apiFetch: <T>(path: string) => Promise<T>;
  skillName: string | null;
}

type TabId = 'sessions' | 'timeline';

const PAGE_SIZE = 20;

function projectBasename(project: string): string {
  if (!project) return '';
  const parts = project.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || project;
}

/** Group sessions by date for the Usage Timeline tab */
function groupByDate(sessions: SkillDetailData['sessions']): Array<{ date: string; label: string; items: SkillDetailData['sessions'] }> {
  const groups = new Map<string, SkillDetailData['sessions']>();
  for (const sess of sessions) {
    const d = new Date(sess.timestamp);
    const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(sess);
  }
  // Sort descending by date key
  const sorted = Array.from(groups.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  return sorted.map(([key, items]) => {
    const d = new Date(key + 'T00:00:00');
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
    return { date: key, label, items };
  });
}

export function SkillDetail({ apiFetch, skillName }: SkillDetailProps) {
  const router = useRouter();
  const [detail, setDetail] = useState<SkillDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [activeTab, setActiveTab] = useState<TabId>('sessions');
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());

  // Reset page and tab when skill changes
  useEffect(() => { setPage(0); setActiveTab('sessions'); }, [skillName]);

  useEffect(() => {
    if (!skillName) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<SkillDetailData>(`/skills/detail/${encodeURIComponent(skillName)}`)
      .then(data => {
        if (!cancelled) setDetail(data);
      })
      .catch(err => {
        if (!cancelled) setError(err?.message || 'Failed to load skill detail');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [apiFetch, skillName]);

  // Memoize grouped timeline data
  const timelineGroups = useMemo(() => {
    if (!detail) return [];
    return groupByDate(detail.sessions);
  }, [detail]);

  if (!skillName) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <Zap size={32} style={{ color: 'var(--color-text-tertiary)', opacity: 0.5 }} />
        <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)', marginTop: 8 }}>
          Select a skill to view details
        </span>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
        <span style={{ fontSize: 12 }}>Loading skill detail...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <span style={{ fontSize: 13, color: 'var(--color-status-red)' }}>{error}</span>
      </div>
    );
  }

  if (!detail) return null;

  const denominator = detail.successCount + detail.failCount;
  const successRate = denominator > 0
    ? Math.round((detail.successCount / denominator) * 100)
    : 0;
  const directCount = detail.directInvocations ?? detail.totalInvocations;
  const displayDescription = detail.fullDescription || detail.description;

  // Pagination (sessions tab only)
  const totalPages = Math.ceil(detail.sessions.length / PAGE_SIZE);
  const pagedSessions = detail.sessions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header section (sticky) */}
      <div style={{
        padding: '16px 20px 0',
        flexShrink: 0,
      }}>
        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)' }}>
            {detail.shortName}
          </span>
          <span className="badge badge-default" style={{ fontSize: 10 }}>
            {detail.pluginName}
          </span>
          {detail.pluginVersion && (
            <span className="badge badge-default" style={{ fontSize: 10, fontFamily: 'var(--font-mono)' }}>
              v{detail.pluginVersion}
            </span>
          )}
        </div>

        {/* Full description card */}
        {displayDescription && (
          <div style={{
            padding: '12px 16px',
            background: 'var(--color-bg-elevated)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-border-subtle)',
            marginBottom: 14,
          }}>
            <p style={{
              fontSize: 13,
              color: 'var(--color-text-secondary)',
              lineHeight: 1.6,
              margin: 0,
              whiteSpace: 'pre-wrap',
            }}>
              {displayDescription}
            </p>
          </div>
        )}

        {/* Compact stats bar */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          padding: '8px 0 12px',
          fontSize: 12,
          color: 'var(--color-text-tertiary)',
          flexWrap: 'wrap',
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 13, color: 'var(--color-accent)' }}>
              {detail.totalInvocations}
            </span>
            <span style={{ fontSize: 11 }}>invocations</span>
          </span>
          <span style={{ margin: '0 10px', opacity: 0.3 }}>&middot;</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 13, color: 'var(--color-text-primary)' }}>
              {detail.totalSessions}
            </span>
            <span style={{ fontSize: 11 }}>sessions</span>
          </span>
          <span style={{ margin: '0 10px', opacity: 0.3 }}>&middot;</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontWeight: 600,
              fontSize: 13,
              color: successRate >= 80 ? 'var(--color-status-green)' : successRate >= 50 ? 'var(--color-accent)' : 'var(--color-status-red)',
            }}>
              {successRate}%
            </span>
            <span style={{ fontSize: 11 }}>success</span>
          </span>
          <span style={{ margin: '0 10px', opacity: 0.3 }}>&middot;</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 13, color: 'var(--color-text-primary)' }}>
              {directCount}
            </span>
            <span style={{ fontSize: 11 }}>direct</span>
          </span>
        </div>

        {/* Tab bar */}
        <div className="tab-bar" style={{ padding: '0', margin: '0 -20px', paddingLeft: 20, paddingRight: 20 }}>
          <button
            className={`tab-item${activeTab === 'sessions' ? ' active' : ''}`}
            onClick={() => { setActiveTab('sessions'); setPage(0); }}
          >
            Sessions
            <span className="tab-badge">{detail.totalSessions}</span>
          </button>
          <button
            className={`tab-item${activeTab === 'timeline' ? ' active' : ''}`}
            onClick={() => setActiveTab('timeline')}
          >
            Usage Timeline
          </button>
        </div>
      </div>

      {/* Tab content */}
      {activeTab === 'sessions' && (
        <>
          {/* Session list */}
          <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px' }} className="scrollbar-thin">
            {detail.sessions.length === 0 && (
              <div className="empty-state" style={{ padding: 32 }}>
                <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                  No sessions recorded
                </span>
              </div>
            )}

            {/* Session cards */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {pagedSessions.map((sess, i) => {
                const agents = sess.subagents || [];
                const isExpanded = expandedAgents.has(sess.sessionId);
                return (
                  <div key={`${sess.sessionId}-${i}`} style={{ display: 'flex', flexDirection: 'column' }}>
                    <a
                      href={`/sessions?id=${sess.sessionId}`}
                      onClick={(e) => { e.preventDefault(); router.push(`/sessions?id=${sess.sessionId}`); }}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        padding: '10px 12px',
                        background: 'var(--color-bg-surface)',
                        border: '1px solid var(--color-border-subtle)',
                        borderRadius: agents.length > 0 && isExpanded ? 'var(--radius-md) var(--radius-md) 0 0' : 'var(--radius-md)',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                        textDecoration: 'none',
                        color: 'inherit',
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-hover)';
                        (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border-default)';
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-surface)';
                        (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border-subtle)';
                      }}
                    >
                      {/* Top row: dot + project name + size + short ID */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                        <div style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          flexShrink: 0,
                          background: sess.success === true
                            ? 'var(--color-status-green)'
                            : sess.success === false
                              ? 'var(--color-status-red)'
                              : 'var(--color-accent-dim)',
                        }} />
                        {sess.isSubagentSession && (
                          <span className="badge badge-purple" style={{ fontSize: 8, padding: '0 4px' }}>
                            sub
                          </span>
                        )}
                        <span style={{ fontSize: 13, fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {projectBasename(sess.project)}
                        </span>
                        {sess.size !== undefined && sess.size > 0 && (
                          <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                            {formatBytes(sess.size)}
                          </span>
                        )}
                        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                          {getSessionIdShort(sess.sessionId)}
                        </span>
                      </div>

                      {/* Message preview */}
                      {sess.lastMessage && (
                        <div
                          className="line-clamp-2"
                          style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 6, lineHeight: 1.4 }}
                        >
                          {sess.lastMessage}
                        </div>
                      )}

                      {/* Bottom row: time ago, model, cost, turns, user count, agent count */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', gap: 3 }}>
                          <Clock size={10} />
                          {formatTimeAgo(sess.timestamp)}
                        </span>
                        {sess.model && (
                          <span className="badge badge-default" style={{ fontSize: 9, padding: '1px 5px' }}>
                            {getModelShortName(sess.model)}
                          </span>
                        )}
                        {sess.totalCostUsd !== undefined && sess.totalCostUsd > 0 && (
                          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                            {formatCost(sess.totalCostUsd)}
                          </span>
                        )}
                        {sess.numTurns !== undefined && (
                          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                            T:{sess.numTurns}
                          </span>
                        )}
                        {sess.userPromptCount !== undefined && sess.userPromptCount > 0 && (
                          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                            <User size={10} />{sess.userPromptCount}
                          </span>
                        )}
                        {(sess.agentCount !== undefined && sess.agentCount > 0 || sess.subagentCount > 0) && (
                          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                            <Cpu size={10} />{sess.agentCount || sess.subagentCount}
                          </span>
                        )}
                      </div>
                    </a>

                    {/* Subagent toggle + collapsible list */}
                    {agents.length > 0 && (
                      <div style={{
                        borderLeft: '2px solid var(--color-accent)',
                        marginLeft: 12,
                        background: isExpanded ? 'var(--color-bg-hover)' : 'transparent',
                        borderRadius: '0 0 var(--radius-md) 0',
                        transition: 'background 0.15s ease',
                      }}>
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setExpandedAgents(prev => {
                              const next = new Set(prev);
                              if (next.has(sess.sessionId)) {
                                next.delete(sess.sessionId);
                              } else {
                                next.add(sess.sessionId);
                              }
                              return next;
                            });
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '3px 10px',
                            fontSize: 10,
                            color: 'var(--color-text-tertiary)',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            width: '100%',
                            textAlign: 'left',
                          }}
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-text-secondary)'; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-text-tertiary)'; }}
                        >
                          {isExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                          <Cpu size={9} />
                          <span>{agents.length} agent{agents.length !== 1 ? 's' : ''}</span>
                        </button>

                        {isExpanded && agents.map(sa => (
                          <a
                            key={sa.agentId}
                            href={`/sessions?session=${encodeURIComponent(sa.agentId)}&parent=${encodeURIComponent(sess.sessionId)}`}
                            onClick={(e) => { e.preventDefault(); router.push(`/sessions?session=${encodeURIComponent(sa.agentId)}&parent=${encodeURIComponent(sess.sessionId)}`); }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 5,
                              padding: '3px 10px 3px 16px',
                              fontSize: 10,
                              textDecoration: 'none',
                              color: 'inherit',
                              borderTop: '1px solid var(--color-border-subtle)',
                              cursor: 'pointer',
                              transition: 'background 0.1s ease',
                            }}
                            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-elevated)'; }}
                            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                            title={sa.description || sa.agentId}
                          >
                            <Cpu size={9} style={{ flexShrink: 0, color: 'var(--color-text-tertiary)' }} />
                            <span className="badge badge-default" style={{ fontSize: 8, padding: '0 4px', flexShrink: 0 }}>
                              {sa.type || 'agent'}
                            </span>
                            <span className="truncate" style={{ color: 'var(--color-text-tertiary)', flex: 1, minWidth: 0 }}>
                              {sa.description || sa.agentId?.slice(0, 16)}
                            </span>
                            <span style={{
                              flexShrink: 0,
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              background: sa.status === 'completed' ? 'var(--color-status-green)'
                                : sa.status === 'error' ? 'var(--color-status-red)'
                                : 'var(--color-text-tertiary)',
                            }} />
                            <ExternalLink size={8} style={{ flexShrink: 0, opacity: 0.4 }} />
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{
              padding: '8px 20px',
              borderTop: '1px solid var(--color-border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: 11,
              color: 'var(--color-text-tertiary)',
              flexShrink: 0,
            }}>
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 10px',
                  fontSize: 11,
                  border: '1px solid var(--color-border-default)',
                  borderRadius: 'var(--radius-sm)',
                  background: page === 0 ? 'transparent' : 'var(--color-bg-surface)',
                  color: page === 0 ? 'var(--color-text-tertiary)' : 'var(--color-text-secondary)',
                  cursor: page === 0 ? 'default' : 'pointer',
                  opacity: page === 0 ? 0.5 : 1,
                  transition: 'all 0.15s ease',
                }}
              >
                <ChevronLeft size={12} />
                Prev
              </button>

              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {page * PAGE_SIZE + 1}&ndash;{Math.min((page + 1) * PAGE_SIZE, detail.sessions.length)} of {detail.sessions.length}
              </span>

              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 10px',
                  fontSize: 11,
                  border: '1px solid var(--color-border-default)',
                  borderRadius: 'var(--radius-sm)',
                  background: page >= totalPages - 1 ? 'transparent' : 'var(--color-bg-surface)',
                  color: page >= totalPages - 1 ? 'var(--color-text-tertiary)' : 'var(--color-text-secondary)',
                  cursor: page >= totalPages - 1 ? 'default' : 'pointer',
                  opacity: page >= totalPages - 1 ? 0.5 : 1,
                  transition: 'all 0.15s ease',
                }}
              >
                Next
                <ChevronRight size={12} />
              </button>
            </div>
          )}
        </>
      )}

      {activeTab === 'timeline' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px' }} className="scrollbar-thin">
          {timelineGroups.length === 0 && (
            <div className="empty-state" style={{ padding: 32 }}>
              <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                No usage recorded
              </span>
            </div>
          )}

          {timelineGroups.map(group => (
            <div key={group.date} style={{ marginBottom: 16 }}>
              {/* Date header */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 6,
              }}>
                <span style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--color-text-secondary)',
                }}>
                  {group.label}
                </span>
                <span style={{
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--color-text-tertiary)',
                }}>
                  {group.items.length} invocation{group.items.length !== 1 ? 's' : ''}
                </span>
                <div style={{ flex: 1, height: 1, background: 'var(--color-border-subtle)' }} />
              </div>

              {/* Timeline entries */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 4 }}>
                {group.items.map((sess, i) => {
                  const time = new Date(sess.timestamp);
                  const timeStr = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                  return (
                    <a
                      key={`${sess.sessionId}-${i}`}
                      href={`/sessions?id=${sess.sessionId}`}
                      onClick={(e) => { e.preventDefault(); router.push(`/sessions?id=${sess.sessionId}`); }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '4px 8px',
                        borderRadius: 'var(--radius-sm)',
                        textDecoration: 'none',
                        color: 'inherit',
                        transition: 'background 0.1s ease',
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-hover)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                    >
                      {/* Status dot */}
                      <div style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        flexShrink: 0,
                        background: sess.success === true
                          ? 'var(--color-status-green)'
                          : sess.success === false
                            ? 'var(--color-status-red)'
                            : 'var(--color-accent-dim)',
                      }} />
                      {/* Time */}
                      <span style={{
                        fontSize: 11,
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--color-text-tertiary)',
                        flexShrink: 0,
                        width: 40,
                      }}>
                        {timeStr}
                      </span>
                      {/* Project */}
                      <span style={{
                        fontSize: 12,
                        color: 'var(--color-text-secondary)',
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {projectBasename(sess.project)}
                      </span>
                      {/* Tool uses */}
                      {sess.toolUseCount > 0 && (
                        <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
                          {sess.toolUseCount} tools
                        </span>
                      )}
                      {/* Subagent badge */}
                      {sess.isSubagentSession && (
                        <span className="badge badge-purple" style={{ fontSize: 8, padding: '0 4px' }}>
                          sub
                        </span>
                      )}
                    </a>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
