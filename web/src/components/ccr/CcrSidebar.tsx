'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { prevAppRoute } from '@/components/RouteTracker';
import {
  Home, Code2, Plus, RefreshCw, Search, PanelLeftClose, PanelLeft, SlidersHorizontal,
  MoreVertical, ExternalLink, Pencil, Copy, Check, Archive, Trash2, Loader2,
} from 'lucide-react';
import { MachineDropdown } from '@/components/layout/MachineDropdown';
import { ccrStatusPill, toneColor } from '@/lib/ccr-status';
import type { ApiFetch, CcrRow } from './ccrTypes';

const INITIAL_RECENTS = 20;
const WIDTH_KEY = 'ccr-sidebar-width';
const COLLAPSE_KEY = 'ccr-sidebar-collapsed';
const MIN_W = 200, MAX_W = 420, DEFAULT_W = 240;

type StatusFilter = 'all' | 'Working' | 'Needs input' | 'Review ready' | 'Completed' | 'Idle';
type EnvFilter = 'all' | 'cloud' | 'remote' | 'local';
type SortBy = 'recency' | 'name';

/**
 * claude.ai/code-style left sidebar for the full-bleed Code page: wordmark (back to the app),
 * Home|Code pills, Search, collapse + resize, New session, filterable/sortable Recents with a
 * per-row kebab (rename/archive/delete/copy/open), and the machine picker at the bottom.
 */
