'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, Zap, ChevronDown, ChevronRight, FileText, PenTool, Bot } from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { useMachineContext } from '@/contexts/MachineContext';

interface SkillInvocation {
  skillName: string;
  pluginName: string;
  shortName: string;
  args?: string;
  toolUseId: string;
  turnIndex: number;
  lineIndex: number;
  spanStartLine: number;
  spanEndLine?: number;
  toolsCalled: string[];
  toolUseCount: number;
  filesRead: string[];
  filesWritten: string[];
  subagentIds: string[];
  success?: boolean;
  timestamp?: string;
}

interface SkillTimelineProps {
  sessionId: string;
  machineId?: string;
}

// Deterministic color for a plugin name
const PLUGIN_COLORS = [
  'var(--color-accent)',
  'var(--color-status-blue)',
  'var(--color-status-green)',
  'var(--color-status-purple)',
  'var(--color-status-cyan)',
  'var(--color-status-orange)',
  'var(--color-status-pink)',
];

function pluginColor(pluginName: string): string {
  let hash = 0;
  for (let i = 0; i < pluginName.length; i++) {
    hash = ((hash << 5) - hash + pluginName.charCodeAt(i)) | 0;
  }
  return PLUGIN_COLORS[Math.abs(hash) % PLUGIN_COLORS.length];
}

