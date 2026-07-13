'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

const MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
];

const EFFORTS = ['low', 'medium', 'high', 'max'];

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** claude.ai-style inline "Sonnet 5 · Medium ▾" text button — opens a small popover
 *  with a model list, then an effort list. Pure controlled component. */
export function ModelEffortSelector({ model, effort, onChange, hideEffort = false }: {
  model: string; effort: string; onChange: (model: string, effort: string) => void; hideEffort?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside (matches MachineDropdown.tsx idiom)
  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  const modelLabel = MODELS.find((m) => m.id === model)?.label ?? model;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{ color: 'var(--color-text-secondary)', fontSize: 11.5 }}
      >
        <span>{modelLabel}</span>
        {!hideEffort && (
          <>
            <span style={{ color: 'var(--color-text-tertiary)' }}>·</span>
            <span>{cap(effort)}</span>
          </>
        )}
        <ChevronDown size={12} style={{ transition: 'transform 200ms ease', transform: open ? 'rotate(180deg)' : undefined }} />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            right: 0,
            minWidth: 180,
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border-default)',
            borderRadius: 'var(--radius-md)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
            zIndex: 60,
            padding: 4,
          }}
        >
          <div style={{ padding: '4px 8px 2px', fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Model
          </div>
          {MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => { onChange(m.id, effort); setOpen(false); }}
              style={{
                display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left',
                padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: 'none',
                background: m.id === model ? 'var(--color-accent-glow)' : 'none',
                color: m.id === model ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                fontSize: 12, fontFamily: 'var(--font-sans)', cursor: 'pointer',
              }}
              onMouseEnter={(e) => { if (m.id !== model) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)'; }}
              onMouseLeave={(e) => { if (m.id !== model) e.currentTarget.style.background = 'none'; }}
            >
              {m.label}
            </button>
          ))}

          {!hideEffort && (
            <>
              <div style={{ height: 1, background: 'var(--color-border-default)', margin: '4px 0' }} />

              <div style={{ padding: '4px 8px 2px', fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Effort
              </div>
              {EFFORTS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => { onChange(model, e); setOpen(false); }}
                  style={{
                    display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left',
                    padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: 'none',
                    background: e === effort ? 'var(--color-accent-glow)' : 'none',
                    color: e === effort ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                    fontSize: 12, fontFamily: 'var(--font-sans)', cursor: 'pointer',
                  }}
                  onMouseEnter={(ev) => { if (e !== effort) ev.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)'; }}
                  onMouseLeave={(ev) => { if (e !== effort) ev.currentTarget.style.background = 'none'; }}
                >
                  {cap(e)}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
