'use client';

import { useEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { timeAgo } from '@/components/memory/format';
import { useNow } from '@/hooks/useHarnessRuns';
import {
  compactNumber,
  firstLine,
  formatDuration,
  formatElapsed,
  groupRunsByDay,
  pathBasename,
  runnerLabel,
  statusMeta,
  type HarnessRunRow,
} from '@/lib/harness-runs';

// ─── Small shared pieces (used by the other harness components too) ──────────

export function StatusDot({ status, size = 8 }: { status: string; size?: number }) {
  const m = statusMeta(status);
  return (
    <span
      className={`status-dot${m.pulse ? ' in-progress' : ''}`}
      style={{ width: size, height: size, background: m.colorVar }}
      title={m.label}
    />
  );
}

/**
 * A status colour for TEXT. The --color-status-* tokens are not redefined for the light
 * theme, and as text on near-white they measure ~1.3-1.7:1 (#4ade80, #22d3ee, #fde047).
 * Under the light theme this resolves to a darker shade of the same hue (HARNESS_TEXT_CSS,
 * scoped to `.harness-root`); in the dark theme, or outside the page, it falls back to the
 * token itself — the dark theme is unchanged. Dots, bars and backgrounds keep the token.
 */
export function statusText(colorVar: string): string {
  const m = /^var\(--color-status-([a-z]+)\)$/.exec(colorVar);
  return m ? `var(--hr-text-${m[1]}, ${colorVar})` : colorVar;
}

/** Light-theme text shades for statusText (Tailwind 700s: 4.9-6.7:1 on white). */
export const HARNESS_TEXT_CSS =
  '[data-theme="light"] .harness-root{--hr-text-green:#15803d;--hr-text-red:#b91c1c;--hr-text-cyan:#0e7490;' +
  '--hr-text-yellow:#a16207;--hr-text-orange:#c2410c;--hr-text-blue:#1d4ed8;--hr-text-purple:#7e22ce}';

/**
 * A tinted pill in the status colour — the token set has no per-status badge for every state.
 * The text is the status TEXT shade (statusText) pulled toward the theme's primary text colour.
 */
export function tint(colorVar: string, pct = 14): CSSProperties {
  return {
    color: `color-mix(in srgb, ${statusText(colorVar)} 72%, var(--color-text-primary))`,
    background: `color-mix(in srgb, ${colorVar} ${pct}%, transparent)`,
    border: `1px solid color-mix(in srgb, ${colorVar} 35%, transparent)`,
  };
}

export function StatusBadge({ status, children }: { status: string; children?: ReactNode }) {
  const m = statusMeta(status);
  return (
    <span className="badge" style={{ fontSize: 10.5, ...tint(m.colorVar) }}>
      <StatusDot status={status} size={6} />
      {m.label}
      {children}
    </span>
  );
}

export function RunnerBadge({ runner, displayName }: { runner: string; displayName?: string | null }) {
  return (
    <span className="badge badge-outline" style={{ fontSize: 9.5, padding: '0 6px', flexShrink: 0 }}>
      {runnerLabel(runner, displayName)}
    </span>
  );
}

export function CoreCwdChip() {
  return (
    <span
      className="badge"
      style={{ fontSize: 9, padding: '0 5px', flexShrink: 0, ...tint('var(--color-status-yellow)') }}
      title="The caller passed no cwd, so the harness ran in Core's own working directory"
    >
      Core cwd
    </span>
  );
}

export function SkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 16px' }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div className="skeleton" style={{ height: 12, width: `${70 + ((i * 13) % 25)}%` }} />
          <div className="skeleton" style={{ height: 9, width: `${40 + ((i * 17) % 30)}%` }} />
        </div>
      ))}
    </div>
  );
}

const metaSep = <span style={{ color: 'var(--color-text-tertiary)', opacity: 0.6 }}>·</span>;

