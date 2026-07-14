'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Home, Code2, Plus, RefreshCw } from 'lucide-react';
import { MachineDropdown } from '@/components/layout/MachineDropdown';
import { ccrStatusPill, toneColor } from '@/lib/ccr-status';
import type { CcrRow } from './ccrTypes';

const INITIAL_RECENTS = 20;

/**
 * claude.ai/code-style left sidebar for the full-bleed Code page:
 * wordmark (back to the app) · Home|Code pills · New session · Recents · machine picker.
 */
export function CcrSidebar({ rows, selectedId, onSelect, onNewSession, onRefresh, loading }: {
  rows: CcrRow[];
  selectedId: string | null;
  onSelect: (row: CcrRow) => void;
  onNewSession: () => void;
  onRefresh: () => void;
  loading: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const recents = showAll ? rows : rows.slice(0, INITIAL_RECENTS);
  const hiddenCount = rows.length - INITIAL_RECENTS;

  return (
    <div style={{ width: 240, flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--color-border-default)', background: 'var(--color-bg-elevated)' }}>
      {/* Wordmark — escape hatch back into the lm-assist app */}
      <div style={{ padding: '14px 16px 8px', display: 'flex', alignItems: 'center' }}>
        <Link href="/sessions" title="Back to lm-assist" style={{ fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)', textDecoration: 'none', letterSpacing: -0.3 }}>
          lm-assist
        </Link>
      </div>

      {/* Home | Code segmented pill (claude.ai parity — Home returns to the app) */}
      <div style={{ margin: '4px 10px 10px', display: 'flex', background: 'var(--color-bg-root)', borderRadius: 'var(--radius-lg)', padding: 3, gap: 2 }}>
        <Link href="/sessions" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '5px 0', borderRadius: 'var(--radius-md)', fontSize: 12.5, color: 'var(--color-text-tertiary)', textDecoration: 'none' }}>
          <Home size={13} /> Home
        </Link>
        <span style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '5px 0', borderRadius: 'var(--radius-md)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)' }}>
          <Code2 size={13} /> Code
        </span>
      </div>

      {/* New session */}
      <button onClick={onNewSession}
        style={{ margin: '0 10px', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 'var(--radius-md)', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', textAlign: 'left' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
        <Plus size={15} /> New session
      </button>

      {/* Recents */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '14px 16px 4px' }}>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>Recents</span>
        <span style={{ flex: 1 }} />
        <button onClick={onRefresh} title="Refresh" disabled={loading}
          style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', padding: 2, display: 'inline-flex' }}>
          <RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
        </button>
      </div>
      {/* minHeight:0 lets this flex child actually shrink so the footer never gets pushed out */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 6px 6px' }}>
        {recents.map((row) => {
          const { tone, label } = ccrStatusPill(row.status);
          const active = selectedId === row.id;
          return (
            <button key={row.key} onClick={() => onSelect(row)} title={`${label}${row.statusDetail ? ` — ${row.statusDetail}` : ''}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '6px 10px',
                borderRadius: 'var(--radius-md)', border: 'none', cursor: 'pointer', fontSize: 12.5,
                background: active ? 'rgba(255,255,255,0.08)' : 'none',
                color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = active ? 'rgba(255,255,255,0.08)' : 'none'; }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: toneColor(tone), flexShrink: 0, opacity: tone === 'gray' ? 0.5 : 1 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.title}</span>
              {row.unread && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--color-accent)', flexShrink: 0, marginLeft: 'auto' }} />}
            </button>
          );
        })}
        {!showAll && hiddenCount > 0 && (
          <button onClick={() => setShowAll(true)}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            Show {hiddenCount} more
          </button>
        )}
        {rows.length === 0 && !loading && (
          <div style={{ padding: '6px 10px', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>No sessions yet.</div>
        )}
      </div>

      {/* Bottom: machine picker (claude.ai's account-chip position); panel opens upward
          via the .ccr-sidebar-machine override in globals.css */}
      <div className="ccr-sidebar-machine" style={{ borderTop: '1px solid var(--color-border-default)', padding: '8px 10px' }}>
        <MachineDropdown />
      </div>
    </div>
  );
}
