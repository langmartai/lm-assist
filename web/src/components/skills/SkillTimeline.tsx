'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, Zap, ChevronDown, ChevronRight, CheckCircle2, XCircle } from 'lucide-react';
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
        <Zap size={28} className="empty-state-icon" />
        <span style={{ fontSize: 13 }}>No skill invocations in this session</span>
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
        gap: 8,
        fontSize: 11,
        color: 'var(--color-text-tertiary)',
      }}>
        <Zap size={12} />
        <span>{skills.length} skill invocation{skills.length !== 1 ? 's' : ''}</span>

        {/* Chain flow */}
        <div style={{ flex: 1 }} />
        <SkillChainFlow skills={skills} />
      </div>

      {/* Timeline */}
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px', position: 'relative' }} className="scrollbar-thin">
        {/* Vertical line */}
        <div style={{
          position: 'absolute',
          left: 31,
          top: 12,
          bottom: 12,
          width: 2,
          background: 'var(--color-border-default)',
        }} />

        {skills.map((skill, i) => {
          const isExpanded = expandedIndex === i;
          return (
            <div key={`${skill.toolUseId}-${i}`} style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              padding: '6px 0',
              position: 'relative',
            }}>
              {/* Node indicator */}
              <div style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: 'var(--color-bg-surface)',
                border: `2px solid ${skill.success === true ? 'var(--color-status-green)' : skill.success === false ? 'var(--color-status-red)' : 'var(--color-border-default)'}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                zIndex: 1,
              }}>
                {skill.success === true && <CheckCircle2 size={12} style={{ color: 'var(--color-status-green)' }} />}
                {skill.success === false && <XCircle size={12} style={{ color: 'var(--color-status-red)' }} />}
                {skill.success === undefined && <Zap size={10} style={{ color: 'var(--color-text-tertiary)' }} />}
              </div>

              {/* Card */}
              <div
                className="card"
                style={{ flex: 1, padding: '8px 12px', cursor: 'pointer' }}
                onClick={() => setExpandedIndex(isExpanded ? null : i)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-primary)' }}>
                    {skill.shortName}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                    {skill.pluginName}
                  </span>
                  {isExpanded
                    ? <ChevronDown size={12} style={{ marginLeft: 'auto', color: 'var(--color-text-tertiary)' }} />
                    : <ChevronRight size={12} style={{ marginLeft: 'auto', color: 'var(--color-text-tertiary)' }} />
                  }
                </div>

                {/* Summary stats */}
                <div style={{ display: 'flex', gap: 8, fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                  <span>Lines {skill.spanStartLine}{skill.spanEndLine ? `-${skill.spanEndLine}` : ''}</span>
                  <span>{skill.toolUseCount} tools</span>
                  {skill.filesRead.length > 0 && <span>{skill.filesRead.length} reads</span>}
                  {skill.filesWritten.length > 0 && <span>{skill.filesWritten.length} writes</span>}
                  {skill.subagentIds.length > 0 && <span>{skill.subagentIds.length} agents</span>}
                </div>

                {/* Args */}
                {skill.args && (
                  <div style={{
                    fontSize: 11,
                    color: 'var(--color-text-secondary)',
                    marginTop: 4,
                    fontFamily: 'var(--font-mono)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: isExpanded ? 'pre-wrap' : 'nowrap',
                    maxHeight: isExpanded ? undefined : 18,
                  }}>
                    {skill.args}
                  </div>
                )}

                {/* Expanded details */}
                {isExpanded && (
                  <div style={{ marginTop: 8, borderTop: '1px solid var(--color-border-default)', paddingTop: 8 }}>
                    {skill.toolsCalled.length > 0 && (
                      <div style={{ marginBottom: 6 }}>
                        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
                          Tools Used
                        </div>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {skill.toolsCalled.map((tool, j) => (
                            <span key={j} className="badge badge-default" style={{ fontSize: 9 }}>{tool}</span>
                          ))}
                        </div>
                      </div>
                    )}

                    {skill.filesRead.length > 0 && (
                      <div style={{ marginBottom: 6 }}>
                        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
                          Files Read
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          {skill.filesRead.map((file, j) => (
                            <span key={j} style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)' }}>
                              {file}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {skill.filesWritten.length > 0 && (
                      <div style={{ marginBottom: 6 }}>
                        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
                          Files Written
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          {skill.filesWritten.map((file, j) => (
                            <span key={j} style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)' }}>
                              {file}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {skill.subagentIds.length > 0 && (
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
                          Subagents
                        </div>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {skill.subagentIds.map((id, j) => (
                            <span key={j} className="badge" style={{
                              fontSize: 9,
                              background: 'rgba(139,92,246,0.15)',
                              color: '#8b5cf6',
                              border: '1px solid rgba(139,92,246,0.3)',
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
  );
}

// ─── Inline Chain Flow (horizontal pill view) ──────────────

function SkillChainFlow({ skills }: { skills: SkillInvocation[] }) {
  if (skills.length === 0) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
      {skills.map((skill, i) => (
        <span key={`${skill.toolUseId}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {i > 0 && (
            <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
              {'\u2192'}
            </span>
          )}
          <span
            className="badge"
            style={{
              fontSize: 9,
              padding: '1px 5px',
              background: skill.success === true
                ? 'rgba(34,197,94,0.15)'
                : skill.success === false
                  ? 'rgba(239,68,68,0.15)'
                  : 'var(--color-bg-surface)',
              color: skill.success === true
                ? 'var(--color-status-green)'
                : skill.success === false
                  ? 'var(--color-status-red)'
                  : 'var(--color-text-secondary)',
              border: `1px solid ${
                skill.success === true
                  ? 'rgba(34,197,94,0.3)'
                  : skill.success === false
                    ? 'rgba(239,68,68,0.3)'
                    : 'var(--color-border-default)'
              }`,
            }}
          >
            {skill.shortName}
          </span>
        </span>
      ))}
    </div>
  );
}