function RunRow({ row, selected, now, onSelect }: { row: HarnessRunRow; selected: boolean; now: number; onSelect: (id: string) => void }) {
  const duration = row.live
    ? formatElapsed(now - row.startedAt)
    : formatDuration(row.durationMs ?? (row.endedAt != null ? row.endedAt - row.startedAt : undefined));
  const errs = row.toolErrors ?? 0;
  const failed = row.status === 'failed' || row.status === 'launch_failed' || row.status === 'timed_out';
  return (
    <button
      type="button"
      data-run-id={row.id}
      onClick={() => onSelect(row.id)}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '7px 14px 7px 12px',
        background: selected ? 'var(--color-bg-hover)' : 'transparent',
        borderLeft: selected ? '2px solid var(--color-accent)' : '2px solid transparent',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <StatusDot status={row.status} />
        <RunnerBadge runner={row.runner} displayName={row.runnerDisplayName} />
        <span
          style={{ fontSize: 12, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}
          title={row.promptPreview}
        >
          {firstLine(row.promptPreview, 140) || <span style={{ color: 'var(--color-text-tertiary)' }}>(no prompt recorded)</span>}
        </span>
      </div>
      <div
        style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5, marginTop: 3, paddingLeft: 14, fontSize: 10.5, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}
      >
        <span title={new Date(row.startedAt).toLocaleString()}>{timeAgo(row.startedAt)}</span>
        {metaSep}
        <span style={row.live ? { color: statusText('var(--color-status-blue)') } : undefined} title={row.live ? 'elapsed' : 'duration'}>{duration}</span>
        {row.numTurns != null && <>{metaSep}<span>{row.numTurns} turn{row.numTurns === 1 ? '' : 's'}</span></>}
        {row.toolCalls != null && (
          <>
            {metaSep}
            <span>
              {row.toolCalls} tool{row.toolCalls === 1 ? '' : 's'}
              {errs > 0 && <span style={{ color: statusText('var(--color-status-red)') }}> ({errs} err)</span>}
            </span>
          </>
        )}
        {row.usage?.reported && (
          <>{metaSep}<span title="input / output tokens">{compactNumber(row.usage.inputTokens)}/{compactNumber(row.usage.outputTokens)} tok</span></>
        )}
        {row.cwd && <>{metaSep}<span title={row.cwd} style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pathBasename(row.cwd)}</span></>}
        {row.cwdDefaulted && <CoreCwdChip />}
        {row.origin === 'backfill' && (
          <span className="badge badge-outline" style={{ fontSize: 9, padding: '0 5px' }} title="Backfilled from files on disk — its fields are inferred, not recorded">legacy</span>
        )}
        {row.inferred && row.origin !== 'backfill' && (
          <span className="badge badge-outline" style={{ fontSize: 9, padding: '0 5px' }}>inferred</span>
        )}
        {row.background && (
          <span className="badge badge-outline" style={{ fontSize: 9, padding: '0 5px' }} title="Started with background:true">bg</span>
        )}
      </div>
      {failed && row.errorPreview && (
        <div
          style={{ marginTop: 2, paddingLeft: 14, fontSize: 10.5, color: statusText('var(--color-status-red)'), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={row.errorPreview}
        >
          {firstLine(row.errorPreview, 160)}
        </div>
      )}
    </button>
  );
}

/**
 * The left column: runs grouped by day (Today / Yesterday / date), newest first. Up/down
 * arrows move the selection while the list has focus.
 */
export function RunList({
  rows,
  selectedId,
  onSelect,
  initialLoading,
  hasMore,
  loadingMore,
  onLoadMore,
  empty,
  header,
}: {
  rows: HarnessRunRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  initialLoading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  empty?: ReactNode;
  header?: ReactNode;
}) {
  const anyLive = rows.some((r) => r.live);
  const now = useNow(anyLive);
  // Day labels only need a coarse clock; the live timer above re-renders often enough.
  const groups = useMemo(() => groupRunsByDay(rows, Date.now()), [rows]);
  const listRef = useRef<HTMLDivElement>(null);
  // Scroll to a selection ONCE, when its row first exists: a deep link selects before the rows
  // load, and re-scrolling on every poll would yank the list away from where the user scrolled.
  const scrolledFor = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedId || !listRef.current || scrolledFor.current === selectedId) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(selectedId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    scrolledFor.current = selectedId;
  }, [selectedId, rows]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!rows.length) return;
    e.preventDefault();
    const i = rows.findIndex((r) => r.id === selectedId);
    const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
    onSelect(rows[next].id);
  };

  return (
    <div
      ref={listRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label="Harness runs"
      style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 0 12px', outline: 'none' }}
    >
      {header}
      {initialLoading && rows.length === 0 ? (
        <SkeletonRows />
      ) : rows.length === 0 ? (
        empty ?? null
      ) : (
        <>
          {groups.map((g) => (
            <div key={g.key} style={{ marginBottom: 8 }}>
              <div
                style={{ padding: '6px 14px 4px', fontSize: 10.5, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}
              >
                {g.label} <span style={{ fontWeight: 400 }}>({g.rows.length})</span>
              </div>
              {g.rows.map((r) => (
                <RunRow key={r.id} row={r} selected={r.id === selectedId} now={now} onSelect={onSelect} />
              ))}
            </div>
          ))}
          {hasMore && (
            <div style={{ padding: '4px 14px' }}>
              <button type="button" className="btn btn-sm btn-ghost" style={{ width: '100%' }} onClick={onLoadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