export function CcrSidebar({ rows, selectedId, onSelect, onNewSession, onRefresh, onOpenSearch, loading, apiFetch, onChanged }: {
  rows: CcrRow[];
  selectedId: string | null;
  onSelect: (row: CcrRow) => void;
  onNewSession: () => void;
  onRefresh: () => void;
  onOpenSearch: () => void;
  loading: boolean;
  apiFetch: ApiFetch;
  onChanged: () => void;
}) {
  const router = useRouter();
  // Home returns to the last non-CCR page the user was on (RouteTracker), not always /sessions.
  const goHome = useCallback(() => router.push(prevAppRoute()), [router]);
  const [showAll, setShowAll] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(DEFAULT_W);
  const [filterOpen, setFilterOpen] = useState(false);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [env, setEnv] = useState<EnvFilter>('all');
  const [sortBy, setSortBy] = useState<SortBy>('recency');
  const filterRef = useRef<HTMLDivElement>(null);

  // Restore persisted collapse + width.
  useEffect(() => {
    try {
      const w = Number(localStorage.getItem(WIDTH_KEY)); if (w >= MIN_W && w <= MAX_W) setWidth(w);
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch { /* ignore */ }
  }, []);
  const toggleCollapse = useCallback(() => setCollapsed((c) => { const n = !c; try { localStorage.setItem(COLLAPSE_KEY, n ? '1' : '0'); } catch { /* ignore */ } return n; }), []);

  // Drag-to-resize the right edge.
  const dragging = useRef(false);
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); dragging.current = true;
    const move = (ev: MouseEvent) => { if (!dragging.current) return; const w = Math.min(MAX_W, Math.max(MIN_W, ev.clientX)); setWidth(w); };
    const up = () => { dragging.current = false; document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.style.cursor = ''; try { localStorage.setItem(WIDTH_KEY, String(Math.round((filterRef.current ? width : width)))); } catch { /* ignore */ } };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); document.body.style.cursor = 'col-resize';
  }, [width]);
  // Persist the final width whenever it settles.
  useEffect(() => { const t = setTimeout(() => { try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* ignore */ } }, 300); return () => clearTimeout(t); }, [width]);

  // Close the filter popover on outside-click.
  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e: MouseEvent) => { if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false); };
    document.addEventListener('mousedown', onDown); return () => document.removeEventListener('mousedown', onDown);
  }, [filterOpen]);

  // Apply Recents filter + sort.
  const filtered = useMemo(() => {
    let r = rows;
    if (env !== 'all') r = r.filter((x) => x.kind === env);
    if (status !== 'all') r = r.filter((x) => ccrStatusPill(x.status).label === status);
    if (sortBy === 'name') r = [...r].sort((a, b) => a.title.localeCompare(b.title));
    return r;
  }, [rows, env, status, sortBy]);
  const recents = showAll ? filtered : filtered.slice(0, INITIAL_RECENTS);
  const hiddenCount = filtered.length - INITIAL_RECENTS;
  const activeFilters = (status !== 'all' ? 1 : 0) + (env !== 'all' ? 1 : 0) + (sortBy !== 'recency' ? 1 : 0);

  // Collapsed: a slim rail with expand + New session + Search.
  if (collapsed) {
    return (
      <div style={{ width: 48, flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '12px 0', borderRight: '1px solid var(--color-border-default)', background: 'var(--color-bg-elevated)' }}>
        <button onClick={toggleCollapse} title="Expand sidebar" style={railBtn}><PanelLeft size={16} /></button>
        <button onClick={onNewSession} title="New session" style={railBtn}><Plus size={16} /></button>
        <button onClick={onOpenSearch} title="Search (⌘K)" style={railBtn}><Search size={15} /></button>
        <button onClick={onRefresh} title="Refresh" disabled={loading} style={railBtn}><RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} /></button>
      </div>
    );
  }

  return (
    <div style={{ width, flexShrink: 0, height: '100%', position: 'relative', display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--color-border-default)', background: 'var(--color-bg-elevated)' }}>
      {/* Header: wordmark + collapse + search */}
      <div style={{ padding: '12px 12px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <button onClick={goHome} title="Back to lm-assist" style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', letterSpacing: -0.3, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>lm-assist</button>
        <button onClick={onOpenSearch} title="Search (⌘K)" style={iconBtn}><Search size={15} /></button>
        <button onClick={toggleCollapse} title="Collapse sidebar" style={iconBtn}><PanelLeftClose size={16} /></button>
      </div>

      {/* Home | Code segmented pill */}
      <div style={{ margin: '2px 10px 10px', display: 'flex', background: 'var(--color-bg-root)', borderRadius: 'var(--radius-lg)', padding: 3, gap: 2 }}>
        <button onClick={goHome} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '5px 0', borderRadius: 'var(--radius-md)', fontSize: 12.5, color: 'var(--color-text-tertiary)', background: 'none', border: 'none', cursor: 'pointer' }}><Home size={13} /> Home</button>
        <span style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '5px 0', borderRadius: 'var(--radius-md)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)' }}><Code2 size={13} /> Code</span>
      </div>

      <button onClick={onNewSession} style={{ margin: '0 10px', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 'var(--radius-md)', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', textAlign: 'left' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
        <Plus size={15} /> New session
      </button>

      {/* Recents header with Filter + Refresh */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '14px 12px 4px', gap: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>Recents</span>
        <span style={{ flex: 1 }} />
        <div ref={filterRef} style={{ position: 'relative' }}>
          <button onClick={() => setFilterOpen((v) => !v)} title="Filter & sort" style={{ ...iconBtn, color: activeFilters ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }}>
            <SlidersHorizontal size={13} />{activeFilters ? <span style={{ fontSize: 9, marginLeft: 1 }}>{activeFilters}</span> : null}
          </button>
          {filterOpen && (
            <div style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, minWidth: 180, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)', borderRadius: 'var(--radius-md)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)', zIndex: 60, padding: 6 }}>
              <FilterRow label="Status" value={status} opts={['all', 'Working', 'Needs input', 'Review ready', 'Completed', 'Idle']} onPick={(v) => setStatus(v as StatusFilter)} labelFor={(v) => v === 'all' ? 'All' : v} />
              <FilterRow label="Environment" value={env} opts={['all', 'cloud', 'remote', 'local']} onPick={(v) => setEnv(v as EnvFilter)} labelFor={(v) => v === 'all' ? 'All' : v[0].toUpperCase() + v.slice(1)} />
              <FilterRow label="Sort by" value={sortBy} opts={['recency', 'name']} onPick={(v) => setSortBy(v as SortBy)} labelFor={(v) => v === 'recency' ? 'Recency' : 'Name'} />
            </div>
          )}
        </div>
        <button onClick={onRefresh} title="Refresh" disabled={loading} style={iconBtn}><RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} /></button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 6px 6px' }}>
        {recents.map((row) => (
          <SidebarRow key={row.key} row={row} active={selectedId === row.id} onSelect={onSelect} apiFetch={apiFetch} onChanged={onChanged} />
        ))}
        {!showAll && hiddenCount > 0 && (
          <button onClick={() => setShowAll(true)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Show {hiddenCount} more</button>
        )}
        {filtered.length === 0 && !loading && <div style={{ padding: '6px 10px', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>No sessions in this view.</div>}
      </div>

      <div className="ccr-sidebar-machine" style={{ borderTop: '1px solid var(--color-border-default)', padding: '8px 10px' }}>
        <MachineDropdown />
      </div>

      {/* Resize handle on the right edge */}
      <div onMouseDown={onResizeStart} title="Drag to resize" style={{ position: 'absolute', top: 0, right: -3, width: 6, height: '100%', cursor: 'col-resize', zIndex: 5 }} />
    </div>
  );
}

const iconBtn: React.CSSProperties = { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', padding: 3, display: 'inline-flex', alignItems: 'center', borderRadius: 4 };
const railBtn: React.CSSProperties = { ...iconBtn, padding: 6 };

function FilterRow({ label, value, opts, onPick, labelFor }: { label: string; value: string; opts: string[]; onPick: (v: string) => void; labelFor: (v: string) => string }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.4, padding: '2px 6px' }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, padding: '0 4px' }}>
        {opts.map((o) => (
          <button key={o} onClick={() => onPick(o)} style={{ fontSize: 10.5, padding: '2px 7px', borderRadius: 'var(--radius-sm)', border: '1px solid ' + (o === value ? 'var(--color-accent)' : 'var(--color-border-subtle)'), background: o === value ? 'var(--color-accent-glow, transparent)' : 'transparent', color: o === value ? 'var(--color-accent)' : 'var(--color-text-secondary)', cursor: 'pointer' }}>{labelFor(o)}</button>
        ))}
      </div>
    </div>
  );
}

