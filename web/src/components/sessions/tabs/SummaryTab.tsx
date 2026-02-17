'use client';

import { useState, useEffect } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import { Sparkles, Code2, CheckCircle2, MessageSquare, ChevronDown, ChevronUp } from 'lucide-react';
import type { IndexedSessionResult } from '@/lib/types';

interface SummaryTabProps {
  sessionId: string;
  machineId?: string;
}

export function SummaryTab({ sessionId, machineId }: SummaryTabProps) {
  const { apiClient } = useAppMode();
  const [data, setData] = useState<IndexedSessionResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showAllPrompts, setShowAllPrompts] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setIsLoading(true);
      try {
        const result = await apiClient.getIndexedSession(sessionId, machineId);
        if (!cancelled) setData(result);
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [sessionId, machineId, apiClient]);

  if (isLoading) {
    return (
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="skeleton" style={{ height: 60 }} />
        <div className="skeleton" style={{ height: 40 }} />
        <div className="skeleton" style={{ height: 40 }} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <Sparkles size={28} className="empty-state-icon" />
        <span style={{ fontSize: 13 }}>Session not indexed yet</span>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          Run reindex to generate AI summaries
        </span>
      </div>
    );
  }

  const visiblePrompts = showAllPrompts
    ? (data.userPrompts || [])
    : (data.userPrompts || []).slice(0, 5);
  const hasMorePrompts = (data.userPrompts?.length || 0) > 5;

  return (
    <div style={{ padding: 16, overflowY: 'auto', height: '100%' }} className="scrollbar-thin">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* AI Summary */}
        {data.summary && (
          <div style={{
            padding: 12,
            background: 'rgba(167,139,250,0.08)',
            border: '1px solid rgba(167,139,250,0.2)',
            borderRadius: 'var(--radius-md)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 12, fontWeight: 600 }}>
              <Sparkles size={14} style={{ color: 'var(--color-status-purple)' }} />
              AI Summary
            </div>
            <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--color-text-secondary)' }}>
              {data.summary}
            </p>
          </div>
        )}

        {/* Topics */}
        {data.topics && data.topics.length > 0 && (
          <div>
            <h4 style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--color-text-tertiary)' }}>Topics</h4>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {data.topics.map(topic => (
                <span key={topic} className="badge badge-default">{topic}</span>
              ))}
            </div>
          </div>
        )}

        {/* Technologies */}
        {data.technologies && data.technologies.length > 0 && (
          <div>
            <h4 style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--color-text-tertiary)' }}>
              <Code2 size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
              Technologies
            </h4>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {data.technologies.map(tech => (
                <span key={tech} className="badge badge-outline" style={{ gap: 3 }}>
                  <Code2 size={10} />
                  {tech}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Actions Taken */}
        {data.actionsTaken && data.actionsTaken.length > 0 && (
          <div>
            <h4 style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--color-text-tertiary)' }}>Actions Taken</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {data.actionsTaken.map((action, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 12 }}>
                  <CheckCircle2 size={13} style={{ color: 'var(--color-status-green)', marginTop: 1, flexShrink: 0 }} />
                  <span style={{ color: 'var(--color-text-secondary)' }}>{action}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* User Prompts */}
        {data.userPrompts && data.userPrompts.length > 0 && (
          <div>
            <h4 style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--color-text-tertiary)' }}>
              User Prompts ({data.userPrompts.length})
            </h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {visiblePrompts.map((prompt, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 12 }}>
                  <MessageSquare size={12} style={{ color: 'var(--color-status-blue)', marginTop: 1, flexShrink: 0 }} />
                  <span style={{ color: 'var(--color-text-secondary)' }}>
                    {prompt.length > 200 ? prompt.slice(0, 200) + '...' : prompt}
                  </span>
                </div>
              ))}
              {hasMorePrompts && (
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ alignSelf: 'flex-start', marginLeft: 18, fontSize: 11, gap: 4 }}
                  onClick={() => setShowAllPrompts(prev => !prev)}
                >
                  {showAllPrompts ? (
                    <>
                      <ChevronUp size={10} />
                      Show less
                    </>
                  ) : (
                    <>
                      <ChevronDown size={10} />
                      Show {data.userPrompts!.length - 5} more
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Index Metadata */}
        <div>
          <h4 style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--color-text-tertiary)' }}>Index Metadata</h4>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '8px',
            fontSize: 12,
          }}>
            {data.indexedAt && (
              <MetaCard label="Indexed" value={new Date(data.indexedAt).toLocaleString()} />
            )}
            {data.status && <MetaCard label="Status" value={data.status} />}
            {data.turns !== undefined && <MetaCard label="Turns" value={String(data.turns)} />}
            {data.totalCost !== undefined && <MetaCard label="Cost" value={`$${data.totalCost.toFixed(4)}`} />}
            {data.model && <MetaCard label="Model" value={data.model} />}
            {data.duration !== undefined && <MetaCard label="Duration" value={formatDuration(data.duration)} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function MetaCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      padding: '6px 10px',
      background: 'var(--color-bg-elevated)',
      border: '1px solid var(--color-border-subtle)',
      borderRadius: 'var(--radius-sm)',
    }}>
      <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', wordBreak: 'break-all' }}>{value}</div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
