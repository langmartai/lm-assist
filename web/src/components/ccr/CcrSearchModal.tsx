'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { Search, X, Cloud, Cast, Monitor } from 'lucide-react';
import type { CcrRow } from './ccrTypes';

const KIND_ICON = { cloud: Cloud, remote: Cast, local: Monitor } as const;

/** Recency bucket for a row's last activity — mirrors claude.ai's Today/Yesterday/Past week grouping. */
function bucket(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return 'Other';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'Other';
  const days = (nowMs - t) / 86_400_000;
  if (days < 1) return 'Today';
  if (days < 2) return 'Yesterday';
  if (days < 7) return 'Past week';
  if (days < 30) return 'Past month';
  return 'Older';
}
const ORDER = ['Today', 'Yesterday', 'Past week', 'Past month', 'Older', 'Other'];

/** claude.ai/code-style "Search chats and projects" modal: type-to-filter, recency-grouped, Enter opens top. */
export function CcrSearchModal({ rows, onSelect, onClose, nowMs }: {
  rows: CcrRow[];
  onSelect: (row: CcrRow) => void;
  onClose: () => void;
  nowMs: number;
}) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const matched = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const r = needle ? rows.filter((x) => x.title.toLowerCase().includes(needle) || (x.statusDetail || '').toLowerCase().includes(needle) || (x.repo || '').toLowerCase().includes(needle)) : rows;
    return r;
  }, [rows, q]);

  // Group by recency bucket, preserving the incoming (recency-sorted) order within each.
  const groups = useMemo(() => {
    const by: Record<string, CcrRow[]> = {};
    for (const row of matched) { const b = bucket(row.time, nowMs); (by[b] ||= []).push(row); }
    return ORDER.filter((k) => by[k]?.length).map((k) => ({ label: k, rows: by[k] }));
  }, [matched, nowMs]);

  const top = matched[0];
  const pick = (row: CcrRow) => { onSelect(row); onClose(); };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(640px, 92vw)', maxHeight: '70vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)', borderRadius: 'var(--radius-lg)', boxShadow: '0 16px 48px rgba(0,0,0,0.5)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--color-border-default)' }}>
          <Search size={16} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && top) pick(top); }}
            placeholder="Search sessions, repos…"
            style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: 14, color: 'var(--color-text-primary)' }} />
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', display: 'inline-flex' }}><X size={16} /></button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 6 }}>
          {matched.length === 0 ? (
            <div style={{ padding: '18px 12px', fontSize: 13, color: 'var(--color-text-tertiary)', textAlign: 'center' }}>No matching sessions.</div>
          ) : groups.map((g) => (
            <div key={g.label} style={{ marginBottom: 4 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, padding: '6px 10px 2px' }}>{g.label}</div>
              {g.rows.map((row) => {
                const Icon = KIND_ICON[row.kind];
                return (
                  <button key={row.key} onClick={() => pick(row)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 'var(--radius-md)', border: 'none', background: row === top ? 'rgba(255,255,255,0.06)' : 'none', cursor: 'pointer', color: 'var(--color-text-secondary)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }} onMouseLeave={(e) => { e.currentTarget.style.background = row === top ? 'rgba(255,255,255,0.06)' : 'none'; }}>
                    <Icon size={14} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                    <span style={{ fontSize: 13, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0, maxWidth: '46%' }}>{row.title}</span>
                    {row.statusDetail && <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.statusDetail}</span>}
                    {row.repo && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>{row.repo.split('/').pop()}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
