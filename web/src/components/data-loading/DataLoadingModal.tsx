'use client';

import { useEffect, useCallback, useRef } from 'react';
import { X, Database, CheckCircle2, Circle, Loader2, XCircle, SkipForward } from 'lucide-react';
import { useDataLoading, type LoadingStep, DATA_LOADED_KEY } from '@/hooks/useDataLoading';

// ─── Status icon ─────────────────────────────────────────────

function StatusIcon({ status }: { status: LoadingStep['status'] }) {
  switch (status) {
    case 'complete':
      return <CheckCircle2 size={14} style={{ color: 'var(--color-status-green)', flexShrink: 0 }} />;
    case 'running':
      return (
        <Loader2
          size={14}
          style={{ color: 'var(--color-status-blue)', flexShrink: 0, animation: 'spin 1s linear infinite' }}
        />
      );
    case 'error':
      return <XCircle size={14} style={{ color: 'var(--color-status-red)', flexShrink: 0 }} />;
    case 'skipped':
      return <SkipForward size={14} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />;
    default:
      return <Circle size={14} style={{ color: 'var(--color-border)', flexShrink: 0 }} />;
  }
}

// ─── Step row ─────────────────────────────────────────────────

interface StepRowProps {
  step: LoadingStep;
  checked: boolean;
  isRunning: boolean;
  onToggle: () => void;
}

function StepRow({ step, checked, isRunning, onToggle }: StepRowProps) {
  const active = step.status === 'running' || step.status === 'complete' || step.status === 'error';
  const detailColor =
    step.status === 'error'
      ? 'var(--color-status-red)'
      : step.status === 'complete'
      ? 'var(--color-status-green)'
      : 'var(--color-status-blue)';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '10px 0',
        borderBottom: '1px solid var(--color-border)',
        opacity: (!step.builtin && !checked && step.status === 'pending') ? 0.45 : 1,
        transition: 'opacity 0.15s',
      }}
    >
      {/* Checkbox or built-in indicator */}
      <div style={{ paddingTop: 1, flexShrink: 0, width: 14 }}>
        {step.builtin ? null : (
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            disabled={isRunning}
            style={{ cursor: isRunning ? 'not-allowed' : 'pointer', width: 14, height: 14, marginTop: 1 }}
          />
        )}
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
            }}
          >
            {step.label}
          </span>
          {step.builtin && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 500,
                color: 'var(--color-text-tertiary)',
                background: 'var(--color-bg-tertiary)',
                border: '1px solid var(--color-border)',
                borderRadius: 3,
                padding: '1px 5px',
                letterSpacing: '0.02em',
              }}
            >
              built-in
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 1 }}>
          {step.description}
        </div>
        {/* Activity result */}
        {step.detail && (
          <div style={{ fontSize: 11, marginTop: 4, color: detailColor, fontFamily: 'monospace' }}>
            {step.status === 'running' ? '→ ' : step.status === 'complete' ? '✓ ' : '✗ '}
            {step.detail}
          </div>
        )}
        {step.status === 'running' && !step.detail && (
          <div style={{ fontSize: 11, marginTop: 4, color: 'var(--color-status-blue)' }}>
            Running…
          </div>
        )}
      </div>

      {/* Status icon */}
      <div style={{ paddingTop: 2, flexShrink: 0 }}>
        <StatusIcon status={step.status} />
      </div>
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────

interface DataLoadingModalProps {
  isOpen: boolean;
  onClose: () => void;
  autoRun?: boolean;
}

