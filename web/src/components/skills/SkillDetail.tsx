'use client';

import { useState, useEffect } from 'react';
import { Loader2, Zap, CheckCircle2, XCircle } from 'lucide-react';

interface SkillDetailData {
  skillName: string;
  pluginName: string;
  shortName: string;
  description: string;
  pluginVersion: string;
  totalInvocations: number;
  successCount: number;
  failCount: number;
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
        <Zap size={28} className="empty-state-icon" />
        <span style={{ fontSize: 13 }}>Select a skill to view details</span>
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

  const successRate = detail.totalInvocations > 0
    ? Math.round((detail.successCount / (detail.successCount + detail.failCount)) * 100)
    : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--color-border-default)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text-primary)' }}>
            {detail.shortName}
          </span>
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
            {detail.pluginName}
          </span>
          {detail.pluginVersion && (
            <span className="badge badge-default" style={{ fontSize: 9 }}>v{detail.pluginVersion}</span>
          )}
        </div>
        {detail.description && (
          <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5, margin: 0 }}>
            {detail.description}
          </p>
        )}

        {/* Stats row */}
        <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 12 }}>
          <div>
            <span style={{ color: 'var(--color-text-tertiary)', fontSize: 10 }}>Invocations</span>
            <div style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{detail.totalInvocations}</div>
          </div>
          <div>
            <span style={{ color: 'var(--color-text-tertiary)', fontSize: 10 }}>Success Rate</span>
            <div style={{
              fontWeight: 600,
              fontFamily: 'var(--font-mono)',
              color: successRate >= 80 ? 'var(--color-status-green)' : successRate >= 50 ? 'var(--color-status-yellow)' : 'var(--color-status-red)',
            }}>
              {successRate}%
            </div>
          </div>
          <div>
            <span style={{ color: 'var(--color-text-tertiary)', fontSize: 10 }}>Sessions</span>
            <div style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{detail.totalSessions}</div>
          </div>
          <div>
            <span style={{ color: 'var(--color-text-tertiary)', fontSize: 10 }}>Success</span>
            <div style={{ fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--color-status-green)' }}>
              {detail.successCount}
            </div>
          </div>
          <div>
            <span style={{ color: 'var(--color-text-tertiary)', fontSize: 10 }}>Failed</span>
            <div style={{ fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--color-status-red)' }}>
              {detail.failCount}
            </div>
          </div>
        </div>
      </div>

      {/* Session list */}
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 16px' }} className="scrollbar-thin">
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 8, textTransform: 'uppercase' }}>
          Sessions ({detail.totalSessions})
        </div>

        {detail.sessions.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', padding: 12, textAlign: 'center' }}>
            No sessions recorded
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {detail.sessions.map((sess, i) => (
            <div
              key={`${sess.sessionId}-${i}`}
              className="card"
              style={{
                padding: '8px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
              }}
            >
              {/* Success/fail indicator */}
              {sess.success === true && <CheckCircle2 size={12} style={{ color: 'var(--color-status-green)', flexShrink: 0 }} />}
              {sess.success === false && <XCircle size={12} style={{ color: 'var(--color-status-red)', flexShrink: 0 }} />}
              {sess.success === undefined && <div style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--color-border-default)', flexShrink: 0 }} />}

              {/* Timestamp */}
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                {formatDate(sess.timestamp)}
              </span>

              {/* Project */}
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text-secondary)' }}>
                {projectBasename(sess.project)}
              </span>

              {/* Tool count */}
              <span className="badge badge-default" style={{ fontSize: 9, flexShrink: 0 }}>
                {sess.toolUseCount} tools
              </span>

              {/* Subagent count */}
              {sess.subagentCount > 0 && (
                <span className="badge badge-default" style={{ fontSize: 9, flexShrink: 0 }}>
                  {sess.subagentCount} agents
                </span>
              )}

              {/* Subagent session indicator */}
              {sess.isSubagentSession && (
                <span className="badge" style={{ fontSize: 9, background: 'rgba(139,92,246,0.15)', color: '#8b5cf6', border: '1px solid rgba(139,92,246,0.3)' }}>
                  sub
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
