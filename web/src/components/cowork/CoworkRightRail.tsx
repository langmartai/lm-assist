'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Check, Circle, FileText, Wrench } from 'lucide-react';

export interface CoworkGoalStep {
  label: string;
  status: 'done' | 'active' | 'pending';
}

/** One collapsible section header — chevron + label, matches the ToolCard/ThinkBlock
 *  idiom in CcrSessionView.tsx (ChevronRight collapsed / ChevronDown open). */
function SectionHeader({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
        background: 'none', border: 'none', cursor: 'pointer', padding: '6px 2px',
        fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)',
        textTransform: 'uppercase', letterSpacing: 0.4, fontFamily: 'var(--font-sans)',
      }}
    >
      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      <span style={{ flex: 1 }}>{label}</span>
    </button>
  );
}

function GoalStepCircle({ status }: { status: CoworkGoalStep['status'] }) {
  if (status === 'done') {
    return (
      <div style={{
        width: 16, height: 16, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--color-status-green)', color: 'var(--color-bg-surface)', flexShrink: 0,
      }}>
        <Check size={10} strokeWidth={3} />
      </div>
    );
  }
  if (status === 'active') {
    return (
      <div style={{
        width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
        background: 'var(--color-accent)', animation: 'pulse-dot 2s ease-in-out infinite',
      }} />
    );
  }
  return <Circle size={16} style={{ color: 'var(--color-text-tertiary)', opacity: 0.5, flexShrink: 0 }} />;
}

/** claude.ai-look-alike right rail for a Cowork task: Progress (step circles from
 *  activeGoal), Outputs (downloadable file rows), Context (tool chips + file paths).
 *  Pure presentational — three independent collapsible sections, default Progress
 *  collapsed / Outputs+Context open (matches the captured claude.ai layout). */
export function CoworkRightRail({ activeGoal, outputs, context, onDownload }: {
  activeGoal: CoworkGoalStep[];
  outputs: string[];
  context: { tools: string[]; files: string[] };
  onDownload: (file: string) => void;
}) {
  const [progressOpen, setProgressOpen] = useState(false);
  const [outputsOpen, setOutputsOpen] = useState(true);
  const [contextOpen, setContextOpen] = useState(true);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
      {/* Progress */}
      <div>
        <SectionHeader label="Progress" open={progressOpen} onToggle={() => setProgressOpen((v) => !v)} />
        {progressOpen && (
          <div style={{ padding: '4px 2px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {activeGoal.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {activeGoal.map((step, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <GoalStepCircle status={step.status} />
                    <span style={{
                      fontSize: 12, lineHeight: 1.4,
                      color: step.status === 'pending' ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
                      fontWeight: step.status === 'active' ? 600 : 400,
                    }}>
                      {step.label}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', lineHeight: 1.4 }}>
              See task progress for longer tasks.
            </div>
          </div>
        )}
      </div>

      <div style={{ height: 1, background: 'var(--color-border-default)', margin: '2px 0' }} />

      {/* Outputs */}
      <div>
        <SectionHeader label={`Outputs ${outputs.length}`} open={outputsOpen} onToggle={() => setOutputsOpen((v) => !v)} />
        {outputsOpen && (
          <div style={{ padding: '4px 2px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {outputs.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>No outputs yet.</div>
            ) : (
              outputs.map((file) => (
                <button
                  key={file}
                  type="button"
                  onClick={() => onDownload(file)}
                  title={file}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                    padding: '6px 6px', borderRadius: 'var(--radius-sm)', border: 'none', background: 'none',
                    cursor: 'pointer', fontFamily: 'var(--font-sans)', minWidth: 0,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
                >
                  <FileText size={13} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                  <span className="truncate" style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--color-text-primary)' }}>
                    {file}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div style={{ height: 1, background: 'var(--color-border-default)', margin: '2px 0' }} />

      {/* Context */}
      <div>
        <SectionHeader label="Context" open={contextOpen} onToggle={() => setContextOpen((v) => !v)} />
        {contextOpen && (
          <div style={{ padding: '4px 2px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {context.tools.length === 0 && context.files.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', lineHeight: 1.4 }}>
                Track tools and referenced files used in this task.
              </div>
            ) : (
              <>
                {context.tools.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {context.tools.map((t, i) => (
                      <span key={i} className="badge badge-outline" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5 }}>
                        <Wrench size={10} /> {t}
                      </span>
                    ))}
                  </div>
                )}
                {context.files.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {context.files.map((f, i) => (
                      <div key={i} className="truncate" title={f} style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
                        {f}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
