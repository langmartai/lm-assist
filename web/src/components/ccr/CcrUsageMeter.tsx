'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { ApiFetch } from './ccrTypes';

interface Window { utilization: number | null; resets_at: string | null }
interface Usage { five_hour?: Window; seven_day?: Window; seven_day_opus?: Window | null; seven_day_sonnet?: Window | null }

/** "Resets in 2 hr 48 min" style relative string. */
function resetsIn(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '';
  const t = Date.parse(iso); if (!Number.isFinite(t)) return '';
  let s = Math.max(0, (t - nowMs) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  const parts = [] as string[];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h} hr`);
  if (!d && m) parts.push(`${m} min`);
  return parts.length ? `Resets in ${parts.join(' ')}` : 'Resets soon';
}

/** claude.ai/code composer usage indicator: a ring + a popover with 5-hour / weekly plan limits. */
export function CcrUsageMeter({ apiFetch }: { apiFetch: ApiFetch }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    apiFetch<Usage>('/claude-code/usage').then(setUsage).catch(() => { /* best-effort — hide on failure */ });
  }, [apiFetch]);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown); return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!usage) return null;
  const now = Date.now();
  const rows = [
    { key: '5h', label: '5-hour limit', w: usage.five_hour },
    { key: '7d', label: 'Weekly · all models', w: usage.seven_day },
    { key: 'opus', label: 'Weekly · Opus', w: usage.seven_day_opus || undefined },
  ].filter((r) => r.w && r.w.utilization != null) as Array<{ key: string; label: string; w: Window }>;
  const peak = Math.max(0, ...rows.map((r) => r.w.utilization || 0));
  const ringColor = peak >= 90 ? 'var(--color-status-red)' : peak >= 70 ? 'var(--color-status-orange)' : 'var(--color-accent)';
  const dash = `${(peak / 100) * 44} 44`; // circumference of r=7 ≈ 44

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button onClick={() => setOpen((v) => !v)} title={`Usage — peak ${peak}%`}
        style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 3, display: 'inline-flex', alignItems: 'center' }}>
        <svg width="18" height="18" viewBox="0 0 18 18">
          <circle cx="9" cy="9" r="7" fill="none" stroke="var(--color-border-default)" strokeWidth="2" />
          <circle cx="9" cy="9" r="7" fill="none" stroke={ringColor} strokeWidth="2" strokeLinecap="round"
            strokeDasharray={dash} transform="rotate(-90 9 9)" />
        </svg>
      </button>
      {open && (
        <div style={{ position: 'absolute', bottom: 'calc(100% + 8px)', right: 0, width: 260, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)', borderRadius: 'var(--radius-md)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)', zIndex: 70, padding: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>Plan usage</div>
          {rows.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>No limits reported.</div>
          ) : rows.map((r) => {
            const pct = Math.round(r.w.utilization || 0);
            const c = pct >= 90 ? 'var(--color-status-red)' : pct >= 70 ? 'var(--color-status-orange)' : 'var(--color-accent)';
            return (
              <div key={r.key} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 3 }}>
                  <span>{r.label}</span><span style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{pct}%</span>
                </div>
                <div style={{ height: 5, background: 'var(--color-bg-root)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: c, borderRadius: 3 }} />
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{resetsIn(r.w.resets_at, now)}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