export function SkillTimeline({ sessionId, machineId }: SkillTimelineProps) {
  const { apiClient, proxy } = useAppMode();
  const { selectedMachineId } = useMachineContext();

  const apiClientRef = useRef(apiClient);
  apiClientRef.current = apiClient;
  const machineIdRef = useRef(machineId || selectedMachineId);
  machineIdRef.current = machineId || selectedMachineId;

  const apiFetch = useCallback(async <T,>(path: string): Promise<T> => {
    return apiClientRef.current.fetchPath<T>(path, {
      machineId: machineIdRef.current || proxy.machineId || undefined,
    });
  }, [proxy.machineId]);

  const [skills, setSkills] = useState<SkillInvocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<{ sessionId: string; skillInvocations: SkillInvocation[]; total: number }>(
      `/sessions/${sessionId}/skills`
    )
      .then(data => {
        if (!cancelled) setSkills(data.skillInvocations || []);
      })
      .catch(err => {
        if (!cancelled) setError(err?.message || 'Failed to load skills');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [apiFetch, sessionId]);

  if (loading) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
        <span style={{ fontSize: 12 }}>Loading skills...</span>
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

  if (skills.length === 0) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <Zap size={32} style={{ color: 'var(--color-text-tertiary)', opacity: 0.5 }} />
        <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)', marginTop: 8 }}>
          No skill invocations in this session
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header bar */}
      <div style={{
        padding: '8px 16px',
        borderBottom: '1px solid var(--color-border-default)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 11,
        color: 'var(--color-text-tertiary)',
      }}>
        <Zap size={12} style={{ color: 'var(--color-accent)' }} />
        <span style={{ fontFamily: 'var(--font-mono)' }}>
          {skills.length} skill invocation{skills.length !== 1 ? 's' : ''}
        </span>

        {/* Chain flow (if 2+ skills) */}
        {skills.length >= 2 && (
          <>
            <div style={{ flex: 1 }} />
            <SkillChainFlow skills={skills} />
          </>
        )}
      </div>

      {/* Timeline */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 16px 16px 20px', position: 'relative' }} className="scrollbar-thin">
        {/* Vertical connector line */}
        <div style={{
          position: 'absolute',
          left: 29,
          top: 16,
          bottom: 16,
          width: 2,
          background: 'var(--color-border-default)',
          borderRadius: 1,
        }} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {skills.map((skill, i) => {
            const isExpanded = expandedIndex === i;
            const color = pluginColor(skill.pluginName);
            return (
              <div key={`${skill.toolUseId}-${i}`} style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 14,
                position: 'relative',
              }}>
                {/* Node indicator */}
                <div style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: 'var(--color-bg-root)',
                  border: `2px solid ${skill.success === true ? 'var(--color-status-green)' : skill.success === false ? 'var(--color-status-red)' : 'var(--color-border-strong)'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  zIndex: 1,
                  marginTop: 8,
                }}>
                  <div style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: skill.success === true
                      ? 'var(--color-status-green)'
                      : skill.success === false
                        ? 'var(--color-status-red)'
                        : 'var(--color-text-tertiary)',
                  }} />
                </div>

                {/* Card */}
                <div
                  style={{
                    flex: 1,
                    padding: '10px 14px',
                    background: 'var(--color-bg-surface)',
                    border: '1px solid var(--color-border-default)',
                    borderLeft: `3px solid ${color}`,
                    borderRadius: 'var(--radius-md)',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  onClick={() => setExpandedIndex(isExpanded ? null : i)}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border-strong)';
                    (e.currentTarget as HTMLElement).style.borderLeftColor = color;
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border-default)';
                    (e.currentTarget as HTMLElement).style.borderLeftColor = color;
                  }}
                >
                  {/* Skill name + plugin + expand chevron */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                      {skill.shortName}
                    </span>
                    <span style={{
                      fontSize: 10,
                      color: 'var(--color-text-tertiary)',
                      fontFamily: 'var(--font-mono)',
                    }}>
                      {skill.pluginName}
                    </span>
                    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
                      {isExpanded
                        ? <ChevronDown size={14} style={{ color: 'var(--color-text-tertiary)' }} />
                        : <ChevronRight size={14} style={{ color: 'var(--color-text-tertiary)' }} />
                      }
                    </div>
                  </div>

                  {/* Summary stats as badges */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <span className="badge badge-default" style={{ fontSize: 9, padding: '1px 6px', fontFamily: 'var(--font-mono)' }}>
                      L{skill.spanStartLine}{skill.spanEndLine ? `-${skill.spanEndLine}` : ''}
                    </span>
                    <span className="badge badge-default" style={{ fontSize: 9, padding: '1px 6px', fontFamily: 'var(--font-mono)' }}>
                      {skill.toolUseCount} tools
                    </span>
                    {skill.filesRead.length > 0 && (
                      <span className="badge badge-blue" style={{ fontSize: 9, padding: '1px 6px', fontFamily: 'var(--font-mono)' }}>
                        {skill.filesRead.length} reads
                      </span>
                    )}
                    {skill.filesWritten.length > 0 && (
                      <span className="badge badge-amber" style={{ fontSize: 9, padding: '1px 6px', fontFamily: 'var(--font-mono)' }}>
                        {skill.filesWritten.length} writes
                      </span>
                    )}
                    {skill.subagentIds.length > 0 && (
                      <span className="badge badge-purple" style={{ fontSize: 9, padding: '1px 6px', fontFamily: 'var(--font-mono)' }}>
                        {skill.subagentIds.length} agents
                      </span>
                    )}
                  </div>

                  {/* Args preview */}
                  {skill.args && (
                    <div style={{
                      fontSize: 11,
                      color: 'var(--color-text-secondary)',
                      marginTop: 6,
                      fontFamily: 'var(--font-mono)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: isExpanded ? 'pre-wrap' : 'nowrap',
                      maxHeight: isExpanded ? undefined : 18,
                      lineHeight: '18px',
                    }}>
                      {skill.args}
                    </div>
                  )}

                  {/* Expanded details */}
                  {isExpanded && (
                    <div style={{
                      marginTop: 10,
                      borderTop: '1px solid var(--color-border-subtle)',
                      paddingTop: 10,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}>
                      {skill.toolsCalled.length > 0 && (
                        <div>
                          <div style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: 'var(--color-text-tertiary)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.3px',
                            marginBottom: 5,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                          }}>
                            <Zap size={10} />
                            Tools Used
                          </div>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {skill.toolsCalled.map((tool, j) => (
                              <span key={j} className="badge badge-default" style={{ fontSize: 9, padding: '1px 6px' }}>
                                {tool}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {skill.filesRead.length > 0 && (
                        <div>
                          <div style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: 'var(--color-text-tertiary)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.3px',
                            marginBottom: 5,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                          }}>
                            <FileText size={10} />
                            Files Read
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {skill.filesRead.map((file, j) => (
                              <span key={j} style={{
                                fontSize: 10,
                                fontFamily: 'var(--font-mono)',
                                color: 'var(--color-text-secondary)',
                                lineHeight: '16px',
                              }}>
                                {file}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {skill.filesWritten.length > 0 && (
                        <div>
                          <div style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: 'var(--color-text-tertiary)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.3px',
                            marginBottom: 5,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                          }}>
                            <PenTool size={10} />
                            Files Written
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {skill.filesWritten.map((file, j) => (
                              <span key={j} style={{
                                fontSize: 10,
                                fontFamily: 'var(--font-mono)',
                                color: 'var(--color-text-secondary)',
                                lineHeight: '16px',
                              }}>
                                {file}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {skill.subagentIds.length > 0 && (
                        <div>
                          <div style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: 'var(--color-text-tertiary)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.3px',
                            marginBottom: 5,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                          }}>
                            <Bot size={10} />
                            Subagents
                          </div>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {skill.subagentIds.map((id, j) => (
                              <span key={j} className="badge badge-purple" style={{
                                fontSize: 9,
                                padding: '1px 6px',
                                fontFamily: 'var(--font-mono)',
                              }}>
                                {id.slice(0, 12)}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---- Chain Flow (horizontal connected pills) ----

function SkillChainFlow({ skills }: { skills: SkillInvocation[] }) {
  if (skills.length === 0) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, overflow: 'hidden' }}>
      {skills.map((skill, i) => (
        <span key={`${skill.toolUseId}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
          {i > 0 && (
            <span style={{
              fontSize: 10,
              color: 'var(--color-text-tertiary)',
              margin: '0 3px',
              fontFamily: 'var(--font-mono)',
            }}>
              {'\u2192'}
            </span>
          )}
          <span
            className={`badge ${
              skill.success === true ? 'badge-green' :
              skill.success === false ? 'badge-red' :
              'badge-default'
            }`}
            style={{
              fontSize: 9,
              padding: '1px 6px',
            }}
          >
            {skill.shortName}
          </span>
        </span>
      ))}
    </div>
  );
}