/** One Recents row: status dot + title, hover kebab (Open/Rename/Copy/Archive/Delete), inline rename. */
function SidebarRow({ row, active, onSelect, apiFetch, onChanged }: { row: CcrRow; active: boolean; onSelect: (row: CcrRow) => void; apiFetch: ApiFetch; onChanged: () => void }) {
  const [hover, setHover] = useState(false);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(row.title);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { tone } = ccrStatusPill(row.status);
  const canManage = row.kind === 'cloud' || (row.kind === 'remote' && /^(session_|cse_)/.test(row.id));

  useEffect(() => { setTitle(row.title); }, [row.title]);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) { setMenu(false); setConfirmDel(false); } };
    document.addEventListener('mousedown', onDown); return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);

  const call = useCallback(async (path: string, body?: unknown) => {
    setBusy(true);
    try { await apiFetch(path, { method: 'POST', body: body ?? {} }); onChanged(); return true; }
    catch { return false; } finally { setBusy(false); }
  }, [apiFetch, onChanged]);

  const saveRename = useCallback(async () => {
    const t = title.trim(); if (!t || t === row.title) { setRenaming(false); setTitle(row.title); return; }
    if (await call(`/ccr/cloud/${encodeURIComponent(row.id)}/rename`, { title: t })) setRenaming(false);
  }, [title, row.title, row.id, call]);

  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ position: 'relative' }}>
      {renaming ? (
        <input autoFocus className="input" value={title} onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') { setTitle(row.title); setRenaming(false); } }} onBlur={saveRename}
          style={{ width: '100%', fontSize: 12.5, margin: '1px 0' }} />
      ) : (
        <button onClick={() => onSelect(row)} title={row.statusDetail || row.title}
          style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '6px 10px', borderRadius: 'var(--radius-md)', border: 'none', cursor: 'pointer', fontSize: 12.5, background: active ? 'rgba(255,255,255,0.08)' : 'none', color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}
          onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }} onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'none'; }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: toneColor(tone), flexShrink: 0, opacity: tone === 'gray' ? 0.5 : 1 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{row.title}</span>
          {busy && <Loader2 size={11} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />}
          {row.unread && !hover && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--color-accent)', flexShrink: 0 }} />}
        </button>
      )}
      {/* hover kebab */}
      {(hover || menu) && !renaming && (
        <div ref={menuRef} style={{ position: 'absolute', top: 4, right: 4 }}>
          <button onClick={(e) => { e.stopPropagation(); setMenu((v) => !v); }} title="More options"
            style={{ border: 'none', background: 'var(--color-bg-elevated)', cursor: 'pointer', color: 'var(--color-text-tertiary)', padding: 2, borderRadius: 4, display: 'inline-flex' }}>
            <MoreVertical size={14} />
          </button>
          {menu && (
            <div style={{ position: 'absolute', top: 'calc(100% + 2px)', right: 0, minWidth: 160, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)', borderRadius: 'var(--radius-md)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)', zIndex: 70, padding: 4 }}>
              {row.webUrl && <MenuItem icon={ExternalLink} label="Open in claude.ai" onClick={() => { window.open(row.webUrl!, '_blank', 'noreferrer'); setMenu(false); }} />}
              {canManage && <MenuItem icon={Pencil} label="Rename" onClick={() => { setMenu(false); setRenaming(true); }} />}
              {row.webUrl && <MenuItem icon={copied ? Check : Copy} label={copied ? 'Copied' : 'Copy link'} onClick={() => { try { navigator.clipboard.writeText(row.webUrl!); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* blocked */ } setMenu(false); }} />}
              {canManage && <MenuItem icon={Archive} label="Archive" onClick={async () => { setMenu(false); await call(`/ccr/cloud/${encodeURIComponent(row.id)}/archive`, { archived: true }); }} />}
              {canManage && (confirmDel
                ? <div style={{ display: 'flex', gap: 4, padding: '2px 4px' }}><button className="btn btn-destructive btn-sm" style={{ flex: 1 }} onClick={async () => { setMenu(false); setConfirmDel(false); await call(`/ccr/cloud/${encodeURIComponent(row.id)}/stop`); }}>Delete</button><button className="btn btn-ghost btn-sm" onClick={() => setConfirmDel(false)}>✕</button></div>
                : <MenuItem icon={Trash2} label="Delete" danger onClick={() => setConfirmDel(true)} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: React.ComponentType<{ size?: number }>; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: danger ? 'var(--color-status-red)' : 'var(--color-text-secondary)' }}>
      <Icon size={13} /> {label}
    </button>
  );
}
