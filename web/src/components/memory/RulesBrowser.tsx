'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, X, RefreshCw } from 'lucide-react';
import type { CallFn, RuleListEntry, EditTarget } from './types';
import { errText, ConfirmButton } from './format';

export function RulesBrowser({ call, onEdit, refreshTick }: { call: CallFn; onEdit?: (t: EditTarget) => void; refreshTick?: number }) {
  const [rules, setRules] = useState<RuleListEntry[]>([]);
  const [selected, setSelected] = useState<RuleListEntry | null>(null);
  const [content, setContent] = useState<{ content: string; hash?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(() => {
    call<{ rules: RuleListEntry[] }>('/rules/list')
      .then((r) => {
        const list = r.rules || [];
        setRules(list);
        setSelected((prev) => prev && (list.find((x) => x.filename === prev.filename && x.source === prev.source) ?? null));
      })
      .catch((e) => setError(errText(e)));
  }, [call]);
  useEffect(() => { load(); }, [load, refreshTick]);

  const filteredRules = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return rules;
    return rules.filter((r) => r.filename.toLowerCase().includes(needle) || (r.title || '').toLowerCase().includes(needle));
  }, [rules, filter]);
  const activeCount = useMemo(() => rules.filter((r) => r.active).length, [rules]);

  useEffect(() => {
    let alive = true;
    setContent(null);            // eager clear: never show old rule's body under new header
    setError(null);
    if (!selected) return () => { alive = false; };
    call<{ content: string; hash?: string }>(
      `/rules/file/${encodeURIComponent(selected.filename)}?source=${encodeURIComponent(selected.source)}`)
      .then((r) => { if (alive) setContent(r); })
      .catch((e) => { if (alive) setError(errText(e)); });
    return () => { alive = false; };
  }, [call, selected, refreshTick]);

  // Escape closes the detail pane, but the file-editor overlay (a modal
  // above this pane) wins if it's open — its own Escape handler owns the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !selected) return;
      if (document.querySelector('[data-file-editor]')) return;
      setSelected(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected]);

  const remove = async (r: RuleListEntry) => {
    try {
      await call(`/rules/file/${encodeURIComponent(r.filename)}?expectedHash=${content?.hash || ''}`, { method: 'DELETE' });
      setSelected(null); load();
    } catch (e) { setError(errText(e)); }
  };

  const isSel = (r: RuleListEntry) => selected?.filename === r.filename && selected?.source === r.source;

  return (
    <div className="h-full min-h-0 flex gap-4 text-sm">
      <div className="flex-1 min-w-0 flex flex-col min-h-0 gap-2">
        {/* Toolbar row — same rhythm as MemoryBrowser's search row: input flex-1 + refresh + New */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && filter) { e.stopPropagation(); setFilter(''); } }}
              placeholder="Filter rules…"
              className="w-full bg-gray-900 border border-gray-700 rounded pl-7 pr-7 py-1 text-gray-200" />
            {filter && (
              <button type="button" onClick={() => setFilter('')} aria-label="Clear filter"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                <X size={14} />
              </button>
            )}
          </div>
          <button type="button" onClick={() => load()} aria-label="Refresh"
            className="px-2 py-1 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600">
            <RefreshCw size={14} />
          </button>
          {onEdit && (
            <button onClick={() => onEdit({ kind: 'rule', filename: '', content: '# New rule\n\n' })}
              className="px-2 py-1 rounded bg-emerald-800 text-emerald-100 hover:bg-emerald-700 text-xs whitespace-nowrap">+ New rule</button>
          )}
        </div>
        <div className="text-[10px] text-gray-500">
          {filter.trim() ? `${filteredRules.length}/${rules.length} rules · ${activeCount} active` : `${rules.length} rules · ${activeCount} active`}
          {' · '}own rules (<code>~/.claude/rules</code>) are editable; <code>synced.*</code> and mirrors converge from their origin node
        </div>
        {error && <div className="text-rose-400 text-xs">{error}</div>}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="divide-y divide-gray-800 border border-gray-800 rounded">
            {filteredRules.map((r) => (
              <button key={`${r.source}:${r.filename}`} onClick={() => setSelected(r)}
                className={`w-full text-left px-3 py-2 hover:bg-gray-900 flex items-center gap-2 focus-visible:ring-1 focus-visible:ring-gray-500 outline-none ${isSel(r) ? 'bg-gray-900' : ''}`}>
                <span className="text-gray-200 truncate flex-1" title={r.filename}>{r.title || r.filename}</span>
                {r.os.length > 0 && <span title={"applies on: " + r.os.join(',')} className="px-1.5 py-0.5 rounded text-[10px] bg-gray-700 text-gray-300">{r.os.join(',')}</span>}
                <span title={r.active ? 'active on this node' : 'inert here (os-scoped or mirror)'} className={`px-1.5 py-0.5 rounded text-[10px] ${r.active ? 'bg-emerald-900 text-emerald-200' : 'bg-gray-700 text-gray-400'}`}>
                  {r.active ? 'active' : 'inert'}
                </span>
                {r.syncedFrom && <span className="text-gray-500 text-xs">from {r.syncedFrom}</span>}
                {r.source.startsWith('mirror:') && <span className="text-gray-600 text-[10px]">mirror</span>}
              </button>
            ))}
            {rules.length === 0 && <div className="px-3 py-4 text-gray-500">No rules found.</div>}
            {rules.length > 0 && filteredRules.length === 0 && <div className="px-3 py-4 text-gray-500">No rules match &quot;{filter}&quot;.</div>}
          </div>
        </div>
      </div>

      {selected && content && (
        <div className="basis-[36rem] min-w-[20rem] max-w-[36rem] shrink border border-gray-800 rounded bg-gray-950 h-full flex flex-col">
          <div className="flex items-center gap-2 p-3 pb-0">
            <span className="text-gray-100 font-medium truncate flex-1" title={selected.filename}>{selected.filename}</span>
            {onEdit && selected.editable && (
              <button onClick={() => onEdit({ kind: 'rule', filename: selected.filename, content: content.content, hash: content.hash })}
                className="px-2 py-0.5 rounded bg-emerald-800 text-emerald-100 hover:bg-emerald-700 text-xs">Edit</button>
            )}
            {selected.editable && (
              <ConfirmButton label="Delete" confirmLabel="Confirm delete" onConfirm={() => remove(selected)} />
            )}
            {!selected.editable && <span className="text-gray-500 text-[10px]">read-only — edit at origin ({selected.syncedFrom || 'mirror'})</span>}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-3">
            <pre className="text-xs text-gray-300 bg-gray-900 rounded p-2 overflow-x-auto whitespace-pre-wrap">{content.content}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
