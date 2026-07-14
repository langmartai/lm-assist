'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CallFn, RuleListEntry, EditTarget } from './types';

export function RulesBrowser({ call, onEdit, refreshTick }: { call: CallFn; onEdit?: (t: EditTarget) => void; refreshTick?: number }) {
  const [rules, setRules] = useState<RuleListEntry[]>([]);
  const [selected, setSelected] = useState<RuleListEntry | null>(null);
  const [content, setContent] = useState<{ content: string; hash?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    call<{ rules: RuleListEntry[] }>('/rules/list')
      .then((r) => {
        const list = r.rules || [];
        setRules(list);
        setSelected((prev) => prev && (list.find((x) => x.filename === prev.filename && x.source === prev.source) ?? null));
      })
      .catch((e) => setError(String(e)));
  }, [call]);
  useEffect(() => { load(); }, [load, refreshTick]);

  useEffect(() => {
    let alive = true;
    setContent(null);            // eager clear: never show old rule's body under new header
    setError(null);
    if (!selected) return () => { alive = false; };
    call<{ content: string; hash?: string }>(
      `/rules/file/${encodeURIComponent(selected.filename)}?source=${encodeURIComponent(selected.source)}`)
      .then((r) => { if (alive) setContent(r); })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [call, selected, refreshTick]);

  const remove = async (r: RuleListEntry) => {
    if (!window.confirm(`Delete rule ${r.filename}?`)) return;
    try {
      await call(`/rules/file/${encodeURIComponent(r.filename)}?expectedHash=${content?.hash || ''}`, { method: 'DELETE' });
      setSelected(null); load();
    } catch (e) { setError(String(e)); }
  };

  const isSel = (r: RuleListEntry) => selected?.filename === r.filename && selected?.source === r.source;

  return (
    <div className="h-full min-h-0 flex gap-4 text-sm">
      <div className="flex-1 min-w-0 flex flex-col min-h-0 gap-2">
        <div className="flex justify-between items-center">
          <div className="text-gray-400 text-xs">
            User rules (<code>~/.claude/rules</code>) — own rules are editable; <code>synced.*</code> and mirrors converge from their origin node.
          </div>
          {onEdit && (
            <button onClick={() => onEdit({ kind: 'rule', filename: '', content: '# New rule\n\n' })}
              className="px-2 py-1 rounded bg-emerald-800 text-emerald-100 hover:bg-emerald-700 text-xs">+ New rule</button>
          )}
        </div>
        {error && <div className="text-rose-400 text-xs">{error}</div>}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="divide-y divide-gray-800 border border-gray-800 rounded">
            {rules.map((r) => (
              <button key={`${r.source}:${r.filename}`} onClick={() => setSelected(r)}
                className={`w-full text-left px-3 py-2 hover:bg-gray-900 flex items-center gap-2 ${isSel(r) ? 'bg-gray-900' : ''}`}>
                <span className="text-gray-200 truncate flex-1">{r.title || r.filename}</span>
                {r.os.length > 0 && <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-700 text-gray-300">{r.os.join(',')}</span>}
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${r.active ? 'bg-emerald-900 text-emerald-200' : 'bg-gray-700 text-gray-400'}`}>
                  {r.active ? 'active' : 'inert'}
                </span>
                {r.syncedFrom && <span className="text-gray-500 text-xs">from {r.syncedFrom}</span>}
                {r.source.startsWith('mirror:') && <span className="text-gray-600 text-[10px]">mirror</span>}
              </button>
            ))}
            {rules.length === 0 && <div className="px-3 py-4 text-gray-500">No rules found.</div>}
          </div>
        </div>
      </div>

      {selected && content && (
        <div className="w-[36rem] shrink-0 border border-gray-800 rounded bg-gray-950 h-full flex flex-col">
          <div className="flex items-center gap-2 p-3 pb-0">
            <span className="text-gray-100 font-medium truncate flex-1">{selected.filename}</span>
            {onEdit && selected.editable && (
              <button onClick={() => onEdit({ kind: 'rule', filename: selected.filename, content: content.content, hash: content.hash })}
                className="px-2 py-0.5 rounded bg-emerald-800 text-emerald-100 hover:bg-emerald-700 text-xs">Edit</button>
            )}
            {selected.editable && (
              <button onClick={() => void remove(selected)}
                className="px-2 py-0.5 rounded bg-rose-900 text-rose-100 hover:bg-rose-800 text-xs">Delete</button>
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
