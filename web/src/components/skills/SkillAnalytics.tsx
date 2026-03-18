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

// Gradient bar colors for the top skills chart
const BAR_COLORS = [
  'var(--color-accent)',
  'var(--color-status-blue)',
  'var(--color-status-green)',
  'var(--color-status-purple)',
  'var(--color-status-cyan)',
  'var(--color-status-orange)',
  'var(--color-status-pink)',
  'var(--color-accent-dim)',
  'var(--color-status-blue)',
  'var(--color-status-green)',
];

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
        <BarChart3 size={32} style={{ color: 'var(--color-text-tertiary)', opacity: 0.5 }} />
        <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)', marginTop: 8 }}>
          No analytics data
        </span>
      </div>
    );
  }

  const maxInvocations = analytics.top10.length > 0
    ? Math.max(...analytics.top10.map(s => s.totalInvocations))
    : 1;

  const successRatePct = Math.round(analytics.overall.successRate * 100);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }} className="scrollbar-thin">
      {/* Overview section */}
      <div style={{
        padding: '14px 16px 12px',
        borderBottom: '1px solid var(--color-border-default)',
      }}>
        <div style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--color-text-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: 10,
        }}>
          Overview
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div className="stat-card amber">
            <div className="stat-label">Total Skills</div>
            <div className="stat-value">{analytics.overall.totalSkills}</div>
          </div>
          <div className="stat-card blue">
            <div className="stat-label">Invocations</div>
            <div className="stat-value">{analytics.overall.totalInvocations}</div>
          </div>
          <div className="stat-card green">
            <div className="stat-label">Success Rate</div>
            <div className="stat-value" style={{
              color: successRatePct >= 80 ? 'var(--color-status-green)' : successRatePct >= 50 ? 'var(--color-accent)' : 'var(--color-status-red)',
            }}>
              {successRatePct}%
            </div>
          </div>
          <div className="stat-card red">
            <div className="stat-label">Failed</div>
            <div className="stat-value" style={{ color: 'var(--color-status-red)' }}>
              {analytics.overall.failCount}
            </div>
          </div>
        </div>
      </div>

      {/* Top Skills section */}
      <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--color-border-default)' }}>
        <div style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--color-text-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: 10,
        }}>
          Top Skills
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {analytics.top10.map((skill, idx) => {
            const pct = (skill.totalInvocations / maxInvocations) * 100;
            const barColor = BAR_COLORS[idx % BAR_COLORS.length];
            return (
              <div key={skill.skillName} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 11,
              }}>
                <span style={{
                  width: 80,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: 'var(--color-text-primary)',
                  flexShrink: 0,
                  fontSize: 11,
                }}>
                  {skill.shortName}
                </span>
                <div style={{
                  flex: 1,
                  height: 16,
                  background: 'var(--color-bg-root)',
                  borderRadius: 'var(--radius-sm)',
                  overflow: 'hidden',
                  position: 'relative',
                }}>
                  <div style={{
                    height: '100%',
                    width: `${pct}%`,
                    background: `linear-gradient(90deg, ${barColor}, ${barColor}88)`,
                    borderRadius: 'var(--radius-sm)',
                    minWidth: 3,
                    transition: 'width 0.3s ease',
                  }} />
                </div>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--color-text-tertiary)',
                  fontSize: 10,
                  flexShrink: 0,
                  width: 30,
                  textAlign: 'right',
                }}>
                  {skill.totalInvocations}
                </span>
              </div>
            );
          })}

          {analytics.top10.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', textAlign: 'center', padding: 12 }}>
              No skill usage data
            </div>
          )}
        </div>
      </div>

      {/* Common Chains section */}
      {chains && chains.chains.length > 0 && (
        <div style={{ padding: '14px 16px' }}>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--color-text-tertiary)',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            marginBottom: 10,
          }}>
            Common Chains
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {chains.chains.slice(0, 10).map((chain, i) => (
              <div key={i} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 0,
                flexWrap: 'wrap',
                padding: '6px 0',
              }}>
                {chain.sequence.map((name, j) => (
                  <span key={j} style={{ display: 'inline-flex', alignItems: 'center' }}>
                    {j > 0 && (
                      <span style={{
                        fontSize: 10,
                        color: 'var(--color-text-tertiary)',
                        margin: '0 4px',
                        fontFamily: 'var(--font-mono)',
                      }}>
                        {'\u2192'}
                      </span>
                    )}
                    <span className="badge badge-default" style={{
                      fontSize: 10,
                      padding: '2px 8px',
                      borderRadius: '99px',
                    }}>
                      {name}
                    </span>
                  </span>
                ))}
                <span className="badge badge-amber" style={{
                  fontSize: 9,
                  padding: '1px 6px',
                  marginLeft: 8,
                  fontFamily: 'var(--font-mono)',
                }}>
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
