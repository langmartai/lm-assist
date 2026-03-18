'use client';

import { useState, useEffect } from 'react';
import { Loader2, Zap, ChevronLeft, ChevronRight } from 'lucide-react';

interface SkillDetailData {
  skillName: string;
  pluginName: string;
  shortName: string;
  description: string;
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
  }>;
  totalSessions: number;
}

interface SkillDetailProps {
  apiFetch: <T>(path: string) => Promise<T>;
  skillName: string | null;
}

const PAGE_SIZE = 20;

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function projectBasename(project: string): string {
  if (!project) return '';
  const parts = project.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || project;
}

export function SkillDetail({ apiFetch, skillName }: SkillDetailProps) {
  const [detail, setDetail] = useState<SkillDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  // Reset page when skill changes
  useEffect(() => { setPage(0); }, [skillName]);

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

  // Pagination
  const totalPages = Math.ceil(detail.sessions.length / PAGE_SIZE);
  const pagedSessions = detail.sessions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '16px 20px 12px',
        borderBottom: '1px solid var(--color-border-default)',
      }}>
        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>
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

        {/* Description */}
        {detail.description && (
          <div style={{
            padding: '8px 12px',
            background: 'var(--color-bg-elevated)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-border-subtle)',
            marginBottom: 12,
          }}>
            <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6, margin: 0 }}>
              {detail.description}
            </p>
          </div>
        )}

        {/* Stats row: 4 stat-cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          <div className="stat-card amber">
            <div className="stat-label">Invocations</div>
            <div className="stat-value">{detail.totalInvocations}</div>
          </div>
          <div className="stat-card blue">
            <div className="stat-label">Sessions</div>
            <div className="stat-value">{detail.totalSessions}</div>
          </div>
          <div className="stat-card green">
            <div className="stat-label">Success Rate</div>
            <div className="stat-value" style={{
              color: successRate >= 80 ? 'var(--color-status-green)' : successRate >= 50 ? 'var(--color-accent)' : 'var(--color-status-red)',
            }}>
              {successRate}%
            </div>
          </div>
          <div className="stat-card purple">
            <div className="stat-label">Direct</div>
            <div className="stat-value">{directCount}</div>
          </div>
        </div>
      </div>

      {/* Session list */}
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px' }} className="scrollbar-thin">
        <div style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--color-text-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: 10,
        }}>
          Sessions ({detail.totalSessions})
        </div>

        {detail.sessions.length === 0 && (
          <div className="empty-state" style={{ padding: 32 }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              No sessions recorded
            </span>
          </div>
        )}

        {/* Session table */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {pagedSessions.map((sess, i) => (
            <div
              key={`${sess.sessionId}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                fontSize: 12,
                background: 'var(--color-bg-surface)',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
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
              {/* Success/fail indicator dot */}
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

              {/* Timestamp */}
              <span style={{
                fontSize: 11,
                color: 'var(--color-text-tertiary)',
                fontFamily: 'var(--font-mono)',
                flexShrink: 0,
                minWidth: 100,
              }}>
                {formatDate(sess.timestamp)}
              </span>

              {/* Project */}
              <span style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: 'var(--color-text-secondary)',
              }}>
                {projectBasename(sess.project)}
              </span>

              {/* Tool count badge */}
              <span className="badge badge-default" style={{ fontSize: 9, padding: '1px 6px', fontFamily: 'var(--font-mono)' }}>
                {sess.toolUseCount} tools
              </span>

              {/* Agent count badge */}
              {sess.subagentCount > 0 && (
                <span className="badge badge-purple" style={{ fontSize: 9, padding: '1px 6px', fontFamily: 'var(--font-mono)' }}>
                  {sess.subagentCount} agents
                </span>
              )}

              {/* Subagent session indicator */}
              {sess.isSubagentSession && (
                <span className="badge badge-purple" style={{ fontSize: 9, padding: '1px 6px' }}>
                  sub
                </span>
              )}
            </div>
          ))}
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
    </div>
  );
}
