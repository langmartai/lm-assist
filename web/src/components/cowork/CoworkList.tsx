'use client';

import { useState } from 'react';
import { MessageSquare, Plus, Search, Loader2, Code } from 'lucide-react';
import type { HomeRow } from '@/lib/chat-rows';

export interface CoworkListItem {
  sid: string;
  title?: string;
  status?: string;
  model?: string;
  lastEventAt?: string;
  statusCategory?: string | null;
  archived?: boolean;
}

const KIND_FILTER_OPTIONS: Array<{ id: 'all' | 'chat' | 'cowork'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'chat', label: 'Chat' },
  { id: 'cowork', label: 'Cowork' },
];

/** Relative time like claude.ai's list — "Just now", "5 minutes ago", "2 hours ago",
 *  "yesterday", "3 days ago", then a short date ("Jul 4", or "Jul 4, 2025" cross-year).
 *  Guarded for a missing/invalid updatedAt. */
function formatRelativeTime(updatedAt?: string): string {
  if (!updatedAt) return '';
  const d = new Date(updatedAt);
  const t = d.getTime();
  if (Number.isNaN(t)) return '';
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day} days ago`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Status badge for a row — `review_ready` (green) / `needs_action` (amber); anything else renders nothing. */
function StatusBadge({ subtitle }: { subtitle?: string }) {
  if (subtitle === 'review_ready') return <span className="badge badge-green">Review ready</span>;
  if (subtitle === 'needs_action') return <span className="badge badge-amber">Needs you</span>;
  return null;
}

/** Row-kind icon — chat = muted message bubble, cowork = accent `</>` code glyph.
 *  Mirrors claude.ai's chat-bubble vs Code differentiation (accent makes the two
 *  unmistakable at a glance in the merged list). */
function KindIcon({ kind }: { kind: HomeRow['kind'] }) {
  if (kind === 'chat') return <MessageSquare size={15} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />;
  return <Code size={15} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />;
}

/** claude.ai-look-alike "Chats and tasks" list. Pure presentational — the page (Task 7) supplies
 *  `rows` + handlers; this component owns only the local search-string filter (client-side, by title). */
export function CoworkList({ rows, filter, onFilter, onOpen, onNew, loading }: {
  rows: HomeRow[];
  filter: 'all' | 'chat' | 'cowork';
  onFilter: (f: 'all' | 'chat' | 'cowork') => void;
  onOpen: (row: { id: string; kind: HomeRow['kind'] }) => void;
  onNew: () => void;
  loading: boolean;
}) {
  const [search, setSearch] = useState('');

  const kindFiltered = filter === 'all' ? rows : rows.filter((r) => r.kind === filter);
  const q = search.trim().toLowerCase();
  const visibleRows = q ? kindFiltered.filter((r) => (r.title || '').toLowerCase().includes(q)) : kindFiltered;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)', flex: 1 }}>
          Chats and tasks
        </h2>

        {/* All | Chat | Cowork segmented filter — same visual idiom as the Chat|Cowork toggle in CoworkComposer.tsx */}
        <div style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--color-border-default)', borderRadius: 'var(--radius-md)', padding: 2, gap: 2 }}>
          {KIND_FILTER_OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              aria-pressed={o.id === filter}
              onClick={() => onFilter(o.id)}
              style={{
                padding: '3px 10px', borderRadius: 'var(--radius-sm)', border: 'none',
                background: o.id === filter ? 'var(--color-accent-glow)' : 'none',
                color: o.id === filter ? 'var(--color-accent)' : 'var(--color-text-tertiary)',
                fontSize: 11.5, fontWeight: o.id === filter ? 600 : 500, fontFamily: 'var(--font-sans)',
                cursor: o.id === filter ? 'default' : 'pointer',
              }}
            >
              {o.label}
            </button>
          ))}
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
        ) : visibleRows.length === 0 ? (
          <div className="empty-state">
            <MessageSquare size={28} className="empty-state-icon" />
            <span style={{ fontSize: 12.5 }}>No activity yet.</span>
          </div>
        ) : (
          visibleRows.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onOpen({ id: r.id, kind: r.kind })}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: 'none', background: 'none',
                cursor: 'pointer', fontFamily: 'var(--font-sans)', minWidth: 0,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
            >
              <KindIcon kind={r.kind} />
              <span
                className="truncate"
                style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' }}
              >
                {r.title || 'Untitled'}
              </span>
              <StatusBadge subtitle={r.subtitle} />
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flexShrink: 0, minWidth: 72, textAlign: 'right', whiteSpace: 'nowrap' }}>
                {formatRelativeTime(r.updatedAt)}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
