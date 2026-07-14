'use client';

import { useState, type ReactNode } from 'react';
import { ChevronRight, Cloud, Cast, Monitor } from 'lucide-react';
import { relativeTime } from '@/lib/ccr-status';
import { CcrStatusPill } from './CcrStatusPill';
import type { CcrRow } from './ccrTypes';

const KIND_META: Record<CcrRow['kind'], { icon: typeof Cloud; label: string }> = {
  cloud: { icon: Cloud, label: 'Cloud' },
  remote: { icon: Cast, label: 'Remote control' },
  local: { icon: Monitor, label: 'Local' },
};

type Filter = 'all' | 'cloud' | 'remote' | 'local';

/** claude.ai/code-style Sessions list: a segmented filter + recency-sorted status-pill rows. */
export function CcrSessionList({ rows, selectedId, onSelect, rowActions, nowMs }: {
  rows: CcrRow[];
  selectedId: string | null;
  onSelect: (row: CcrRow) => void;
  rowActions?: (row: CcrRow) => ReactNode;
  nowMs?: number;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const counts = {
    all: rows.length,
    cloud: rows.filter((r) => r.kind === 'cloud').length,
    remote: rows.filter((r) => r.kind === 'remote').length,
    local: rows.filter((r) => r.kind === 'local').length,
  };
  const shown = filter === 'all' ? rows : rows.filter((r) => r.kind === filter);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>Sessions</div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 2, background: 'var(--color-bg-elevated)', borderRadius: 'var(--radius-md)', padding: 2 }}>
          {(['all', 'cloud', 'remote', 'local'] as Filter[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className="btn btn-sm"
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

      {shown.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', padding: '8px 0' }}>No sessions in this view.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {shown.map((row) => {
            const KindIcon = KIND_META[row.kind].icon;
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
                <span title={KIND_META[row.kind].label} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0, display: 'inline-flex' }}><KindIcon size={13} /></span>
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
      )}
    </div>
  );
}
