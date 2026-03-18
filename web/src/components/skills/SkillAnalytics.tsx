'use client';

import { useState, useEffect } from 'react';
import { Loader2, BarChart3 } from 'lucide-react';

interface AnalyticsData {
  top10: Array<{
    skillName: string;
    shortName: string;
    totalInvocations: number;
    successCount: number;
    failCount: number;
  }>;
  byPlugin: Array<{
    pluginName: string;
    totalInvocations: number;
    skillCount: number;
    successCount: number;
    failCount: number;
  }>;
  overall: {
    totalSkills: number;
    totalInvocations: number;
    successCount: number;
    failCount: number;
    successRate: number;
  };
}

interface ChainData {
  chains: Array<{
    sequence: string[];
    occurrences: number;
    projects: string[];
  }>;
}

interface SkillAnalyticsProps {
  apiFetch: <T>(path: string) => Promise<T>;
}

export function SkillAnalytics({ apiFetch }: SkillAnalyticsProps) {
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [chains, setChains] = useState<ChainData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.all([
      apiFetch<AnalyticsData>('/skills/analytics').catch(() => null),
      apiFetch<ChainData>('/skills/analytics/chains').catch(() => null),
    ]).then(([analyticsData, chainsData]) => {
      if (!cancelled) {
        setAnalytics(analyticsData);
        setChains(chainsData);
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [apiFetch]);

  if (loading) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
        <span style={{ fontSize: 12 }}>Loading analytics...</span>
      </div>
    );
  }

  if (!analytics) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <BarChart3 size={28} className="empty-state-icon" />
        <span style={{ fontSize: 13 }}>No analytics data</span>
      </div>
    );
  }

  const maxInvocations = analytics.top10.length > 0
    ? Math.max(...analytics.top10.map(s => s.totalInvocations))
    : 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }} className="scrollbar-thin">
      {/* Overall stats */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--color-border-default)',
      }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 8, textTransform: 'uppercase' }}>
          Overview
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div className="card" style={{ padding: '8px 10px' }}>
            <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>Total Skills</div>
            <div style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{analytics.overall.totalSkills}</div>
          </div>
          <div className="card" style={{ padding: '8px 10px' }}>
            <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>Invocations</div>
            <div style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{analytics.overall.totalInvocations}</div>
          </div>
          <div className="card" style={{ padding: '8px 10px' }}>
            <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>Success Rate</div>
            <div style={{
              fontSize: 16,
              fontWeight: 600,
              fontFamily: 'var(--font-mono)',
              color: analytics.overall.successRate >= 0.8 ? 'var(--color-status-green)' : analytics.overall.successRate >= 0.5 ? 'var(--color-status-yellow)' : 'var(--color-status-red)',
            }}>
              {Math.round(analytics.overall.successRate * 100)}%
            </div>
          </div>
          <div className="card" style={{ padding: '8px 10px' }}>
            <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>Failed</div>
            <div style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--color-status-red)' }}>
              {analytics.overall.failCount}
            </div>
          </div>
        </div>
      </div>

      {/* Top 10 skills */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border-default)' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 8, textTransform: 'uppercase' }}>
          Top Skills
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {analytics.top10.map(skill => (
            <div key={skill.skillName} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
              <span style={{
                width: 80,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: 'var(--color-text-primary)',
                flexShrink: 0,
              }}>
                {skill.shortName}
              </span>
              <div style={{
                flex: 1,
                height: 14,
                background: 'var(--color-bg-surface)',
                borderRadius: 'var(--radius-sm)',
                overflow: 'hidden',
                position: 'relative',
              }}>
                <div style={{
                  height: '100%',
                  width: `${(skill.totalInvocations / maxInvocations) * 100}%`,
                  background: 'var(--color-accent)',
                  borderRadius: 'var(--radius-sm)',
                  opacity: 0.6,
                  minWidth: 2,
                }} />
              </div>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)', fontSize: 10, flexShrink: 0, width: 28, textAlign: 'right' }}>
                {skill.totalInvocations}
              </span>
            </div>
          ))}

          {analytics.top10.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', textAlign: 'center', padding: 8 }}>
              No skill usage data
            </div>
          )}
        </div>
      </div>

      {/* Chains */}
      {chains && chains.chains.length > 0 && (
        <div style={{ padding: '12px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 8, textTransform: 'uppercase' }}>
            Common Chains
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {chains.chains.slice(0, 10).map((chain, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                {chain.sequence.map((name, j) => (
                  <span key={j} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {j > 0 && (
                      <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                        {'\u2192'}
                      </span>
                    )}
                    <span className="badge badge-default" style={{
                      fontSize: 10,
                      padding: '1px 6px',
                    }}>
                      {name}
                    </span>
                  </span>
                ))}
                <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', marginLeft: 4 }}>
                  x{chain.occurrences}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
