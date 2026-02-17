'use client';

import { useState, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppMode } from '@/contexts/AppModeContext';
import {
  Map as MapIcon,
  ChevronDown,
  ChevronRight,
  FileText,
} from 'lucide-react';
import type { CachedPlan } from '@/lib/types';

interface PlansTabProps {
  plans: CachedPlan[];
  toolUses?: any[];
  machineId?: string;
}

export function PlansTab({ plans: rawPlans, toolUses, machineId }: PlansTabProps) {
  const { apiClient } = useAppMode();
  const [expandedPlanIds, setExpandedPlanIds] = useState<Set<string>>(new Set());
  const [fetchedPlanContent, setFetchedPlanContent] = useState<Map<string, string>>(new Map());
  const [fetchingPlanIds, setFetchingPlanIds] = useState<Set<string>>(new Set());

  // Merge full plan content from ExitPlanMode tool calls
  const plans = useMemo(() => {
    const planContentMap = new Map<string, string>();
    if (toolUses) {
      toolUses
        .filter((t: any) => t.name === 'ExitPlanMode' && t.input?.plan)
        .forEach((t: any) => planContentMap.set(t.id, t.input.plan));
    }
    return rawPlans.map(plan => ({
      ...plan,
      fullPlanContent: planContentMap.get(plan.toolUseId) || undefined,
    }));
  }, [rawPlans, toolUses]);

  const togglePlanExpanded = useCallback((toolUseId: string) => {
    setExpandedPlanIds(prev => {
      const next = new Set(prev);
      if (next.has(toolUseId)) next.delete(toolUseId);
      else next.add(toolUseId);
      return next;
    });
  }, []);

  const fetchPlanFileContent = useCallback(async (toolUseId: string, planFile: string) => {
    if (fetchedPlanContent.has(toolUseId) || fetchingPlanIds.has(toolUseId)) return;
    setFetchingPlanIds(prev => new Set(prev).add(toolUseId));
    try {
      const content = await apiClient.getPlanFileContent(planFile, machineId);
      if (content) {
        setFetchedPlanContent(prev => new Map(prev).set(toolUseId, content));
      }
    } catch { /* ignore fetch errors */ }
    setFetchingPlanIds(prev => {
      const next = new Set(prev);
      next.delete(toolUseId);
      return next;
    });
  }, [fetchedPlanContent, fetchingPlanIds, apiClient, machineId]);

  if (plans.length === 0) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <MapIcon size={28} className="empty-state-icon" />
        <span style={{ fontSize: 13 }}>No plans in this session</span>
      </div>
    );
  }

  const enteringCount = plans.filter(p => p.status === 'entering').length;
  const approvedCount = plans.filter(p => p.status === 'approved').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Stats bar */}
      <div style={{
        padding: '6px 16px',
        borderBottom: '1px solid var(--color-border-default)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontSize: 11,
      }}>
        <span style={{ color: '#d97706' }}>{enteringCount} entering</span>
        <span style={{ color: '#16a34a' }}>{approvedCount} approved</span>
      </div>

      {/* Plan cards */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }} className="scrollbar-thin">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {plans.map((plan, idx) => {
            const isExpanded = expandedPlanIds.has(plan.toolUseId);
            const resolvedContent = plan.fullPlanContent || fetchedPlanContent.get(plan.toolUseId);
            const hasExpandableContent = plan.status === 'approved' && (plan.fullPlanContent || plan.planFile);
            const isFetching = fetchingPlanIds.has(plan.toolUseId);

            return (
              <div
                key={plan.toolUseId || idx}
                className="card"
                style={{
                  padding: '10px 12px',
                  borderLeft: `3px solid ${plan.status === 'approved' ? '#16a34a' : '#d97706'}`,
                  background: plan.status === 'approved'
                    ? 'rgba(22,163,106,0.06)'
                    : 'rgba(217,119,6,0.06)',
                }}
              >
                {/* Header */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    cursor: hasExpandableContent ? 'pointer' : 'default',
                  }}
                  onClick={() => {
                    if (!hasExpandableContent) return;
                    togglePlanExpanded(plan.toolUseId);
                    if (!isExpanded && !plan.fullPlanContent && plan.planFile) {
                      fetchPlanFileContent(plan.toolUseId, plan.planFile);
                    }
                  }}
                >
                  {hasExpandableContent && (
                    isExpanded
                      ? <ChevronDown size={14} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                      : <ChevronRight size={14} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                  )}
                  <span
                    className={`badge ${plan.status === 'entering' ? 'badge-yellow' : 'badge-green'}`}
                    style={{ fontSize: 9, padding: '1px 6px', fontFamily: 'var(--font-mono)' }}
                  >
                    {plan.status === 'entering' ? 'EnterPlanMode' : 'ExitPlanMode'}
                  </span>
                  {plan.status === 'entering' ? (
                    <span style={{ fontSize: 12, fontWeight: 500, color: '#d97706' }}>
                      Entered Plan Mode
                    </span>
                  ) : (
                    <>
                      <span
                        className="badge badge-green"
                        style={{ fontSize: 9, padding: '1px 6px', fontFamily: 'var(--font-mono)' }}
                      >
                        APPROVED
                      </span>
                      {plan.planTitle && (
                        <span style={{ fontSize: 12, fontWeight: 600 }} className="truncate">
                          {plan.planTitle}
                        </span>
                      )}
                    </>
                  )}
                  <span style={{
                    fontSize: 10,
                    color: 'var(--color-text-tertiary)',
                    fontFamily: 'var(--font-mono)',
                    marginLeft: 'auto',
                    flexShrink: 0,
                  }}>
                    Turn #{plan.turnIndex}
                  </span>
                </div>

                {/* Entering explanation */}
                {plan.status === 'entering' && (
                  <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
                    Agent paused to research and design an implementation plan before writing code.
                  </div>
                )}

                {/* Exit explanation */}
                {plan.status === 'approved' && (
                  <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
                    Agent exited plan mode — plan was approved and is ready for implementation.
                  </div>
                )}

                {/* Plan file */}
                {plan.planFile && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
                    <FileText size={12} style={{ flexShrink: 0 }} />
                    <span className="truncate">{plan.planFile}</span>
                  </div>
                )}

                {/* Collapsed: summary */}
                {!isExpanded && plan.planSummary && (
                  <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 6 }}>
                    <span>{plan.planSummary}</span>
                    {hasExpandableContent && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePlanExpanded(plan.toolUseId);
                          if (!plan.fullPlanContent && plan.planFile) {
                            fetchPlanFileContent(plan.toolUseId, plan.planFile);
                          }
                        }}
                        style={{
                          marginLeft: 4,
                          color: 'var(--color-accent)',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          fontSize: 11,
                          textDecoration: 'underline',
                        }}
                      >
                        show full plan
                      </button>
                    )}
                  </div>
                )}

                {/* Expanded: full markdown */}
                {isExpanded && (
                  <div style={{ marginTop: 8 }}>
                    {isFetching ? (
                      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontStyle: 'italic', padding: '8px 0' }}>
                        Loading plan content...
                      </div>
                    ) : resolvedContent ? (
                      <div style={{
                        maxHeight: '60vh',
                        overflow: 'auto',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--color-border-subtle)',
                        background: 'var(--color-bg-surface)',
                        padding: '10px 12px',
                      }} className="scrollbar-thin">
                        <div className="prose" style={{ fontSize: 12 }}>
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {resolvedContent}
                          </ReactMarkdown>
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontStyle: 'italic', padding: '4px 0' }}>
                        Plan content not available (session may have been compacted)
                      </div>
                    )}
                  </div>
                )}

                {/* Allowed prompts */}
                {plan.allowedPrompts && plan.allowedPrompts.length > 0 && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--color-border-subtle)' }}>
                    <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>Allowed Prompts:</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {plan.allowedPrompts.map((ap, apIdx) => (
                        <span
                          key={apIdx}
                          className="badge badge-default"
                          style={{ fontSize: 10, padding: '1px 6px' }}
                        >
                          {ap.tool}: {ap.prompt}
                        </span>
                      ))}
                    </div>
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
