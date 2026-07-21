'use client';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useBacklogActions, useBacklogItem } from '@/hooks/useBacklog';
import {
  BACKLOG_EDGE_KINDS, BACKLOG_PRIORITIES, BACKLOG_STATUSES, BACKLOG_TYPES,
  EDGE_COLOR, STATUS_COLOR, TYPE_COLOR,
  type BacklogGraphEdge, type BacklogGraphNode,
} from '@/lib/backlog-types';

function rel(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const inputCls = 'w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100';
const btnCls = 'rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100';

export function BacklogNodeDetail({ nodeId, nodes, edges, onSelect, onClose, onChanged }: {
  nodeId: string | null;
  nodes: BacklogGraphNode[];
  edges: BacklogGraphEdge[];
  onSelect: (id: string | null) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const { item, loading, error } = useBacklogItem(nodeId, refreshKey);
  const actions = useBacklogActions();
  const [actErr, setActErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editTags, setEditTags] = useState('');
  const [note, setNote] = useState('');
  const [verdict, setVerdict] = useState('approve');
  const [reviewNote, setReviewNote] = useState('');
  const [linkTo, setLinkTo] = useState('');
  const [linkKind, setLinkKind] = useState('depends-on');

  useEffect(() => { setEditing(false); setActErr(null); setNote(''); setReviewNote(''); setLinkTo(''); }, [nodeId]);

  if (!nodeId) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setActErr(null);
    try {
      await fn();
      setRefreshKey((k) => k + 1);
      onChanged();
      return true;
    } catch (e) {
      setActErr((e as Error).message);
      return false;
    }
  };

  const inbound = edges.filter((e) => e.to === nodeId);
  const linkables = nodes.filter((n) => n.id !== nodeId);
  const typeColor = item ? (TYPE_COLOR[item.type] ?? '#6b7280') : '#6b7280';

  return (
    <div className="w-96 shrink-0 overflow-y-auto border-l border-neutral-800 p-4 text-sm">
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="font-semibold text-neutral-100">{item?.title ?? nodeId}</h3>
        <button onClick={onClose} className="shrink-0 text-neutral-500 hover:text-neutral-200">✕</button>
      </div>
      {loading && !item && <div className="text-xs text-neutral-500">Loading…</div>}
      {error && <div className="text-xs text-red-400">{error}</div>}
      {actErr && <div className="mb-2 rounded border border-red-800 bg-red-950/40 px-2 py-1 text-xs text-red-300">{actErr}</div>}

      {item && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 uppercase tracking-wide" style={{ color: typeColor }}>{item.type}</span>
            <select
              value={item.status}
              onChange={(e) => void run(() => actions.update(item.id, { status: e.target.value }))}
              className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-xs"
              style={{ color: STATUS_COLOR[item.status] ?? '#e5e5e5' }}
            >
              {BACKLOG_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select
              value={item.priority}
              onChange={(e) => void run(() => actions.update(item.id, { priority: e.target.value }))}
              className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-xs text-neutral-200"
            >
              {BACKLOG_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <span className="text-neutral-500">v{item.version}</span>
            {item.removed && <span className="rounded bg-red-900/40 px-1.5 py-0.5 text-red-300">removed</span>}
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-1 text-xs">
            {item.tags.map((t) => <span key={t} className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">{t}</span>)}
            <button className={btnCls} onClick={() => { setEditing((e) => !e); setEditTitle(item.title); setEditDesc(item.description); setEditTags(item.tags.join(', ')); }}>
              {editing ? 'Cancel' : 'Edit'}
            </button>
            {!item.removed
              ? <button className={btnCls} onClick={() => void run(() => actions.remove(item.id))}>Remove</button>
              : <button className={btnCls} onClick={() => void run(() => actions.remove(item.id, true))}>Restore</button>}
          </div>

          {editing ? (
            <div className="space-y-2">
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className={inputCls} placeholder="Title" />
              <select value={item.type} onChange={(e) => void run(() => actions.update(item.id, { type: e.target.value }))} className={inputCls}>
                {BACKLOG_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <textarea value={editDesc} onChange={(e) => setEditDesc(e.target.value)} rows={8} className={`${inputCls} font-mono`} placeholder="Description (markdown)" />
              <input value={editTags} onChange={(e) => setEditTags(e.target.value)} className={inputCls} placeholder="tags, comma, separated" />
              <button
                className={btnCls}
                onClick={() => void run(() => actions.update(item.id, {
                  title: editTitle,
                  description: editDesc,
                  tags: editTags.split(',').map((t) => t.trim()).filter(Boolean),
                })).then((okd) => { if (okd) setEditing(false); })}
              >Save</button>
            </div>
          ) : (
            <Section title="Description">
              {item.description
                ? <div className="prose prose-invert prose-sm max-w-none text-[13px] leading-relaxed [&_code]:text-amber-300 [&_a]:text-blue-400">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.description}</ReactMarkdown>
                  </div>
                : <div className="text-xs text-neutral-500">(no description)</div>}
            </Section>
          )}

          <Section title="Edges">
            <div className="space-y-1 text-xs">
              {item.edges.map((e, i) => (
                <div key={i} className="flex items-center gap-1">
                  <span style={{ color: EDGE_COLOR[e.kind] ?? '#94a3b8' }}>{e.kind}</span>
                  <Chip id={e.to} label={nodes.find((n) => n.id === e.to)?.title} onSelect={onSelect} />
                  <button className="text-neutral-600 hover:text-red-400" title="Unlink" onClick={() => void run(() => actions.unlink(item.id, e.to, e.kind))}>✕</button>
                </div>
              ))}
              {inbound.map((e, i) => (
                <div key={`in-${i}`} className="flex items-center gap-1 text-neutral-500">
                  <Chip id={e.from} label={nodes.find((n) => n.id === e.from)?.title} onSelect={onSelect} />
                  <span style={{ color: EDGE_COLOR[e.kind] ?? '#94a3b8' }}>{e.kind}</span>
                  <span>→ this</span>
                </div>
              ))}
              {item.edges.length === 0 && inbound.length === 0 && <div className="text-neutral-600">(none)</div>}
              <div className="mt-1 flex items-center gap-1">
                <select value={linkKind} onChange={(e) => setLinkKind(e.target.value)} className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-[11px]">
                  {BACKLOG_EDGE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
                <select value={linkTo} onChange={(e) => setLinkTo(e.target.value)} className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-[11px]">
                  <option value="">→ target…</option>
                  {linkables.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
                </select>
                <button className={btnCls} disabled={!linkTo} onClick={() => { if (linkTo) void run(() => actions.link(item.id, linkTo, linkKind)).then(() => setLinkTo('')); }}>Link</button>
              </div>
            </div>
          </Section>

          <Section title={`Discussion (${item.discussion.length})`}>
            <div className="space-y-2 text-xs">
              {item.discussion.slice(-8).map((d, i) => (
                <div key={i} className="rounded border border-neutral-800 bg-neutral-900/60 p-1.5">
                  <div className="mb-0.5 flex items-center gap-1 text-[10px] text-neutral-500">
                    <span className="rounded bg-neutral-800 px-1">{d.sessionKind}</span>
                    <span className="truncate" title={d.sessionId}>{d.label ?? d.sessionId.slice(0, 18)}</span>
                    <span className="ml-auto shrink-0">{rel(d.at)}</span>
                  </div>
                  <div className="whitespace-pre-wrap text-neutral-300">{d.note}</div>
                </div>
              ))}
              <div className="flex items-center gap-1">
                <input value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} placeholder="Add a note…"
                  onKeyDown={(e) => { if (e.key === 'Enter' && note.trim()) void run(() => actions.discuss(item.id, note.trim())).then(() => setNote('')); }} />
                <button className={btnCls} disabled={!note.trim()} onClick={() => void run(() => actions.discuss(item.id, note.trim())).then(() => setNote(''))}>Add</button>
              </div>
            </div>
          </Section>

          <Section title={`Reviews (${item.reviews.length})`}>
            <div className="space-y-1 text-xs">
              {item.reviews.slice(-6).map((r, i) => (
                <div key={i} className="flex items-start gap-1">
                  <span className={r.verdict === 'approve' ? 'text-emerald-400' : r.verdict === 'reject' ? 'text-red-400' : 'text-amber-400'}>{r.verdict}</span>
                  <span className="truncate text-neutral-500" title={r.by}>by {r.by.slice(0, 20)}</span>
                  {r.note && <span className="text-neutral-400">— {r.note}</span>}
                  <span className="ml-auto shrink-0 text-[10px] text-neutral-600">{rel(r.at)}</span>
                </div>
              ))}
              <div className="flex items-center gap-1">
                <select value={verdict} onChange={(e) => setVerdict(e.target.value)} className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-[11px]">
                  {['approve', 'concerns', 'reject'].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <input value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} className={inputCls} placeholder="Review note…" />
                <button className={btnCls} onClick={() => void run(() => actions.review(item.id, verdict, reviewNote.trim() || undefined)).then(() => setReviewNote(''))}>Add</button>
              </div>
            </div>
          </Section>

          <Section title="Version history">
            <div className="space-y-1 text-[11px] text-neutral-400">
              {[...(item.history ?? [])].reverse().map((h) => (
                <div key={h.rev} className="flex items-center gap-1">
                  <span className="font-mono">r{h.rev}</span>
                  <span>· {h.actor?.label ?? h.actor?.id ?? h.actor?.kind ?? 'unknown'}</span>
                  <span>· {rel(h.at)}</span>
                  <span className="truncate text-neutral-500">· {Object.keys(h.changes ?? {}).join(', ')}</span>
                  {h.rev !== item.rev && (
                    <button className="ml-auto shrink-0 text-blue-400 hover:underline" onClick={() => void run(() => actions.rollback(item.id, h.rev))}>revert</button>
                  )}
                </div>
              ))}
            </div>
          </Section>

          <div className="mt-3 text-[10px] text-neutral-600">
            {item.id} · created {rel(item.createdAt)} · updated {rel(item.updatedAt)}
          </div>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 border-t border-neutral-800 pt-2">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">{title}</div>
      {children}
    </div>
  );
}

function Chip({ id, label, onSelect }: { id: string; label?: string; onSelect: (id: string | null) => void }) {
  return (
    <button onClick={() => onSelect(id)} className="max-w-[160px] truncate rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-blue-300 hover:border-blue-400 hover:text-blue-200" title={id}>
      {label ?? id}
    </button>
  );
}
