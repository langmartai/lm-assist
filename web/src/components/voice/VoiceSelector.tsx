'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * claude.ai's voice/actor catalogue — WHO speaks back.
 *
 * Kept in step with `core/src/voice/claude-voice-url.ts`'s `CLAUDE_VOICES` (Core whitelists
 * the id before it reaches the WS query, so a name only this file knows about would silently
 * degrade to the default). Same deliberate core↔web duplication as the voice-URL contract:
 * this list is a *display* concern (labels) and Core's is a *safety* concern (validation).
 * Edit both. Provenance + how to re-derive: `docs/claude-ai-voice-protocol.md`.
 */
export const VOICES = [
  { id: 'buttery', label: 'Buttery' },
  { id: 'airy', label: 'Airy' },
  { id: 'mellow', label: 'Mellow' },
  { id: 'glassy', label: 'Glassy' },
  { id: 'rounded', label: 'Rounded' },
] as const;

export const DEFAULT_VOICE = 'buttery';

/** localStorage key for the remembered choice. claude.ai persists its own pick the same way. */
const VOICE_KEY = 'claude-voice-selected';

/** Read the remembered voice, whitelisted — a stale/hand-edited value can never reach the wire. */
export function loadStoredVoice(): string {
  try {
    const v = localStorage.getItem(VOICE_KEY);
    if (v && VOICES.some((x) => x.id === v)) return v;
  } catch { /* private mode / storage disabled — fall through to the default */ }
  return DEFAULT_VOICE;
}

export function storeVoice(voice: string): void {
  try { localStorage.setItem(VOICE_KEY, voice); } catch { /* ignore */ }
}

/** claude.ai-style inline "Buttery ▾" text button, matching `ModelEffortSelector`'s idiom
 *  (ghost button + upward popover) so the two sit together in the voice footer as one control
 *  strip. Deliberately NOT a flag on `ModelEffortSelector`: that component has six call sites
 *  (cowork/ccr composers, chat + task views) where a voice has no meaning. Pure controlled. */
export function VoiceSelector({ voice, onChange }: {
  voice: string;
  onChange: (voice: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside (matches ModelEffortSelector / MachineDropdown idiom)
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

  const label = VOICES.find((v) => v.id === voice)?.label ?? voice;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Voice: ${label}`}
        title="Voice that speaks back"
        style={{ color: 'var(--color-text-secondary)', fontSize: 11.5 }}
      >
        <span>{label}</span>
        <ChevronDown size={12} style={{ transition: 'transform 200ms ease', transform: open ? 'rotate(180deg)' : undefined }} />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            right: 0,
            minWidth: 160,
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border-default)',
            borderRadius: 'var(--radius-md)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
            zIndex: 60,
            padding: 4,
          }}
        >
          <div style={{ padding: '4px 8px 2px', fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Voice
          </div>
          {VOICES.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => { onChange(v.id); setOpen(false); }}
              style={{
                display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left',
                padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: 'none',
                background: v.id === voice ? 'var(--color-accent-glow)' : 'none',
                color: v.id === voice ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                fontSize: 12, fontFamily: 'var(--font-sans)', cursor: 'pointer',
              }}
              onMouseEnter={(e) => { if (v.id !== voice) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)'; }}
              onMouseLeave={(e) => { if (v.id !== voice) e.currentTarget.style.background = 'none'; }}
            >
              {v.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
