'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Cloud, Cast, Monitor, MoreVertical, ExternalLink, Copy, Check, Pencil, Archive, Trash2, X, Loader2 } from 'lucide-react';
import type { ApiFetch, CcrRow } from './ccrTypes';

/** claude.ai/code-style session-detail header: icon + title (inline rename) + repo chip + kebab. */
export function CcrDetailHeader({ row, apiFetch, onClose, onChanged, onDeleted }: {
  row: CcrRow;
  apiFetch: ApiFetch;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(row.title);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setTitle(row.title); setRenaming(false); setConfirmDelete(false); }, [row.id, row.title]);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);

  // Cloud + bridged remote sessions expose management endpoints; a purely-local (unbridged) session doesn't.
  const canManage = row.kind === 'cloud' || (row.kind === 'remote' && /^(session_|cse_)/.test(row.id));
  const Icon = row.kind === 'cloud' ? Cloud : row.kind === 'remote' ? Cast : Monitor;

  const call = useCallback(async (path: string, body?: unknown) => {
    setBusy(true); setErr(null);
    try { await apiFetch(path, { method: 'POST', body: body ?? {} }); return true; }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); return false; }
    finally { setBusy(false); }
  }, [apiFetch]);

  const saveRename = useCallback(async () => {
    const t = title.trim();
    if (!t || t === row.title) { setRenaming(false); return; }
    if (await call(`/ccr/cloud/${encodeURIComponent(row.id)}/rename`, { title: t })) { setRenaming(false); onChanged(); }
  }, [title, row.title, row.id, call, onChanged]);

  const archive = useCallback(async () => { setMenu(false); if (await call(`/ccr/cloud/${encodeURIComponent(row.id)}/archive`, { archived: true })) onChanged(); }, [row.id, call, onChanged]);
  const del = useCallback(async () => { if (await call(`/ccr/cloud/${encodeURIComponent(row.id)}/stop`)) { setMenu(false); onDeleted(); } }, [row.id, call, onDeleted]);
  const copyLink = useCallback(async () => {
    if (!row.webUrl) return;
    try { await navigator.clipboard.writeText(row.webUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* blocked */ }
    setMenu(false);
  }, [row.webUrl]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--color-border-default)', position: 'relative' }}>
      <Icon size={15} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
      {renaming ? (
        <input autoFocus className="input" value={title} onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') { setTitle(row.title); setRenaming(false); } }}
          onBlur={saveRename} style={{ fontSize: 14, fontWeight: 600, flex: 1, minWidth: 0 }} />
      ) : (
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.title}</span>
      )}
      {row.repo && <span className="badge badge-outline" style={{ flexShrink: 0 }} title={row.branch ? `${row.repo} · ${row.branch}` : row.repo}>{row.repo.split('/').pop()}</span>}
      {busy && <Loader2 size={13} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-text-tertiary)' }} />}
      <div style={{ flex: 1 }} />
      {err && <span style={{ fontSize: 11, color: 'var(--color-status-red)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={err}>{err}</span>}

      {row.webUrl && (
        <a className="btn btn-ghost btn-sm" href={row.webUrl} target="_blank" rel="noreferrer" title="Open on claude.ai/code"><ExternalLink size={14} /></a>
      )}
      {canManage && (
        <div ref={menuRef} style={{ position: 'relative' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setMenu((v) => !v)} title="More"><MoreVertical size={15} /></button>
          {menu && (
            <div style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, minWidth: 180, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)', borderRadius: 'var(--radius-md)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)', zIndex: 70, padding: 4 }}>
              <MenuItem icon={Pencil} label="Rename" onClick={() => { setMenu(false); setRenaming(true); }} />
              {row.webUrl && <MenuItem icon={copied ? Check : Copy} label={copied ? 'Copied' : 'Copy link'} onClick={copyLink} />}
              <MenuItem icon={Archive} label="Archive" onClick={archive} />
              <div style={{ height: 1, background: 'var(--color-border-default)', margin: '4px 0' }} />
              {confirmDelete ? (
                <div style={{ display: 'flex', gap: 4, padding: '2px 4px' }}>
                  <button className="btn btn-destructive btn-sm" style={{ flex: 1 }} onClick={del}>Confirm delete</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>Cancel</button>
                </div>
              ) : (
                <MenuItem icon={Trash2} label="Delete" danger onClick={() => setConfirmDelete(true)} />
              )}
            </div>
          )}
        </div>
      )}
      <button className="btn btn-ghost btn-sm" onClick={onClose} title="Close"><X size={15} /></button>
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: React.ComponentType<{ size?: number }>; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12.5, color: danger ? 'var(--color-status-red)' : 'var(--color-text-secondary)' }}>
      <Icon size={14} /> {label}
    </button>
  );
}
