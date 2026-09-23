'use client';

/**
 * Small building blocks shared by the Backup tab panels: coded error banner, notice,
 * progress bar, origin dot, panel card, and a confirm dialog (optionally typed-confirm).
 * Same inline-style + globals.css class idiom as DataPage.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Loader2, X } from 'lucide-react';
import { BundleApiError, describeDetails, nextStep, toBundleApiError } from '@/lib/data-bundles';

export function Spinner({ size = 14 }: { size?: number }) {
  return <Loader2 size={size} style={{ animation: 'spin 1s linear infinite' }} />;
}

export const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)' };
export const muted: React.CSSProperties = { fontSize: 11, color: 'var(--color-text-tertiary)' };
export const labelStyle: React.CSSProperties = { fontSize: 12, color: 'var(--color-text-secondary)' };
export const th: React.CSSProperties = { padding: '6px 8px', fontWeight: 500, whiteSpace: 'nowrap' };
export const td: React.CSSProperties = { padding: '6px 8px', verticalAlign: 'top' };

/** globals.css has no :disabled look for .btn — dim it so a gated action reads as gated. */
export function dim(disabled: boolean): React.CSSProperties | undefined {
  return disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined;
}

/** Run an async action, turning any failure into a coded error for the banner. */
export async function attempt<T>(fn: () => Promise<T>, onError: (e: BundleApiError) => void): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    console.error('backup action failed', e);
    onError(toBundleApiError(e));
    return undefined;
  }
}

/** A failed call: the Core's code, its message, any numbers it carried, and a next step. */
export function ErrorBanner({ error, onClose }: { error: BundleApiError | null; onClose?: () => void }) {
  if (!error) return null;
  const details = describeDetails(error);
  const hint = nextStep(error.code);
  return (
    <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-status-red)', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <span className="badge badge-red" style={mono}>{error.code}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: 'var(--color-status-red)', wordBreak: 'break-word' }}>{error.message}</div>
        {details && <div style={{ ...muted, marginTop: 2, ...mono }}>{details}</div>}
        {hint && <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 4 }}>{hint}</div>}
      </div>
      {onClose && <button className="btn btn-ghost btn-sm" onClick={onClose} title="Dismiss"><X size={12} /></button>}
    </div>
  );
}

export function Notice({ tone, children, onClose }: { tone: 'ok' | 'warn' | 'info'; children: ReactNode; onClose?: () => void }) {
  const color = tone === 'ok' ? 'var(--color-status-green)' : tone === 'warn' ? 'var(--color-status-orange)' : 'var(--color-border-strong)';
  return (
    <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: `1px solid ${color}`, fontSize: 12, color: 'var(--color-text-secondary)', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{children}</div>
      {onClose && <button className="btn btn-ghost btn-sm" onClick={onClose} title="Dismiss"><X size={12} /></button>}
    </div>
  );
}

export function ProgressBar({ value, total, label }: { value: number; total: number; label?: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 160 }}>
      <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--color-bg-active)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--color-accent)', transition: 'width 150ms ease' }} />
      </div>
      <span style={{ ...muted, ...mono, whiteSpace: 'nowrap' }}>{label ?? `${pct}%`}</span>
    </div>
  );
}

export function OnlineDot({ state }: { state: 'online' | 'offline' | 'unknown' }) {
  const color = state === 'online' ? 'var(--color-status-green)' : state === 'offline' ? 'var(--color-status-red)' : 'var(--color-status-orange)';
  const title = state === 'unknown' ? 'unknown — the hub roster is unavailable' : state;
  return <span title={title} style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />;
}

export function Panel({ title, icon, actions, children, style }: { title: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="card" style={{ marginBottom: 12, ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        {icon}
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{title}</div>
        <div style={{ flex: 1 }} />
        {actions}
      </div>
      {children}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card" style={{ padding: 12, minWidth: 130, flex: '1 1 130px' }}>
      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-text-primary)' }}>{value}</div>
      {sub && <div style={{ ...muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

/**
 * Modal confirm. `typed` makes the user type that exact text first (takeover); `gate` is an
 * extra condition the caller renders inside `children` (e.g. a required force checkbox).
 */
export function ConfirmDialog({
  title, children, confirmLabel, destructive, typed, gate = true, busy, error, onConfirm, onCancel,
}: {
  title: ReactNode;
  children: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  typed?: string;
  gate?: boolean;
  busy?: boolean;
  error?: BundleApiError | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);
  const ok = gate && (!typed || text.trim() === typed) && !busy;
  return (
    <div className="modal-overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div className="modal-content" style={{ padding: 18 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 10 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
        {typed && (
          <label style={{ ...labelStyle, display: 'block', marginTop: 12 }}>
            Type <span style={{ ...mono, color: 'var(--color-text-primary)' }}>{typed}</span> to confirm
            <input className="input" style={{ marginTop: 4, ...mono }} value={text} autoFocus onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && ok) onConfirm(); }} />
          </label>
        )}
        {error && <div style={{ marginTop: 12 }}><ErrorBanner error={error} /></div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className={`btn btn-sm ${destructive ? 'btn-destructive' : 'btn-primary'}`} disabled={!ok} style={dim(!ok)} onClick={onConfirm}>
            {busy && <Spinner size={12} />} {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
