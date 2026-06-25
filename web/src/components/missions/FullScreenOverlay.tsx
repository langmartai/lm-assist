'use client';

import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2 } from 'lucide-react';

/** A subtle ghost maximize button — the affordance that expands an element full-screen. */
export function ExpandIconButton({
  onClick,
  title = 'Expand to full screen',
}: {
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      className="btn btn-ghost btn-sm"
      onClick={onClick}
      title={title}
      style={{ padding: '2px 5px', flexShrink: 0 }}
    >
      <Maximize2 size={12} />
    </button>
  );
}

/**
 * A full-viewport overlay rendered to document.body via a portal, so it covers everything
 * (including the left nav). `Esc` or the collapse button closes it; page scroll is locked
 * while open. `headerExtra` hosts per-element header controls (e.g. a Save button + toggle).
 */
export function FullScreenOverlay({
  title,
  onClose,
  headerExtra,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  headerExtra?: ReactNode;
  children: ReactNode;
}) {
  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // SSR guard — portals need a document.
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9990,
        background: 'var(--color-bg-root)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid var(--color-border-subtle)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--color-text-primary)',
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </div>
        {headerExtra}
        <button className="btn btn-ghost btn-sm" onClick={onClose} title="Collapse (Esc)">
          <Minimize2 size={13} /> Collapse
        </button>
      </div>
      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
