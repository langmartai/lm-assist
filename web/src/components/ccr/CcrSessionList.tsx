'use client';

import { type ReactNode } from 'react';
import { ChevronRight, Cloud, Cast, Monitor } from 'lucide-react';
import { relativeTime } from '@/lib/ccr-status';
import { CcrStatusPill } from './CcrStatusPill';
import type { CcrRow } from './ccrTypes';

const KIND_META: Record<CcrRow['kind'], { icon: typeof Cloud; label: string }> = {
  cloud: { icon: Cloud, label: 'Cloud' },
  remote: { icon: Cast, label: 'Remote control' },
  local: { icon: Monitor, label: 'Local' },
};

export type CcrFilter = 'all' | 'cloud' | 'remote' | 'local';
type Kind = 'cloud' | 'remote' | 'local';
const KIND_ORDER: Kind[] = ['cloud', 'remote', 'local'];
const KIND_LABEL: Record<Kind, string> = { cloud: 'Cloud', remote: 'Remote', local: 'Local' };
const ms = (t?: string | null) => (t ? Date.parse(t) || 0 : 0);
// Deterministic: recency desc, then the STABLE row key as tiebreaker. Most local/rc rows
// have time:null (all tie at 0); without the key tiebreaker they fell back to the API array
// order, which jitters every poll → React re-moves ~all rows → the list "refreshes"/reshuffles
// every 5s. Keying the tiebreaker makes the order change ONLY when the data actually changes.
const byTimeDesc = (a: CcrRow, b: CcrRow) => ms(b.time) - ms(a.time) || a.key.localeCompare(b.key);

/**
 * claude.ai/code-style Sessions list. `filter` is CONTROLLED by the parent (lifted +
 * persisted so a 5s poll re-render/remount can't reset it). The filter is a PRIORITY,
 * not a hard hide: the chosen category renders as the FIRST group and the others follow
 * (so picking "local" surfaces local first while cloud/remote stay reachable below).
 * "all" shows every group in the default order.
 */
export function CcrSessionList({ rows, selectedId, onSelect, rowActions, nowMs, filter, onFilterChange }: {
  rows: CcrRow[];
  selectedId: string | null;
  onSelect: (row: CcrRow) => void;
  rowActions?: (row: CcrRow) => ReactNode;
  nowMs?: number;
  filter: CcrFilter;
  onFilterChange: (f: CcrFilter) => void;
}) {
  const counts = {
    all: rows.length,
    cloud: rows.filter((r) => r.kind === 'cloud').length,
    remote: rows.filter((r) => r.kind === 'remote').length,
    local: rows.filter((r) => r.kind === 'local').length,
  };
  // Group order: the chosen filter's category first, then the remaining categories in
  // default order. "all" = plain default order. Empty groups are dropped.
  const orderedKinds: Kind[] = (filter !== 'all'
    ? [filter as Kind, ...KIND_ORDER.filter((k) => k !== filter)]
    : KIND_ORDER
  ).filter((k) => counts[k] > 0);
  const groups = orderedKinds.map((k) => ({
    kind: k,
    rows: rows.filter((r) => r.kind === k).sort(byTimeDesc),
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>Sessions</div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 2, background: 'var(--color-bg-elevated)', borderRadius: 'var(--radius-md)', padding: 2 }}>
          {(['all', 'cloud', 'remote', 'local'] as CcrFilter[]).map((f) => (
            <button key={f} onClick={() => onFilterChange(f)}
              className="btn btn-sm"
              title={f === 'all' ? 'Show all groups' : `Show ${f} first`}
              style={{
                padding: '2px 10px', fontSize: 11, border: 'none', borderRadius: 'var(--radius-sm)',
                background: filter === f ? 'var(--color-bg-root)' : 'transparent',
                color: filter === f ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                textTransform: 'capitalize',
              }}>
              {f === 'all' ? 'All' : f}{counts[f] ? ` ${counts[f]}` : ''}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', padding: '8px 0' }}>No sessions in this view.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {groups.map((g) => (
            <div key={g.kind} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 2px 2px', fontSize: 11, fontWeight: 600, letterSpacing: 0.3, textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>
                {(() => { const I = KIND_META[g.kind].icon; return <I size={12} />; })()}
                {KIND_LABEL[g.kind]}
                <span style={{ fontWeight: 400 }}>{g.rows.length}</span>
              </div>
              {g.rows.map((row) => {
            // Guard: rows from the registry fallback (core offline / OAuth down) carry no kind.
            const kindMeta = KIND_META[row.kind] || KIND_META.cloud;
            const KindIcon = kindMeta.icon;
            const selected = selectedId === row.id;
            return (
              <div key={row.key} onClick={() => onSelect(row)}
                className="card"
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', cursor: 'pointer',
                  border: selected ? '1px solid var(--color-accent)' : '1px solid var(--color-border-subtle)',
                  background: selected ? 'var(--color-bg-elevated)' : undefined,
                }}>
                <CcrStatusPill status={row.status} />
                <span title={kindMeta.label} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0, display: 'inline-flex' }}><KindIcon size={13} /></span>
                <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.title}</span>
                    {row.unread && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-accent)', flexShrink: 0 }} />}
                    {row.statusDetail && <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{row.statusDetail}</span>}
                  </div>
                </div>
                {row.repo && <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flexShrink: 0, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.repo}{row.branch ? ` · ${row.branch}` : ''}</span>}
                {row.time && <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flexShrink: 0, minWidth: 28, textAlign: 'right' }}>{relativeTime(row.time, nowMs)}</span>}
                {rowActions && <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 4, flexShrink: 0 }}>{rowActions(row)}</div>}
                <ChevronRight size={15} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
              </div>
            );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
