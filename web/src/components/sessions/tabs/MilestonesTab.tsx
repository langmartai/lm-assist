'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import { Flag, ChevronRight, ChevronDown, FileText, Wrench, CheckCircle2, Cpu, Loader2 } from 'lucide-react';
import type { Milestone, MilestoneType } from '@/lib/types';

interface MilestonesTabProps {
  sessionId: string;
  machineId?: string;
  onMilestoneCount?: (count: number) => void;
  highlightMilestoneId?: string;
}

const typeColorMap: Record<MilestoneType, { color: string; bg: string }> = {
  discovery: { color: '#60a5fa', bg: 'rgba(96,165,250,0.1)' },
  implementation: { color: '#4ade80', bg: 'rgba(74,222,128,0.1)' },
  bugfix: { color: '#f87171', bg: 'rgba(248,113,113,0.1)' },
  refactor: { color: '#c084fc', bg: 'rgba(192,132,252,0.1)' },
  decision: { color: '#fbbf24', bg: 'rgba(251,191,36,0.1)' },
  configuration: { color: '#22d3ee', bg: 'rgba(34,211,238,0.1)' },
};

function getTypeStyle(type: MilestoneType | null) {
  if (!type || !typeColorMap[type]) return { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)' };
  return typeColorMap[type];
}

