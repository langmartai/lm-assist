'use client';

import { useState, useRef, useEffect } from 'react';
import { ChevronDown, MessageSquare, Plus, Search, Loader2 } from 'lucide-react';

export interface CoworkListItem {
  sid: string;
  title?: string;
  status?: string;
  model?: string;
  lastEventAt?: string;
  statusCategory?: string | null;
  archived?: boolean;
}

const FILTER_OPTIONS: Array<{ id: string; label: string; disabled?: boolean }> = [
  { id: 'all', label: 'All' },
  { id: 'chat', label: 'Chat', disabled: true },
  { id: 'shared', label: 'Shared', disabled: true },
  { id: 'cowork', label: 'Cowork' },
  { id: 'archived', label: 'Archived' },
];

/** Short date like claude.ai's list ("Jul 4") — guarded for a missing/invalid lastEventAt. */
function formatShortDate(lastEventAt?: string): string {
  if (!lastEventAt) return '';
  const d = new Date(lastEventAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Status badge for a row — `review_ready` (green) / `needs_action` (amber); anything else renders nothing. */
function StatusBadge({ statusCategory }: { statusCategory?: string | null }) {
  if (statusCategory === 'review_ready') return <span className="badge badge-green">Review ready</span>;
  if (statusCategory === 'needs_action') return <span className="badge badge-amber">Needs you</span>;
  return null;
}

/** claude.ai-look-alike "Chats and tasks" list. Pure presentational — the page (Task 11) supplies
 *  `tasks` + handlers; this component owns only the local search-string filter (client-side, by title). */
export function CoworkList({ tasks, filter, onFilter, onOpen, onNew, loading }: {
  tasks: CoworkListItem[];
  filter: string;
  onFilter: (f: string) => void;
  onOpen: (sid: string) => void;
  onNew: () => void;
  loading: boolean;
}) {
  const [search, setSearch] = useState('');
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const filterMenuRef = useRef<HTMLDivElement>(null);

  // Close the Filter ▾ menu on outside click / Escape (idiom copied from MachineDropdown.tsx / CoworkComposer.tsx).
  useEffect(() => {
    if (!filterMenuOpen) return;
    function handleMouseDown(e: MouseEvent) {
      if (filterMenuRef.current && !filterMenuRef.current.contains(e.target as Node)) setFilterMenuOpen(false);
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [filterMenuOpen]);
  useEffect(() => {
    if (!filterMenuOpen) return;
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') setFilterMenuOpen(false); }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [filterMenuOpen]);

  const filterLabel = FILTER_OPTIONS.find((o) => o.id === filter)?.label ?? 'All';

  const q = search.trim().toLowerCase();
  const visibleTasks = q ? tasks.filter((t) => (t.title || '').toLowerCase().includes(q)) : tasks;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)', flex: 1 }}>
          Chats and tasks
        </h2>

        <div ref={filterMenuRef} style={{ position: 'relative' }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setFilterMenuOpen((v) => !v)}
            aria-expanded={filterMenuOpen}
          >
            Filter by {filterLabel} <ChevronDown size={12} style={{ transition: 'transform 200ms ease', transform: filterMenuOpen ? 'rotate(180deg)' : undefined }} />
          </button>

          {filterMenuOpen && (
            <div
              style={{
                position: 'absolute', top: 'calc(100% + 6px)', right: 0, minWidth: 160,
                background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-md)', boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
                zIndex: 60, padding: 4,
              }}
            >
              {FILTER_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  disabled={o.disabled}
                  title={o.disabled ? 'Coming soon' : undefined}
                  onClick={() => { if (o.disabled) return; onFilter(o.id); setFilterMenuOpen(false); }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: 'none',
                    background: o.id === filter ? 'var(--color-accent-glow)' : 'none',
                    color: o.disabled ? 'var(--color-text-tertiary)' : (o.id === filter ? 'var(--color-accent)' : 'var(--color-text-primary)'),
                    opacity: o.disabled ? 0.5 : 1,
                    cursor: o.disabled ? 'not-allowed' : 'pointer',
                    fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: o.id === filter ? 600 : 500,
                  }}
                  onMouseEnter={(e) => { if (!o.disabled && o.id !== filter) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)'; }}
                  onMouseLeave={(e) => { if (!o.disabled && o.id !== filter) e.currentTarget.style.background = 'none'; }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <button type="button" className="btn btn-primary btn-sm" onClick={onNew}>
          <Plus size={13} /> New
        </button>
      </div>

      <div className="input-with-icon" style={{ position: 'relative' }}>
        <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-tertiary)' }} />
        <input
          type="text"
          className="input"
          value={search}
          placeholder="Search chats and tasks…"
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: '100%', paddingLeft: 30 }}
        />
      </div>

      <div className="card" style={{ padding: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {loading ? (
          <div className="empty-state">
            <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: 12 }}>Loading…</span>
          </div>
        ) : visibleTasks.length === 0 ? (
          <div className="empty-state">
            <MessageSquare size={28} className="empty-state-icon" />
            <span style={{ fontSize: 12.5 }}>No activity yet.</span>
          </div>
        ) : (
          visibleTasks.map((t) => (
            <button
              key={t.sid}
              type="button"
              onClick={() => onOpen(t.sid)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: 'none', background: 'none',
                cursor: 'pointer', fontFamily: 'var(--font-sans)', minWidth: 0,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
            >
              <MessageSquare size={14} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
              <span
                className="truncate"
                style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' }}
              >
                {t.title || 'Untitled'}
              </span>
              <StatusBadge statusCategory={t.statusCategory} />
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flexShrink: 0, minWidth: 40, textAlign: 'right' }}>
                {formatShortDate(t.lastEventAt)}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
