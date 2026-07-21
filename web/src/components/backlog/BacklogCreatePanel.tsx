'use client';
import { useState } from 'react';
import { useBacklogActions } from '@/hooks/useBacklog';
import { BACKLOG_PRIORITIES, BACKLOG_TYPES } from '@/lib/backlog-types';

const inputCls = 'w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100';

export function BacklogCreatePanel({ onCreated }: { onCreated: (id: string) => void }) {
  const actions = useBacklogActions();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [type, setType] = useState('idea');
  const [priority, setPriority] = useState('med');
  const [tags, setTags] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    if (!title.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await actions.create({
        title: title.trim(),
        type,
        priority,
        ...(description.trim() ? { description: description.trim() } : {}),
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      setTitle(''); setDescription(''); setTags(''); setOpen(false);
      onCreated(r.item.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-neutral-800 p-3">
      <button onClick={() => setOpen((o) => !o)} className="w-full rounded border border-neutral-700 px-2 py-1 text-xs font-semibold text-neutral-200 hover:border-neutral-500">
        {open ? '− Cancel' : '+ New item'}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {err && <div className="rounded border border-red-800 bg-red-950/40 px-2 py-1 text-[11px] text-red-300">{err}</div>}
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} placeholder="Title *" autoFocus />
          <div className="flex gap-1">
            <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls}>
              {BACKLOG_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={priority} onChange={(e) => setPriority(e.target.value)} className={inputCls}>
              {BACKLOG_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <input value={tags} onChange={(e) => setTags(e.target.value)} className={inputCls} placeholder="tags, comma, separated" />
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className={`${inputCls} font-mono`} placeholder="Description (markdown)" />
          <button onClick={() => void create()} disabled={!title.trim() || busy} className="w-full rounded bg-blue-600 px-2 py-1 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50">
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      )}
    </div>
  );
}