export function MilestonesTab({ sessionId, machineId, onMilestoneCount, highlightMilestoneId }: MilestonesTabProps) {
  const { apiClient } = useAppMode();
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [phase, setPhase] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlightAppliedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setIsLoading(true);
      try {
        const result = await apiClient.getMilestones(sessionId, machineId);
        if (!cancelled) {
          setMilestones(result.milestones);
          setPhase(result.phase);
          onMilestoneCount?.(result.milestones.length);
        }
      } catch {
        if (!cancelled) {
          setMilestones([]);
          setPhase(null);
          onMilestoneCount?.(0);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [sessionId, machineId, apiClient]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-expand + scroll + highlight when navigated via deep-link
  useEffect(() => {
    if (!highlightMilestoneId || milestones.length === 0 || highlightAppliedRef.current) return;
    const found = milestones.find(m => m.id === highlightMilestoneId);
    if (!found) return;

    highlightAppliedRef.current = true;
    setExpandedIds(prev => new Set(prev).add(highlightMilestoneId));
    setHighlightedId(highlightMilestoneId);

    // Scroll into view after DOM update
    requestAnimationFrame(() => {
      const el = document.getElementById(`milestone-${highlightMilestoneId}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    // Remove highlight after 2s
    const timer = setTimeout(() => setHighlightedId(null), 2000);
    return () => clearTimeout(timer);
  }, [highlightMilestoneId, milestones]);

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Stats
  const stats = useMemo(() => {
    const typeCounts: Record<string, number> = {};
    let p1 = 0, p2 = 0;
    for (const m of milestones) {
      if (m.phase === 1) p1++;
      else p2++;
      const t = m.type || 'unknown';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
    return { typeCounts, p1, p2 };
  }, [milestones]);

  if (isLoading) {
    return (
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="skeleton" style={{ height: 40 }} />
        <div className="skeleton" style={{ height: 60 }} />
        <div className="skeleton" style={{ height: 60 }} />
        <div className="skeleton" style={{ height: 60 }} />
      </div>
    );
  }

  if (milestones.length === 0) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <Flag size={28} className="empty-state-icon" />
        <span style={{ fontSize: 13 }}>No milestones for this session</span>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          Milestones are extracted automatically from session activity
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Stats bar */}
      <div style={{
        padding: '6px 12px',
        borderBottom: '1px solid var(--color-border-subtle)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        alignItems: 'center',
        fontSize: 11,
      }}>
        <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)' }}>
          {milestones.length} milestones
        </span>
        {stats.p1 > 0 && (
          <span className="badge" style={{ fontSize: 9, padding: '1px 5px', background: 'rgba(148,163,184,0.15)', color: '#94a3b8', border: '1px solid rgba(148,163,184,0.3)' }}>
            P1: {stats.p1}
          </span>
        )}
        {stats.p2 > 0 && (
          <span className="badge" style={{ fontSize: 9, padding: '1px 5px', background: 'rgba(34,197,94,0.15)', color: '#4ade80', border: '1px solid rgba(34,197,94,0.3)' }}>
            P2: {stats.p2}
          </span>
        )}
        <div style={{ width: 1, height: 14, background: 'var(--color-border-default)', margin: '0 2px' }} />
        {Object.entries(stats.typeCounts).map(([type, count]) => {
          const style = getTypeStyle(type as MilestoneType);
          return (
            <span key={type} className="badge" style={{
              fontSize: 9, padding: '1px 5px',
              background: style.bg, color: style.color,
              border: `1px solid ${style.color}33`,
            }}>
              {type}: {count}
            </span>
          );
        })}
      </div>

      {/* Milestone list */}
      <div className="scrollbar-thin" style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {milestones.map(m => {
            const isExpanded = expandedIds.has(m.id);
            const style = getTypeStyle(m.type);
            const hasTitle = m.phase === 2 && m.title;
            const totalTools = Object.values(m.toolUseSummary).reduce((a, b) => a + b, 0);

            const isHighlighted = highlightedId === m.id;

            return (
              <div
                key={m.id}
                id={`milestone-${m.id}`}
                onClick={() => toggleExpand(m.id)}
                style={{
                  borderLeft: `3px solid ${style.color}`,
                  background: isExpanded ? style.bg : 'var(--color-bg-secondary)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '6px 10px',
                  cursor: 'pointer',
                  transition: 'background 0.15s, box-shadow 0.3s',
                  ...(isHighlighted ? {
                    boxShadow: `0 0 0 2px ${style.color}88, 0 0 12px ${style.color}44`,
                  } : {}),
                }}
              >
                {/* Line 1: type badge + title + turn range */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {isExpanded ? <ChevronDown size={10} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} /> : <ChevronRight size={10} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />}
                  {hasTitle ? (
                    <span className="badge" style={{
                      fontSize: 8, padding: '0 4px', flexShrink: 0,
                      background: style.bg, color: style.color,
                      border: `1px solid ${style.color}44`,
                    }}>
                      {m.type}
                    </span>
                  ) : (
                    <span className="badge" style={{
                      fontSize: 8, padding: '0 4px', flexShrink: 0,
                      background: 'rgba(148,163,184,0.15)', color: '#94a3b8',
                      border: '1px solid rgba(148,163,184,0.3)',
                    }}>
                      P1
                    </span>
                  )}
                  <span className="truncate" style={{
                    flex: 1,
                    fontSize: 12,
                    fontWeight: hasTitle ? 600 : 400,
                    color: hasTitle ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                  }}>
                    {hasTitle ? m.title : (m.userPrompts[0] || `Milestone #${m.index}`)}
                  </span>
                  <span style={{
                    fontSize: 9, fontFamily: 'var(--font-mono)',
                    color: 'var(--color-text-tertiary)', flexShrink: 0,
                  }}>
                    #{m.startTurn}{m.endTurn !== m.startTurn ? `\u2013#${m.endTurn}` : ''}
                  </span>
                </div>

                {/* Line 2: description or stats */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  marginTop: 2, paddingLeft: 16,
                  fontSize: 10, color: 'var(--color-text-tertiary)',
                }}>
                  {hasTitle && m.description ? (
                    <span className="truncate" style={{ flex: 1 }}>{m.description}</span>
                  ) : (
                    <>
                      {m.filesModified.length > 0 && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <FileText size={9} /> {m.filesModified.length} files
                        </span>
                      )}
                      {totalTools > 0 && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <Wrench size={9} /> {totalTools} tools
                        </span>
                      )}
                      {m.taskCompletions.length > 0 && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <CheckCircle2 size={9} /> {m.taskCompletions.length} tasks
                        </span>
                      )}
                      {m.subagentCount > 0 && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <Cpu size={9} /> {m.subagentCount} agents
                        </span>
                      )}
                    </>
                  )}
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div style={{
                    marginTop: 8, paddingLeft: 16, paddingTop: 8,
                    borderTop: '1px solid var(--color-border-subtle)',
                    fontSize: 11,
                  }}>
                    {/* Outcome */}
                    {m.outcome && (
                      <div style={{ marginBottom: 6 }}>
                        <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)', fontSize: 10 }}>Outcome: </span>
                        <span style={{ color: 'var(--color-text-secondary)' }}>{m.outcome}</span>
                      </div>
                    )}

                    {/* Facts */}
                    {m.facts && m.facts.length > 0 && (
                      <div style={{ marginBottom: 6 }}>
                        <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)', fontSize: 10 }}>Facts:</span>
                        <ul style={{ margin: '2px 0 0 16px', padding: 0, listStyle: 'disc' }}>
                          {m.facts.map((f, i) => (
                            <li key={i} style={{ color: 'var(--color-text-secondary)', fontSize: 10, marginBottom: 1 }}>{f}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Concepts */}
                    {m.concepts && m.concepts.length > 0 && (
                      <div style={{ marginBottom: 6, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                        <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)', fontSize: 10 }}>Concepts: </span>
                        {m.concepts.map((c, i) => (
                          <span key={i} className="badge" style={{ fontSize: 9, padding: '1px 5px' }}>{c}</span>
                        ))}
                      </div>
                    )}

                    {/* Files modified */}
                    {m.filesModified.length > 0 && (
                      <div style={{ marginBottom: 6 }}>
                        <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)', fontSize: 10 }}>Files modified:</span>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                          {m.filesModified.map((f, i) => <div key={i}>{f}</div>)}
                        </div>
                      </div>
                    )}

                    {/* Tool breakdown */}
                    {totalTools > 0 && (
                      <div style={{ marginBottom: 6, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                        <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)', fontSize: 10 }}>Tools: </span>
                        {Object.entries(m.toolUseSummary).map(([tool, count]) => (
                          <span key={tool} className="badge" style={{ fontSize: 9, padding: '1px 5px', fontFamily: 'var(--font-mono)' }}>
                            {tool}: {count}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* User prompts */}
                    {m.userPrompts.length > 0 && (
                      <div style={{ marginBottom: 4 }}>
                        <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)', fontSize: 10 }}>User prompts:</span>
                        {m.userPrompts.map((p, i) => (
                          <div key={i} style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2, paddingLeft: 8, borderLeft: '2px solid var(--color-border-subtle)' }}>
                            {p.length > 200 ? p.slice(0, 200) + '...' : p}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
