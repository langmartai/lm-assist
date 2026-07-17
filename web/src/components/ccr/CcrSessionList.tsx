'use client';

import { type ReactNode } from 'react';
import { ChevronRight, Cloud, Cast, Monitor } from 'lucide-react';
import { relativeTime } from '@/lib/ccr-status';
import { CcrStatusPill } from './CcrStatusPill';
import { groupRows, categoryCounts, type CcrView, type CcrCategory } from '@/lib/ccr-view';
import type { CcrRow } from './ccrTypes';

const KIND_META: Record<CcrRow['kind'], { icon: typeof Cloud; label: string }> = {
  cloud: { icon: Cloud, label: 'Cloud' },
  remote: { icon: Cast, label: 'Remote' },
  local: { icon: Monitor, label: 'Local' },
};

/**
 * claude.ai/code-style Sessions list. Rendering derives entirely from the
 * SHARED CcrView (the same state the sidebar edits) via the ONE ordering
 * engine in lib/ccr-view — the tabs here write view.category, which is a
 * PRIORITY, not a hide: the chosen category renders as the FIRST group and
 * the others follow. Node filtering (view.node) applies identically here and
 * in the sidebar; rows from other machines carry a small node tag.
 */
export function CcrSessionList({ rows, view, onViewChange, nodeNames, selfNode, selectedId, onSelect, rowActions, nowMs }: {
  rows: CcrRow[];
  view: CcrView;
  onViewChange: (v: CcrView) => void;
  nodeNames: Record<string, string>;
  selfNode: string | null;
  selectedId: string | null;
  onSelect: (row: CcrRow) => void;
  rowActions?: (row: CcrRow) => ReactNode;
  nowMs?: number;
}) {
  const counts = categoryCounts(rows, view);
  const groups = groupRows(rows, view);
  const multiNode = rows.some((r) => r.node && r.node !== selfNode);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>Sessions</div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 2, background: 'var(--color-bg-elevated)', borderRadius: 'var(--radius-md)', padding: 2 }}>
          {(['all', 'cloud', 'remote', 'local'] as CcrCategory[]).map((f) => (
            <button key={f} onClick={() => onViewChange({ ...view, category: f })}
              className="btn btn-sm"
              title={f === 'all' ? 'Show all groups' : `Show ${f} first`}
              style={{
                padding: '2px 10px', fontSize: 11, border: 'none', borderRadius: 'var(--radius-sm)',
                background: view.category === f ? 'var(--color-bg-root)' : 'transparent',
                color: view.category === f ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
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
                {KIND_META[g.kind].label}
                <span style={{ fontWeight: 400 }}>{g.rows.length}</span>
              </div>
              {g.rows.map((row) => {
            // Guard: rows from the registry fallback (core offline / OAuth down) carry no kind.
            const kindMeta = KIND_META[row.kind] || KIND_META.cloud;
            const KindIcon = kindMeta.icon;
            const selected = selectedId === row.id;
            const nodeTag = multiNode && row.node ? (nodeNames[row.node] || row.node) : null;
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
                {nodeTag && <span title={`on ${nodeTag}`} style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)', flexShrink: 0, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-sm)', padding: '0 5px' }}>{nodeTag}</span>}
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