export function DataLoadingModal({ isOpen, onClose, autoRun = false }: DataLoadingModalProps) {
  const {
    steps,
    enabled,
    autoStart,
    isRunning,
    isDone,
    anyEnabled,
    toggleStep,
    setAutoStart,
    startLoading,
    reset,
  } = useDataLoading();

  const autoRunFired = useRef(false);

  const handleClose = useCallback(() => {
    if (!isRunning) onClose();
  }, [isRunning, onClose]);

  // Auto-run on open if requested (e.g. auto-start setting is enabled)
  useEffect(() => {
    if (isOpen && autoRun && !autoRunFired.current && !isRunning) {
      autoRunFired.current = true;
      startLoading();
    }
  }, [isOpen, autoRun, isRunning, startLoading]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isRunning) onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, isRunning, onClose]);

  if (!isOpen) return null;

  const allDone = steps.every(s => s.status === 'complete' || s.status === 'skipped' || s.status === 'error');
  const hasStarted = steps.some(s => s.status !== 'pending');
  const isDataLoaded = typeof window !== 'undefined' && localStorage.getItem(DATA_LOADED_KEY) === 'true';

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={handleClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.5)',
          zIndex: 9998,
          backdropFilter: 'blur(2px)',
        }}
      />

      {/* Modal */}
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 9999,
          background: 'var(--color-bg-secondary)',
          border: '1px solid var(--color-border)',
          borderRadius: 10,
          width: 480,
          maxWidth: 'calc(100vw - 40px)',
          maxHeight: 'calc(100vh - 80px)',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '16px 20px',
            borderBottom: '1px solid var(--color-border)',
            flexShrink: 0,
          }}
        >
          <Database size={15} style={{ color: 'var(--color-accent)' }} />
          <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Data Loading</span>
          <button
            onClick={handleClose}
            disabled={isRunning}
            style={{
              background: 'none',
              border: 'none',
              cursor: isRunning ? 'not-allowed' : 'pointer',
              padding: 4,
              color: 'var(--color-text-tertiary)',
              display: 'flex',
              alignItems: 'center',
              opacity: isRunning ? 0.4 : 1,
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Subtitle */}
        <div
          style={{
            padding: '10px 20px',
            fontSize: 12,
            color: 'var(--color-text-secondary)',
            background: 'var(--color-bg-tertiary)',
            borderBottom: '1px solid var(--color-border)',
            flexShrink: 0,
          }}
        >
          {isDataLoaded
            ? 'Data was previously loaded. Select tasks and run to refresh.'
            : 'Select tasks to run. Checked tasks will be executed in order.'}
        </div>

        {/* Steps with checkboxes */}
        <div style={{ padding: '0 20px', overflowY: 'auto', flex: 1 }}>
          {steps.map(step => (
            <StepRow
              key={step.id}
              step={step}
              checked={enabled[step.id] ?? step.enabledByDefault}
              isRunning={isRunning}
              onToggle={() => toggleStep(step.id)}
            />
          ))}
        </div>

        {/* Auto-start row */}
        <div
          style={{
            padding: '10px 20px',
            borderTop: '1px solid var(--color-border)',
            borderBottom: '1px solid var(--color-border)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
          }}
        >
          <input
            type="checkbox"
            id="autostart-checkbox"
            checked={autoStart}
            onChange={e => setAutoStart(e.target.checked)}
            disabled={isRunning}
            style={{ cursor: isRunning ? 'not-allowed' : 'pointer', width: 14, height: 14 }}
          />
          <label
            htmlFor="autostart-checkbox"
            style={{
              fontSize: 12,
              color: 'var(--color-text-secondary)',
              cursor: isRunning ? 'not-allowed' : 'pointer',
              userSelect: 'none',
              flex: 1,
            }}
          >
            Auto-start selected tasks on next server start
          </label>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '12px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
          }}
        >
          {isDone && allDone ? (
            <>
              <CheckCircle2 size={14} style={{ color: 'var(--color-status-green)' }} />
              <span style={{ fontSize: 12, color: 'var(--color-status-green)', flex: 1, fontWeight: 500 }}>
                Done
              </span>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={reset}>
                Reset
              </button>
              <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={onClose}>
                Close
              </button>
            </>
          ) : (
            <>
              <div style={{ flex: 1 }} />
              {hasStarted && !isRunning && (
                <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={reset}>
                  Reset
                </button>
              )}
              <button
                className="btn btn-ghost"
                style={{ fontSize: 12 }}
                onClick={handleClose}
                disabled={isRunning}
              >
                {isRunning ? 'Running…' : 'Close'}
              </button>
              <button
                className="btn btn-primary"
                style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}
                onClick={startLoading}
                disabled={isRunning || !anyEnabled}
              >
                {isRunning ? (
                  <>
                    <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
                    Running…
                  </>
                ) : hasStarted ? (
                  'Run Again'
                ) : (
                  'Run'
                )}
              </button>
            </>
          )}
        </div>
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </>
  );
}
